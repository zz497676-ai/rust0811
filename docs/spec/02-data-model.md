# 02 — 数据模型

本章定义 `cube3-core` 的公开类型。**这些类型名、字段名、方法签名是契约** —— 下游文档
(04/05/06/08)按这套名字书写。私有实现细节自由发挥。

所有类型位于 `cube3-core`,按模块划分:

```
crates/cube3-core/src/
  lib.rs          // pub use 重导出,对外只暴露一层扁平命名空间
  addr.rs         // LayerId, Addr, Rect, Cuboid, A1 转换
  value.rs        // Value, CellError
  cell.rs         // Cell, CellInput, Formula
  grid.rs         // SparseGrid
  layer.rs        // Layer
  workbook.rs     // Workbook —— 顶层 API
  style.rs        // Style, StyleId, StyleTable, NumberFormat, Align
  error.rs        // ModelError
```

---

## 2.1 坐标与地址

内部坐标一律 **0-based**;面向用户的显示与 A1 记法一律 **1-based**(行)/ A-based(列)。
转换只在 `addr.rs` 的显示/解析函数里发生,其余代码不得混用。

```rust
pub type Row = u32;
pub type Col = u32;

/// 层的稳定标识。与层在工作簿中的位置无关 —— 重排、改名都不改变它。
/// 公式内部解析后的引用持有 LayerId,因此移动层不会破坏引用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LayerId(pub u32);

/// 一个完全解析后的三维地址(绝对坐标)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Addr {
    pub layer: LayerId,
    pub row: Row,
    pub col: Col,
}

/// 二维矩形区域,四个边界都是闭区间。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub r0: Row,
    pub c0: Col,
    pub r1: Row, // 含
    pub c1: Col, // 含
}

/// 三维长方体:一组层 × 一个矩形。层用有序的 LayerId 列表表达,
/// 而不是索引区间 —— 因为解析后要对层重排免疫。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cuboid {
    pub layers: Vec<LayerId>,
    pub rect: Rect,
}
```

必须提供的构造与迭代:

```rust
impl Rect {
    pub fn single(row: Row, col: Col) -> Rect;
    /// 自动归一化:传入的两点无论顺序如何,结果满足 r0<=r1 && c0<=c1
    pub fn from_corners(a: (Row, Col), b: (Row, Col)) -> Rect;
    pub fn contains(&self, row: Row, col: Col) -> bool;
    pub fn intersects(&self, other: &Rect) -> bool;
    pub fn rows(&self) -> u32;      // r1 - r0 + 1
    pub fn cols(&self) -> u32;
    pub fn cell_count(&self) -> u64;
    /// 按 行 → 列 顺序遍历
    pub fn iter(&self) -> impl Iterator<Item = (Row, Col)> + '_;
}

impl Cuboid {
    pub fn contains(&self, addr: Addr) -> bool;
    pub fn cell_count(&self) -> u64;   // layers.len() * rect.cell_count()
    /// **展平顺序:层 → 行 → 列**。所有接受区域的函数都依赖这个顺序,不得更改。
    pub fn iter(&self) -> impl Iterator<Item = Addr> + '_;
}
```

### A1 记法转换

```rust
/// 0 -> "A", 25 -> "Z", 26 -> "AA", 16383 -> "XFD"
pub fn col_to_letters(col: Col) -> String;

/// "a" / "A" -> Some(0);  "XFD" -> Some(16383);  "" / "A1" / "XFE" -> None
pub fn letters_to_col(s: &str) -> Option<Col>;

/// (0, 0) -> "A1"
pub fn a1_of(row: Row, col: Col) -> String;

/// "B3" -> Some((2, 1));  "$B$3" 不由此函数处理(那是公式层的事)
pub fn parse_a1(s: &str) -> Option<(Row, Col)>;
```

### 上限

```rust
pub const MAX_ROWS: u32 = 1_048_576;  // 与 Excel 一致
pub const MAX_COLS: u32 = 16_384;     // XFD,与 Excel 一致
pub const MAX_LAYERS: usize = 4_096;
```

超出上限的写入返回 `ModelError::AddrOutOfRange`;超出上限的**引用**求值为 `#REF!`。

---

