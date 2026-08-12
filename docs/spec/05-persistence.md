# 05 — 持久化与 Excel 互通

`cube3-io` 是唯一依赖文件 IO 的 crate。`cube3-core` 不得依赖它,也不得依赖 `serde` 之外的
任何 IO 相关 crate。

```
crates/cube3-io/src/
  lib.rs
  native.rs        // .c3 存档
  xlsx_import.rs   // calamine
  xlsx_export.rs   // rust_xlsxwriter
  translate.rs     // 公式双向翻译(两个方向共用的映射逻辑)
  csv.rs
  error.rs         // IoError
```

公开 API:

```rust
pub fn save_c3(wb: &Workbook, path: &Path) -> Result<(), IoError>;
pub fn load_c3(path: &Path) -> Result<Workbook, IoError>;
pub fn import_xlsx(path: &Path) -> Result<ImportReport, IoError>;
pub fn export_xlsx(wb: &Workbook, path: &Path) -> Result<ExportReport, IoError>;
pub fn import_csv(wb: &mut Workbook, path: &Path, layer_name: &str) -> Result<LayerId, IoError>;
pub fn export_csv(wb: &Workbook, layer: LayerId, path: &Path) -> Result<(), IoError>;
```

导入导出都返回**报告**而非裸结果,因为翻译过程必然有降级,用户需要知道降了什么:

```rust
pub struct ImportReport {
    pub workbook: Workbook,
    /// 被重命名的 sheet:(原名, 新层名, 原因)
    pub renamed_layers: Vec<(String, String, &'static str)>,
    /// 无法翻译、按 foreign 保留的公式格数量与样例
    pub foreign_formulas: usize,
    pub foreign_samples: Vec<(Addr, String)>,   // 最多保留 20 条
}

pub struct ExportReport {
    /// 被截断/改名的层
    pub renamed_sheets: Vec<(String, String)>,
    /// 降级为静态值的公式:(地址, 原公式, 原因)
    pub devalued_formulas: Vec<(Addr, String, &'static str)>,
}
```

---

## 5.1 `.c3` 存档格式

单个 JSON 文件(`serde_json`,pretty 输出)。选 JSON 而非二进制的理由:**可以 git diff、
可以肉眼排查、golden 测试好写**。体积不是 MVP 的约束。

```jsonc
{
  "format": "cube3",
  "version": 1,
  "next_layer_id": 13,
  "styles": [
    { "number_format": "General",              "align": "Auto",  "bold": false },
    { "number_format": { "Fixed": 2 },         "align": "Right", "bold": false },
    { "number_format": { "Percent": 1 },       "align": "Auto",  "bold": true  }
  ],
  "layers": [
    {
      "id": 1,
      "name": "2024-01",
      "hidden": false,
      "cells": [
        { "r": 0, "c": 0, "input": "营业收入", "style": 2 },
        { "r": 0, "c": 1, "input": "12345.6" },
        { "r": 1, "c": 1, "input": "=SUM(B1:B10)" },
        { "r": 2, "c": 1, "input": "=XLOOKUP(A1,C:C,D:D)", "foreign": true, "cached": { "Number": 42.0 } }
      ]
    }
  ]
}
```

规则:

- `style` 省略即 `0`(默认样式);`hidden` 省略即 `false`;`foreign` 省略即 `false`
- **不存储计算值** —— 加载后调用 `recalc_all()` 重算。唯一例外是 `foreign: true` 的格,
  它无法重算,必须存 `cached`
- `cells` 数组按 `(r, c)` 升序写出,保证同一工作簿两次保存的字节完全一致(golden 测试依赖这点)
- `version` 不匹配时返回 `IoError::UnsupportedVersion`,不做静默降级

### `input` 字段的往返保证

`input` 存的是 `Workbook::input_text(addr)` 的输出。因此有一条**硬性要求**:

> 对任意单元格,`set_input(addr, input_text(addr))` 必须重建出等价的单元格。

这条要求约束了 `input_text` 的实现:一个内容为 `"=1+1"` 的**文本**单元格,`input_text`
必须返回 `'=1+1`(带前导单引号),否则重新加载时会被当成公式。同理,内容为 `"TRUE"` 或
`"0123"` 的文本格也要加单引号。判据很简单:**若把字面文本直接喂给 `set_input` 会得到
非 `Text` 的结果,就加前导单引号**。

必须有测试 `input_text_roundtrip` 覆盖这几种边界文本:`=1+1`、`TRUE`、`0123`、`'已经带引号`、
`#N/A`、空串。

### 加载流程

1. 反序列化 JSON
2. 建层(按数组顺序,沿用存档中的 `id` 与 `next_layer_id`)
3. 逐格 `set_input` —— **但要跳过重算**(否则 O(n) 次增量重算)。为此内部提供
   `set_input_deferred(addr, input)`,只解析与写入、不触发 `flush_recalc`
4. 全部写完后调用一次 `recalc_all()`