## 2.2 值与错误

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Empty,
    Number(f64),
    Text(Arc<str>),
    Bool(bool),
    Error(CellError),
}
```

**为什么用 `f64` 而不是 `rust_decimal`:** 本项目的首要目标是与 Excel 语义一致,而 Excel 的
数值就是 IEEE-754 双精度。用定点数会在导入导出与函数边界行为上引入一整类与 Excel 不符的
差异。代价是继承了浮点误差(`0.1+0.2 != 0.3`),这与 Excel 表现一致,属于**预期行为**,
不要"修复"它。显示层的四舍五入由 `NumberFormat` 负责。

`Text` 用 `Arc<str>` 而非 `String`:`Value` 会被大量克隆(区域展平、依赖传播),
`Arc` 让克隆变成引用计数递增。

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellError {
    /// 除以零                       显示 "#DIV/0!"
    Div0,
    /// 类型错误,例如 SQRT("abc")   显示 "#VALUE!"
    Value,
    /// 引用不存在的层/越界的行列    显示 "#REF!"
    Ref,
    /// 未知函数名或未知层名         显示 "#NAME?"
    Name,
    /// 数值超出定义域,例如 SQRT(-1) 显示 "#NUM!"
    Num,
    /// 查找失败,例如 VLOOKUP 未命中 显示 "#N/A"
    NA,
    /// 循环引用(cube3 扩展)       显示 "#CIRC!"
    Circular,
    /// 公式无法解析(cube3 扩展)   显示 "#PARSE!"
    Parse,
    /// 从 xlsx 导入的、本引擎不支持的函数(cube3 扩展)  显示 "#UNSUP!"
    Unsupported,
}
```

`impl std::fmt::Display for CellError` 输出上表中的字符串。
`CellError::from_display(s: &str) -> Option<CellError>` 做反向解析(xlsx 导入要用)。

### 类型强转规则(与 Excel 一致)

在**算术**上下文中:

| 来源 | 转换结果 |
|---|---|
| `Number(n)` | `n` |
| `Bool(true)` / `Bool(false)` | `1.0` / `0.0` |
| `Empty` | `0.0` |
| `Text(s)`,且 `s` 能解析为数字 | 该数字 |
| `Text(s)`,不能解析 | `#VALUE!` |
| `Error(e)` | 原样传播 `e` |

在**文本**上下文中(`&` 与文本函数):`Number` 用 General 格式转字符串,`Bool` 转 `"TRUE"`/`"FALSE"`,
`Empty` 转 `""`,`Error` 原样传播。

在**比较**上下文中:数字 < 文本 < 布尔(Excel 的跨类型排序规则);同类型按自然序比较;
文本比较**大小写不敏感**(Excel 行为);`Empty` 与 `0` 相等,`Empty` 与 `""` 相等。

**错误传播:** 任何运算的任一操作数是 `Error` 时,结果就是该错误。多个操作数都是错误时,
取**求值顺序上第一个**遇到的(即从左到右)。唯一的例外是 `IFERROR` / `ISERROR` / `IFNA`,
它们捕获错误而不传播。

---

## 2.3 单元格

```rust
#[derive(Debug, Clone)]
pub struct Cell {
    pub input: CellInput,
    /// 上一次重算的结果。字面量单元格里它与 input 中的值相同。
    pub value: Value,
    pub style: StyleId,
}

#[derive(Debug, Clone)]
pub enum CellInput {
    Literal(Value),
    Formula(Formula),
}

#[derive(Debug, Clone)]
pub struct Formula {
    /// 用户键入的原文,含前导 "="。回显到公式栏、写入存档、导出 xlsx 都用它。
    pub src: String,
    /// 解析后的抽象语法树。`Arc` 使得复制/填充公式时可以共享同一棵树。
    pub ast: Arc<Expr>,
    /// 从 xlsx 导入且本引擎不支持时为 true:此时不求值,直接沿用导入的缓存值。
    /// 导出时把 `src` 原样写回,保证不丢数据。详见 05。
    pub foreign: bool,
}

impl Cell {
    /// 是否为不可重算的外来公式。非公式格恒为 false。
    pub fn is_foreign(&self) -> bool;
    /// 是否为公式格。
    pub fn is_formula(&self) -> bool;
}
```

`Expr` 定义在 [04-engine.md](04-engine.md#41-ast) —— 它属于公式引擎而非数据模型,
但 `Formula` 需要持有它,所以在 `lib.rs` 里一并重导出。

### 用户输入的解释规则

`Workbook::set_input` 收到的是一个字符串,按以下**顺序**判定(先匹配者胜):

| 条件 | 结果 |
|---|---|
| 空字符串 | `CellInput::Literal(Value::Empty)` |
| 以 `=` 开头 | 解析为公式;解析失败则**整个调用返回 `Err`,单元格不被修改** |
| 以 `'` 开头 | 去掉这个单引号,剩下的整体作为 `Text`(强制文本转义) |
| 能解析为数字(含 `+`/`-` 前缀、小数、科学记数法) | `Number` |
| 形如 `<数字>%` | `Number(x/100)`,并把该格的 `NumberFormat` 设为 `Percent` |
| 大小写不敏感等于 `TRUE` / `FALSE` | `Bool` |
| 其余 | `Text` |

**注意公式解析失败时不写入。** 这让 TUI 可以把错误提示出来、让用户继续编辑,而不是留下一个
`#PARSE!` 垃圾格。`#PARSE!` 只在从存档/xlsx 加载到损坏公式时出现。

---

## 2.4 稀疏网格

表格天然稀疏 —— 一个 1000 行 × 26 列的层可能只有几百个非空格。用 `HashMap` 存,
不预分配二维数组。

```rust
#[derive(Debug, Clone, Default)]
pub struct SparseGrid {
    cells: HashMap<(Row, Col), Cell>,
    /// 已用区域的缓存边界。None 表示网格为空。
    /// 删除单元格时**不收缩**(避免 O(n) 重扫),只在 `shrink_used()` 被显式调用时重算。
    used: Option<Rect>,
}

impl SparseGrid {
    pub fn get(&self, row: Row, col: Col) -> Option<&Cell>;
    pub fn get_mut(&mut self, row: Row, col: Col) -> Option<&mut Cell>;
    /// 写入并扩展 `used` 边界。
    pub fn set(&mut self, row: Row, col: Col, cell: Cell);
    pub fn remove(&mut self, row: Row, col: Col) -> Option<Cell>;
    /// 不存在的格返回 Value::Empty,而不是 Option —— 求值路径上这样最省事。
    pub fn value(&self, row: Row, col: Col) -> Value;
    pub fn is_empty(&self) -> bool;
    pub fn len(&self) -> usize;
    /// 已用区域。空网格返回 None。可能大于真实已用区域(见 `used` 字段说明)。
    pub fn used_range(&self) -> Option<Rect>;
    /// 全量重算 `used`,O(n)。保存和导出前调用一次即可。
    pub fn shrink_used(&mut self);
    /// 遍历非空单元格,**顺序不保证**。需要确定序时调用方自行排序。
    pub fn iter(&self) -> impl Iterator<Item = (Row, Col, &Cell)> + '_;
    /// 遍历某矩形内的非空单元格。实现要点见下方说明。
    pub fn iter_rect(&self, rect: &Rect) -> impl Iterator<Item = (Row, Col, &Cell)> + '_;
}
```

**`iter_rect` 的实现选择:** 当 `rect.cell_count()` 小于 `cells.len()` 时,逐坐标查表;
否则遍历全部单元格并过滤。两条路径都要有,以 `cell_count()` 为阈值切换 —— 否则
`SUM(A1:A1048576)` 这种全列引用会退化。

---

## 2.5 层与工作簿

```rust
#[derive(Debug, Clone)]
pub struct Layer {
    pub id: LayerId,
    pub name: String,
    pub grid: SparseGrid,
    /// 隐藏层仍参与计算,只是不在 TUI 的层标签条里显示。
    pub hidden: bool,
}
```

### 层名规则

- 非空,去除首尾空白后长度 1..=64
- 不含这些字符:`! : * [ ] # $ ' " / \ ?`
- **大小写不敏感地唯一**(`Sales` 与 `sales` 冲突)
- 不得形如单元格地址(正则 `^[A-Za-z]{1,3}[0-9]{1,7}$`,如 `A1`、`XFD100`)—— 否则
  `A1!B2` 有歧义
- 不得是保留字:`L`(与 `L[k]` 冲突)
- 含空格的层名在公式中必须用单引号包裹:`'North Region'!B2`

以上规则集中在一个函数里,增删改名共用:

```rust
pub fn validate_layer_name(name: &str) -> Result<(), ModelError>;
```

### Workbook

```rust
pub struct Workbook {
    layers: Vec<Layer>,                    // 顺序 == 层轴顺序
    by_id: HashMap<LayerId, usize>,        // LayerId -> layers 下标
    by_name: HashMap<String, LayerId>,     // 小写层名 -> LayerId
    next_layer_id: u32,
    styles: StyleTable,
    deps: DepGraph,                        // 见 04
    dirty: HashSet<Addr>,                  // 见 04
}
```

层管理 API。**所有会改变层顺序或层集合的操作,都必须把所有含相对层引用(`L[k]!`、`*!`)
的单元格标记为脏** —— 因为它们的解析结果依赖层序:

```rust
impl Workbook {
    /// 新建工作簿,含一个名为 "Layer1" 的空层。
    pub fn new() -> Self;

    pub fn layer_count(&self) -> usize;
    pub fn layers(&self) -> &[Layer];
    pub fn layer(&self, id: LayerId) -> Option<&Layer>;
    pub fn layer_mut(&mut self, id: LayerId) -> Option<&mut Layer>;
    pub fn layer_at(&self, index: usize) -> Option<&Layer>;
    /// 0-based 下标 -> LayerId。公式里的 `#2` 是 1-based,转换在解析器里做。
    pub fn layer_id_at(&self, index: usize) -> Option<LayerId>;
    pub fn layer_index(&self, id: LayerId) -> Option<usize>;
    /// 大小写不敏感。
    pub fn layer_by_name(&self, name: &str) -> Option<LayerId>;

    /// 追加到末尾。
    pub fn add_layer(&mut self, name: &str) -> Result<LayerId, ModelError>;
    /// 插入到指定下标(0-based),后续层顺延。
    pub fn insert_layer(&mut self, index: usize, name: &str) -> Result<LayerId, ModelError>;
    /// 删除。删除最后一个层返回 `ModelError::LastLayer`。
    /// 指向被删层的引用在下次重算时变为 `#REF!`。
    pub fn remove_layer(&mut self, id: LayerId) -> Result<Layer, ModelError>;
    pub fn rename_layer(&mut self, id: LayerId, new_name: &str) -> Result<(), ModelError>;
    /// 移动到新下标。LayerId 不变,因此按名字/ID 的引用不受影响;
    /// 相对层引用(L[k]!)与全层引用(*!)的解析结果会变,故须重算。
    pub fn move_layer(&mut self, id: LayerId, to_index: usize) -> Result<(), ModelError>;
    /// 深拷贝一个层(含全部单元格与公式),插入到源层之后。
    pub fn duplicate_layer(&mut self, id: LayerId, new_name: &str) -> Result<LayerId, ModelError>;
}
```

单元格读写 API:

```rust
impl Workbook {
    /// 按 2.3 的规则解释 `input`,写入,并触发增量重算。
    /// 公式解析失败时返回 Err 且**不修改任何状态**。
    pub fn set_input(&mut self, addr: Addr, input: &str) -> Result<(), ModelError>;