`set_input_deferred` 是私有的,不在 `Workbook` 的公开 API 里;`cube3-io` 通过一个
`pub(crate)` 之外的受控入口访问它 —— 具体做法:在 `Workbook` 上提供公开的批量构建器
`WorkbookBuilder`,`cube3-io` 用它。避免为 IO 开放一个容易被误用的公开方法。

### 加载时的公式解析失败

存档被手工改坏或来自更高版本时,某条公式可能解析不了。此时**不要整体失败** ——
把该格写成 `foreign: true` 且 `cached = Error(Parse)`,记入报告,继续加载其余部分。
数据不完整比数据打不开好。

---

## 5.2 层 ↔ Worksheet 的映射

一个层对应一个 worksheet,顺序一一对应。

### 导入方向:sheet 名 → 层名

Excel 的 sheet 名规则比 cube3 的层名规则宽松,必须清洗
(规则见 [02](02-data-model.md#层名规则)):

| 情况 | 处理 | 记入 `renamed_layers` |
|---|---|---|
| 含 `! : * [ ] # $ ' " / \ ?` | 逐字符替换为 `_` | 是 |
| 长度 > 64 | 截断到 64 | 是 |
| 形如单元格地址(`A1`、`XFD100`) | 追加 `_` | 是 |
| 等于保留字 `L` | 追加 `_` | 是 |
| 清洗后与已有层名冲突(不分大小写) | 追加 `_2`、`_3`… | 是 |
| 空名 | 用 `Sheet<n>` | 是 |

**改名会破坏公式中的层引用**,所以清洗必须**先对全部 sheet 名做完**,得到一张
`原名 -> 新名` 映射表,再用它翻译所有公式。不能边导边改。

### 导出方向:层名 → sheet 名

Excel 的限制更严:长度 ≤ 31,不含 `[ ] : * ? / \`,不能以单引号开头或结尾。

| 情况 | 处理 |
|---|---|
| 长度 > 31 | 截断到 28 + `~n`(n 为序号),保证唯一 |
| 含非法字符 | 替换为 `_` |
| 冲突 | 追加 `~2`、`~3`… |

同样先建映射表再翻译公式。

---

## 5.3 公式导入翻译规则

对每个从 calamine 读到的公式文本,按顺序尝试:

1. **层名替换。** 用 5.2 的映射表把公式中出现的 sheet 名替换为层名。
   注意只替换出现在 `!` 之前的标识符,不要误伤字符串字面量与函数名 ——
   最稳妥的做法是**先用 cube3 的解析器解析,在 AST 上替换 `LayerSel::Named`**,而不是文本替换。
2. **解析。** 用 `parse_formula` 解析。Excel 的 3D 引用 `Sheet1:Sheet3!A1` 与 cube3 的层区间
   语法**形式完全相同**,无需转换即可解析通过 —— 这是当初选择这个语法的原因之一。
3. **函数名检查。** 遍历 AST 中所有 `Expr::Call`,若全部函数名都能被 `lookup_function` 找到
   ⇒ 原生公式,`foreign = false`。
4. 上述任一步失败(解析失败、或存在未知函数)⇒ **`foreign = true`**:
   - `Formula::src` 保留(层名替换后的)原文
   - `Cell::value` 用 calamine 读到的**缓存值**
   - 计入 `ImportReport::foreign_formulas`

`foreign` 格在重算时被**跳过**(引擎见到 `foreign == true` 直接保留 `cell.value`),
导出时把 `src` 原样写回。**这保证了「导入 → 编辑别处 → 导出」不丢失任何公式。**

Excel 特有的以下构造一律走 foreign 路径,不要尝试翻译:
数组公式 `{...}`、结构化引用 `Table1[列名]`、定义名称、`_xlfn.` 前缀函数、跨工作簿引用 `[1]Sheet1!A1`。

### 值的导入

calamine 的单元格数据类型映射:

| calamine | `Value` |
|---|---|
| 空 | `Empty` |
| 浮点/整数 | `Number` |
| 字符串 | `Text` |
| 布尔 | `Bool` |
| 错误 | `Error`,按错误名映射;无法识别的映射为 `Error(Value)` |
| 日期/时间 | **`Number`(保留 Excel 序列值)** + 该格样式设为 `NumberFormat::General` |

日期按数字导入是 MVP 的已知取舍(见 [03 D9](03-formula-language.md#37-与-excel-的差异汇总))。
不要试图引入日期类型 —— 那会牵出一整套日期函数与格式化。

---

## 5.4 公式导出翻译规则

导出的目标是:**在 Excel 里打开后,尽可能还是活的公式;实在不行也不能显示成错误。**

对每个原生公式,在**它所在的具体层**上翻译 AST(层已知,所以相对层引用可以展开):

| cube3 构造 | Excel 输出 | 备注 |
|---|---|---|
| `B2`(省略层) | `B2` | 直接 |
| `Sales!B2` | `Sales!B2` / `'My Sheet'!B2` | 用 5.2 的 sheet 名映射;含空格或特殊字符时加单引号 |
| `#3!B2` | 第 3 层的 sheet 名 + `!B2` | 层序已知,可展开 |
| `L[-1]!B2` | **展开为具体 sheet 名** | 在第 k 层导出时即第 k-1 层的名字。无损 |
| `L[-2]:L[0]!B2` | `'Jan:Mar'!B2` 形式的 3D 引用 | 裁剪后的层一定连续,可无损表达 |
| `*!B2` | `First:Last!B2` | 同上 |
| `LAYERSUM(R)` | `SUM(First:Last!R)` | 先在 AST 上改写成 `SUM(*!R)` 再走上一行 |
| `LAYERAVG` / `LAYERCOUNT` | 同理 → `AVERAGE` / `COUNT` | |
| `PREV(R)` | 展开为具体 sheet 引用 | |
| `DELTA(R)` | `R - 'Prev'!R` | 展开成减法 |
| `LAYERIDX()` | **静态数字** | 无对应物 |
| `LAYERNAME()` | **静态文本** | 无对应物 |
| `#CIRC!` / `#PARSE!` / `#UNSUP!` | 静态值降级 | Excel 无这些错误值 |

Excel 3D 引用的引号写法:整体加引号,`'Jan 2024:Mar 2024'!B2`,**不是**分别加引号。

### 降级规则

若翻译过程中遇到无法表达的构造(上表最后三行,或 3D 引用出现在不支持 3D 的函数里),
该公式**整体降级**:

1. 写入该格当前的**计算值**(静态)
2. 用单元格批注写入原始 cube3 公式,内容形如 `cube3 原公式:=DELTA(B5)/LAYERIDX()`
3. 记入 `ExportReport::devalued_formulas`

**批注是这条规则的关键** —— 它让"导出给同事看 → 同事改了几个数 → 导回 cube3"这条链路
至少能人工恢复。

### Excel 支持 3D 引用的函数白名单

只有这些函数的参数位置可以放 3D 引用,其余情况必须展开或降级:

```
SUM  AVERAGE  AVERAGEA  COUNT  COUNTA  MAX  MAXA  MIN  MINA
PRODUCT  STDEV  STDEVA  STDEVP  STDEVPA  VAR  VARA  VARP  VARPA
```

在 `translate.rs` 里定义为一个常量数组,导出时查表。

### 值与样式的导出

- 字面量格直接写值
- `foreign` 格写 `src` 原文(它本来就是 Excel 语法)
- 样式映射:`NumberFormat` → Excel 数字格式串(`General` / `0.00` / `#,##0.00` / `0.0%` /
  `"¥"#,##0.00` / `@`);`Align` → 水平对齐;`bold` → 粗体
- 若所用 `rust_xlsxwriter` 版本支持写入公式的缓存结果,一并写入 —— 否则 LibreOffice 打开时
  公式格会先显示 0,直到手动重算

---

## 5.5 CSV

最小实现,不做方言探测:

- **导入**:UTF-8,逗号分隔,`"` 包裹与 `""` 转义。整个文件成为**一个新层**,
  每个字段按 [02 §2.3 的输入解释规则](02-data-model.md#用户输入的解释规则) 处理 ——
  也就是说 CSV 里的 `=SUM(A1:A2)` 会成为公式。这是刻意的,方便手写测试数据
- **导出**:导出**单个层**;公式格导出其计算值,不导出公式

---

## 5.6 错误类型

```rust
#[derive(Debug, thiserror::Error)]
pub enum IoError {
    #[error("读写文件失败:{0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 解析失败:{0}")]
    Json(#[from] serde_json::Error),
    #[error("不支持的存档版本 {0},本程序支持 {1}")]
    UnsupportedVersion(u32, u32),
    #[error("不是 cube3 存档文件")]
    NotC3,
    #[error("读取 xlsx 失败:{0}")]
    Xlsx(String),
    #[error("工作簿模型错误:{0}")]
    Model(#[from] ModelError),
}
```

`calamine` 与 `rust_xlsxwriter` 的错误统一用 `IoError::Xlsx(String)` 包裹 ——
不要在公开 API 里暴露第三方错误类型,那会让 crate 升级变成破坏性变更。

---

## 5.7 验收要点

M6/M7 的验收测试见 [08-acceptance-tests.md](08-acceptance-tests.md)。必测项:

- `c3_roundtrip_preserves_everything`(层、公式、样式、隐藏标记)
- `c3_save_is_byte_stable`(同一工作簿保存两次字节相同)
- `input_text_roundtrip`(边界文本)
- `c3_broken_formula_loads_as_foreign`
- `xlsx_sheet_name_sanitized_and_formulas_follow`
- `xlsx_import_unknown_function_becomes_foreign`
- `xlsx_export_expands_relative_layer_ref`
- `xlsx_export_all_layers_ref_becomes_3d_ref`
- `xlsx_export_devalues_layeridx_with_comment`
- `xlsx_roundtrip_preserves_foreign_formula`