    /// 清空单元格(等价于 set_input(addr, ""))并触发增量重算。
    pub fn clear(&mut self, addr: Addr) -> Result<(), ModelError>;

    pub fn cell(&self, addr: Addr) -> Option<&Cell>;

    /// 单元格的当前值。不存在的格返回 `Value::Empty`,不存在的层返回 `Error(Ref)`。
    pub fn value(&self, addr: Addr) -> Value;

    /// 回显给公式栏的文本:公式格返回 `src`(含 `=`),字面量格返回其规范化文本。
    pub fn input_text(&self, addr: Addr) -> String;

    /// 按该格的 NumberFormat 格式化后的显示文本,供 TUI 与导出使用。
    pub fn display_text(&self, addr: Addr) -> String;

    /// 一次性求值一个表达式,不写入工作簿。用于状态栏即时计算与测试。
    /// `src` 可带或不带前导 `=`。`ctx` 提供相对引用的解析基点。
    pub fn eval_at(&self, ctx: Addr, src: &str) -> Value;

    /// 全量重算。仅用于加载存档后与测试;正常编辑走增量路径。
    pub fn recalc_all(&mut self);

    pub fn styles(&self) -> &StyleTable;
    /// 把一个 Style 驻留进样式表并应用到指定单元格(单元格不存在时先建空格)。
    pub fn set_style(&mut self, addr: Addr, style: Style) -> Result<(), ModelError>;
}
```

批量操作(TUI 的复制/粘贴/填充要用,见 [06](06-tui.md)):

```rust
impl Workbook {
    /// 把 `src` 单元格的输入复制到 `dst`,公式中的相对引用按三根轴的位移重写。
    /// 这是"填充"的原子操作;跨层填充时 layer 位移非零。
    pub fn copy_cell(&mut self, src: Addr, dst: Addr) -> Result<(), ModelError>;

    /// 把一个 Cuboid 内所有单元格清空。
    pub fn clear_cuboid(&mut self, cuboid: &Cuboid) -> Result<(), ModelError>;
}
```

---

## 2.6 样式

MVP 的样式**只有三件事**:数字格式、水平对齐、粗体。不做字体、颜色、边框、条件格式。

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StyleId(pub u32);

/// StyleId(0) 恒为默认样式,永远存在。
pub const DEFAULT_STYLE: StyleId = StyleId(0);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct Style {
    pub number_format: NumberFormat,
    pub align: Align,
    pub bold: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub enum NumberFormat {
    #[default]
    General,
    /// 固定小数位,如 Fixed(2) -> "1234.50"
    Fixed(u8),
    /// 千分位分隔 + 固定小数位 -> "1,234.50"
    Thousands(u8),
    /// 百分比 -> "12.34%"
    Percent(u8),
    /// 前缀符号 + 千分位 -> "¥1,234.50"
    Currency { decimals: u8, symbol: String },
    /// 强制按文本显示
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Align {
    /// 数字右对齐、文本左对齐、布尔与错误居中
    #[default]
    Auto,
    Left,
    Center,
    Right,
}
```

样式**驻留(intern)**,单元格只存 `StyleId`:

```rust
pub struct StyleTable { /* Vec<Style> + HashMap<Style, StyleId> */ }

impl StyleTable {
    pub fn new() -> Self;                          // 预置 DEFAULT_STYLE
    pub fn intern(&mut self, style: Style) -> StyleId;
    pub fn get(&self, id: StyleId) -> &Style;      // 非法 id 返回默认样式,不 panic
    pub fn len(&self) -> usize;
}
```

`General` 格式的数字转文本规则(与 Excel 近似,不必逐位对齐):整数直接输出;小数最多保留
10 位有效数字并去除尾随零;绝对值 ≥ 1e11 或 < 1e-10 时用科学记数法。

---

## 2.7 错误类型

```rust
#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("层名不能为空")]
    EmptyLayerName,
    #[error("层名 `{0}` 已存在")]
    DuplicateLayerName(String),
    #[error("层名 `{0}` 非法:{1}")]
    InvalidLayerName(String, &'static str),
    #[error("层不存在")]
    NoSuchLayer,
    #[error("不能删除最后一个层")]
    LastLayer,
    #[error("层序号越界:{0}")]
    LayerIndexOutOfRange(usize),
    #[error("地址越界:行 {row} 列 {col}")]
    AddrOutOfRange { row: Row, col: Col },
    #[error("公式解析失败:{0}")]
    Parse(#[from] ParseError),
}
```

`ParseError` 定义在 [04](04-engine.md#解析错误)。

**约定:`cube3-core` 里不允许 `unwrap()` / `expect()` / `panic!()` 出现在非测试代码中**,
唯一例外是能在注释里论证"不可能失败"的内部不变量(例如 `by_id` 与 `layers` 的一致性),
且必须写成 `expect("<不变量说明>")`。

---

## 2.8 验收要点

M1 完成时,[08-acceptance-tests.md](08-acceptance-tests.md#m1-数据模型) 中的这组测试须通过:
`a1_roundtrip`、`col_letters_boundaries`、`rect_normalizes_corners`、`cuboid_iter_order`、
`layer_name_validation`、`layer_rename_and_move_keep_id`、`remove_last_layer_rejected`、
`sparse_grid_used_range`、`input_interpretation`、`style_interning`。
