# 03 — 公式语言

本章定义 cube3 的公式语法与语义。基线是 Excel;**凡本章未列出差异之处,一律与 Excel 一致**。

---

## 3.1 引用语法

这是 cube3 与 Excel 的核心差异所在,先看全貌:

| 写法 | 含义 | 层轴性质 |
|---|---|---|
| `B2` | 当前层的 B2 | 相对(偏移 0) |
| `Sales!B2` | 名为 Sales 的层的 B2 | 绝对 |
| `'North Region'!B2` | 层名含空格时用单引号 | 绝对 |
| `#3!B2` | 第 3 层(**1-based**)的 B2 | 绝对(按位置) |
| `L[-1]!B2` | **前一层**的 B2 | 相对 |
| `L[+2]!B2` | 后两层的 B2 | 相对 |
| `*!B2` | **所有层**的 B2(一个 N×1×1 长方体) | 全层 |
| `B2:D10` | 当前层的矩形 | 相对 |
| `Q1:Q4!B2:D10` | Q1..Q4 四个层 × 该矩形,一个长方体 | 绝对 |
| `L[-2]:L[0]!B2` | **滚动窗口**:近三层的 B2 | 相对 |
| `#1:#3!A1:A5` | 第 1..3 层 × A1:A5 | 绝对 |
| `$B$2`、`B$2`、`$B2` | 行/列的绝对锁定,语义同 Excel | — |

### 层轴上没有 `$`

行列轴用 `$` 区分相对与绝对,层轴不用 —— 因为**形式本身已经区分了**:

- `L[k]!` 与省略层部分 ⇒ 相对,跨层填充时保持偏移不变
- `Name!` 与 `#n!` ⇒ 绝对,跨层填充时纹丝不动

给层名再加 `$` 只会制造"看起来能变其实不能变"的歧义。解析器遇到 `$Sales!B2` 应当报错
(`ParseError::DollarOnLayer`),并在错误信息里提示"层引用无需 `$`"。

### 相对层引用为什么重要

`L[-1]!` 让**沿深度轴递推**的计算变成一条可跨层复制的公式:

```
B10:  =L[-1]!B10 + B5 - B6        期初余额 = 上月期末 + 本月收 - 本月支
B12:  =IFERROR(DELTA(B5)/L[-1]!B5, "")   环比增长率
B14:  =SUM(L[-2]:L[0]!B5)         近三期滚动合计
```

同一条公式跨层填充到 12 个月份层,每层各自解析到正确的目标。Excel 里这必须逐 sheet 手写,
且插入一个月份就全线断裂。

### 层引用的解析规则

解析(parse)阶段只做语法识别,**不绑定具体层**;绑定发生在求值(eval)阶段,以
求值上下文 `ctx: Addr` 的 `ctx.layer` 为基点:

| 语法形式 | 求值时的解析 | 越界时 |
|---|---|---|
| 省略 | `ctx.layer` | — |
| `L[k]` | `layer_id_at(layer_index(ctx.layer) + k)` | `#REF!` |
| `Name` | `layer_by_name("name")`,大小写不敏感 | 层不存在 → `#NAME?` |
| `#n` | `layer_id_at(n - 1)` | `#REF!` |
| `*` | 工作簿全部层,按当前层序 | — |

**层区间的越界裁剪规则**(与单点引用不同,这是刻意的):

- 区间两端都越界(整个窗口在有效范围之外)⇒ `#REF!`
- 只有一端越界 ⇒ **裁剪到有效范围**,不报错

这条规则让 `SUM(L[-2]:L[0]!B5)` 在第 1 层上退化为"只有本层"、在第 2 层上退化为"本层+上一层",
一路填下去都成立 —— 这正是滚动窗口想要的行为。若不裁剪,前两层永远是 `#REF!`,整个特性
就没法用。

区间端点顺序无关:`L[0]:L[-2]!B5` 与 `L[-2]:L[0]!B5` 等价,解析后按层序归一化。

### 长方体的展平顺序

**层 → 行 → 列**。所有接受区域参数的函数按这个顺序消费单元格
(`Cuboid::iter`,见 [02](02-data-model.md#21-坐标与地址))。顺序影响 `INDEX`、`MATCH`、
`TEXTJOIN` 等的结果,**不得更改**。

---

## 3.2 词法

| 记号 | 规则 |
|---|---|
| 空白 | 空格与制表符,记号之间可任意出现,不产生记号 |
| 数字 | `[0-9]+ ( "." [0-9]+ )? ( [eE] [+-]? [0-9]+ )?`;也接受 `.5` 这种无整数部分的写法 |
| 字符串 | 双引号包裹;`""` 表示一个字面双引号;不支持反斜杠转义(与 Excel 一致) |
| 布尔 | `TRUE` / `FALSE`,大小写不敏感 |
| 错误字面量 | `#DIV/0!` `#VALUE!` `#REF!` `#NAME?` `#NUM!` `#N/A` `#CIRC!` `#PARSE!` `#UNSUP!` |
| 标识符 | `[A-Za-z_][A-Za-z0-9_.]*`;函数名与层名共用此规则 |
| 引号层名 | `'` 开始,`''` 表示一个字面单引号,`'` 结束 |
| 运算符 | `+ - * / ^ & % = <> < <= > >= ( ) , : !` |
| 层相对标记 | `L` `[` `+`/`-` 数字 `]`,**中间不允许空白** |

**大小写:** 函数名、布尔字面量、层名一律大小写不敏感。列字母也不敏感(`b2` ≡ `B2`)。
错误字面量必须大写。

**歧义处理:** `#3!B2` 中的 `#3` 与错误字面量都以 `#` 开头,词法器先尝试匹配错误字面量表
(最长匹配),失败则按 `#` + 数字处理。`L[1]` 与层名 `L` 冲突,故 `L` 是保留字,不能作层名
(见 [02 层名规则](02-data-model.md#层名规则))。

---

## 3.3 文法(EBNF)

```ebnf
formula        = [ "=" ] , expr ;

expr           = compare ;
compare        = concat , { ( "=" | "<>" | "<" | "<=" | ">" | ">=" ) , concat } ;
concat         = additive , { "&" , additive } ;
additive       = multiplicative , { ( "+" | "-" ) , multiplicative } ;
multiplicative = power , { ( "*" | "/" ) , power } ;
power          = unary , { "^" , unary } ;
unary          = ( "-" | "+" ) , unary | postfix ;
postfix        = primary , { "%" } ;
primary        = number
               | string
               | bool
               | error_literal
               | func_call
               | reference
               | "(" , expr , ")" ;

func_call      = ident , "(" , [ expr , { "," , expr } ] , ")" ;

reference      = [ layer_part , "!" ] , range_part ;
layer_part     = "*" | layer_sel , [ ":" , layer_sel ] ;
layer_sel      = layer_name | "#" , uint | "L" , "[" , [ "+" | "-" ] , uint , "]" ;
layer_name     = ident | quoted_name ;
range_part     = a1 , [ ":" , a1 ] ;
a1             = [ "$" ] , col_letters , [ "$" ] , uint ;
col_letters    = letter , { letter } ;                (* 1..=3 个字母 *)
```

### 运算符优先级(由低到高)

与 Excel 一致,**注意最后两条与常规数学习惯不同**:

| 级别 | 运算符 | 结合性 |
|---|---|---|
| 1 | `=` `<>` `<` `<=` `>` `>=` | 左 |
| 2 | `&` | 左 |
| 3 | `+` `-`(二元) | 左 |
| 4 | `*` `/` | 左 |
| 5 | `^` | **左**结合 |
| 6 | `-` `+`(一元) | 右 |
| 7 | `%`(后缀) | — |

由此:

- `2^3^2` = `(2^3)^2` = **64**(不是 512)—— Excel 的 `^` 是左结合
- `-2^2` = `(-2)^2` = **4**(不是 -4)—— 一元负号比 `^` 结合更紧
- `50%` = 0.5,`A1%` = `A1/100`

这两条反直觉的行为**必须有测试覆盖**,否则很容易在实现时"顺手改成正确的数学"。

---

## 3.4 求值语义

### 上下文

```rust
pub struct EvalContext<'a> {
    pub wb: &'a Workbook,
    /// 相对引用的解析基点 —— 即公式所在的单元格。
    pub cur: Addr,
    /// 当前调用深度,用于防止函数嵌套过深爆栈。上限 64。
    pub depth: u32,
}
```

### 标量 / 区域 的适配

引用可能求值成单个值,也可能求值成长方体。规则:

- 函数参数声明为 **Range** 时:接受长方体;传入标量时视为 1×1×1 长方体
- 函数参数声明为 **Scalar** 时:传入 1 个单元格的长方体 ⇒ 取其值;传入多单元格长方体 ⇒ `#VALUE!`
- **运算符**(`+ - * / ^ & %` 与比较)的操作数一律按 Scalar 处理

不实现 Excel 的隐式交集(implicit intersection)与动态数组溢出 —— 见
[01 非目标](01-overview.md#15-非目标mvp-明确不做)。

### 空单元格

| 场景 | 行为 |
|---|---|
| 算术运算的操作数 | 视作 `0` |
| 文本连接的操作数 | 视作 `""` |
| `SUM` / `AVERAGE` / `MIN` / `MAX` / `PRODUCT` 的区域元素 | **跳过**(不计入,也不影响 AVERAGE 分母) |
| `COUNT` / `COUNTA` | 不计入 |
| `COUNTBLANK` | 计入 |
| 与 `0` 比较 | 相等 |
| 与 `""` 比较 | 相等 |

### 求值顺序与错误

参数**从左到右**求值,遇到第一个 `Error` 立即返回该错误,不再求值后续参数。
例外:`IF` 只求值被选中的分支;`IFERROR` 捕获第一个参数的错误;`ISERROR` 永不传播。

`AND` / `OR` **不短路**(与 Excel 一致):所有参数都求值,任一为错误则返回该错误。

### 除零

`x / 0` 与 `MOD(x, 0)` ⇒ `#DIV/0!`。`0 / 0` 同样是 `#DIV/0!`。

---

## 3.5 内置函数表

共 **52** 个。函数名大小写不敏感。参数列 `[]` 表示可选,`...` 表示可变参数。
`R` = Range(接受长方体),`S` = Scalar。

### 数学与聚合(16)

| 函数 | 签名 | 说明 / 与 Excel 的差异 |
|---|---|---|
| `SUM` | `SUM(R...)` | 跳过空格、文本与布尔;错误传播 |
| `AVERAGE` | `AVERAGE(R...)` | 无数值元素 ⇒ `#DIV/0!` |
| `MIN` | `MIN(R...)` | 无数值元素 ⇒ `0`(Excel 行为) |
| `MAX` | `MAX(R...)` | 同上 |
| `COUNT` | `COUNT(R...)` | 只数数值 |
| `COUNTA` | `COUNTA(R...)` | 数所有非空(含文本、布尔、错误) |
| `COUNTBLANK` | `COUNTBLANK(R)` | 只数空格 |
| `PRODUCT` | `PRODUCT(R...)` | 跳过非数值;无数值元素 ⇒ `0` |
| `ABS` | `ABS(S)` | |
| `SQRT` | `SQRT(S)` | 负数 ⇒ `#NUM!` |
| `POWER` | `POWER(S, S)` | 结果非有限 ⇒ `#NUM!` |
| `MOD` | `MOD(S, S)` | **符号跟随除数**(Excel/Python 语义,非 Rust 的 `%`);除数 0 ⇒ `#DIV/0!` |
| `INT` | `INT(S)` | 向下取整(`INT(-2.5) = -3`),非截断 |
| `ROUND` | `ROUND(S, S)` | **四舍五入远离零**(Excel 语义,非 Rust 的银行家舍入) |
| `ROUNDUP` | `ROUNDUP(S, S)` | 远离零方向取整 |
| `ROUNDDOWN` | `ROUNDDOWN(S, S)` | 趋零方向取整 |

`MOD` 与 `ROUND` 的语义差异是最容易写错的两处,各自必须有针对负数的测试。

### 条件聚合(3)

| 函数 | 签名 | 说明 |
|---|---|---|
| `SUMIF` | `SUMIF(R, S, [R])` | 第三参省略时对第一参求和;两个区域的**元素个数**必须相等,否则 `#VALUE!` |
| `COUNTIF` | `COUNTIF(R, S)` | |
| `AVERAGEIF` | `AVERAGEIF(R, S, [R])` | 无匹配 ⇒ `#DIV/0!` |

**条件(criteria)语法:** 支持字面值(等值比较)与字符串形式的比较式 `">100"` `"<=0"`
`"<>abc"`。**不支持通配符** `*` `?` —— 这是与 Excel 的已知差异,须在函数文档注释里写明。

### 逻辑与信息(12)

| 函数 | 签名 | 说明 |
|---|---|---|
| `IF` | `IF(S, S, [S])` | 第三参省略且条件为假 ⇒ `FALSE`;**只求值被选中的分支** |
| `IFS` | `IFS(S, S, ...)` | 参数成对;无匹配 ⇒ `#N/A`;参数个数为奇数 ⇒ `#VALUE!` |
| `AND` | `AND(R...)` | 不短路;无布尔可解释的参数 ⇒ `#VALUE!` |
| `OR` | `OR(R...)` | 同上 |
| `NOT` | `NOT(S)` | |
| `TRUE` | `TRUE()` | 也可写作裸字面量 `TRUE` |
| `FALSE` | `FALSE()` | |
| `IFERROR` | `IFERROR(S, S)` | 第一参为任意错误(含 `#CIRC!`)时返回第二参 |
| `ISERROR` | `ISERROR(S)` | |
| `ISBLANK` | `ISBLANK(S)` | |
| `ISNUMBER` | `ISNUMBER(S)` | |
| `ISTEXT` | `ISTEXT(S)` | |

### 文本(10)

| 函数 | 签名 | 说明 |
|---|---|---|
| `CONCAT` | `CONCAT(R...)` | 展平区域后依次连接 |
| `TEXTJOIN` | `TEXTJOIN(S, S, R...)` | `(分隔符, 是否忽略空, ...)` |
| `LEN` | `LEN(S)` | 按 **Unicode 字符**计数(`chars().count()`),非字节 |
| `LEFT` | `LEFT(S, [S])` | 第二参默认 1;按字符切分,不得在多字节边界内切开 |
| `RIGHT` | `RIGHT(S, [S])` | 同上 |
| `MID` | `MID(S, S, S)` | 起始位置 **1-based**;起始 < 1 ⇒ `#VALUE!` |
| `UPPER` | `UPPER(S)` | |
| `LOWER` | `LOWER(S)` | |
| `TRIM` | `TRIM(S)` | 去首尾空白,并把中间的连续空格压成一个(Excel 语义) |
| `VALUE` | `VALUE(S)` | 文本转数字;失败 ⇒ `#VALUE!` |

所有文本函数必须对**中文字符串**有测试 —— 按字节切分是这里最典型的 bug。

### 查找(4)

| 函数 | 签名 | 说明 |
|---|---|---|
| `VLOOKUP` | `VLOOKUP(S, R, S, [S])` | 第四参默认 `TRUE`(近似匹配);未命中 ⇒ `#N/A`;列号越界 ⇒ `#REF!`。区域跨多层时,**只在第一层内查找**(避免语义含混),该限制须在文档注释中写明 |
| `INDEX` | `INDEX(R, S, [S], [S])` | **三维扩展**:第四参为层序号(区域内的第几层,1-based),省略则为 1。`INDEX(cuboid, row, col, layer)`。索引越界 ⇒ `#REF!` |
| `MATCH` | `MATCH(S, R, [S])` | 第三参 1 = 升序近似 / 0 = 精确 / -1 = 降序近似,默认 1;按展平顺序返回 1-based 位置 |
| `CHOOSE` | `CHOOSE(S, S...)` | 索引 1-based;越界 ⇒ `#VALUE!` |

### 层向函数(7)—— cube3 独有

| 函数 | 签名 | 等价写法 | 说明 |
|---|---|---|---|
| `LAYERSUM` | `LAYERSUM(R)` | `SUM(*!R)` | 把参数区域在**所有层**上求和 |
| `LAYERAVG` | `LAYERAVG(R)` | `AVERAGE(*!R)` | |
| `LAYERCOUNT` | `LAYERCOUNT(R)` | `COUNT(*!R)` | |
| `LAYERIDX` | `LAYERIDX()` | — | 当前层的序号,1-based |
| `LAYERNAME` | `LAYERNAME([S])` | — | 层名;省略参数为当前层,否则取第 n 层(1-based),越界 ⇒ `#REF!` |
| `PREV` | `PREV(R)` | `L[-1]!R` | 上一层的同位置;第一层 ⇒ `#REF!` |
| `DELTA` | `DELTA(R)` | `R - L[-1]!R` | 与上一层的差;第一层 ⇒ `#REF!` |

`LAYERSUM(B2:B10)` 与 `SUM(*!B2:B10)` 必须返回完全相同的结果 —— 前者是后者的语法糖,
实现上直接改写成后者即可,不要写两套逻辑。

`PREV` / `DELTA` 在第一层返回 `#REF!` 是刻意的:静默返回本层值会让"环比"列在第一行给出
一个假的 0% 增长。惯用法是显式兜底:

```
=IFERROR(DELTA(B5), "")
```

---

## 3.6 复制与填充时的引用重写

复制公式从 `src: Addr` 到 `dst: Addr`,位移 `Δ = (Δlayer, Δrow, Δcol)`。对 AST 中每个引用:

| 引用成分 | 重写规则 |
|---|---|
| 列,无 `$` | `col += Δcol` |
| 列,有 `$` | 不变 |
| 行,无 `$` | `row += Δrow` |
| 行,有 `$` | 不变 |
| 层部分省略 | 不变(它本来就跟着当前层走) |
| 层部分 `L[k]` | 不变(偏移量保持,解析基点变了) |
| 层部分 `Name` / `#n` / `*` | 不变(绝对) |

**越界处理:** 重写后行或列为负数或超过 `MAX_ROWS`/`MAX_COLS` 时,该引用被替换为
`Expr::RefError`,重新生成的公式文本里显示为 `#REF!`,求值结果为 `#REF!`。
这与 Excel 一致 —— 公式文本本身被永久改写,不是求值期的临时错误。

因此需要 **AST 反向生成源码**的能力:

```rust
impl Expr {
    /// 把 AST 还原成规范化的公式文本(不含前导 "=")。
    /// 要求:对任意合法公式 f,`parse(f).to_source()` 再 parse 得到等价的 AST(幂等)。
    pub fn to_source(&self) -> String;
}
```

规范化输出:运算符两侧不加空格,逗号后不加空格,数字用 General 格式,函数名全大写,
层名保持原始大小写(必要时加单引号)。仅当括号是保持语义所必需时才输出括号。

---

## 3.7 与 Excel 的差异汇总

写代码时把这张表当 checklist,每条都要有测试:

| # | 差异 | cube3 行为 |
|---|---|---|
| D1 | 层轴引用 | Excel 无相对 sheet 引用;cube3 有 `L[k]!` |
| D2 | 3D 区域 | Excel 的 `Sheet1:Sheet3!A1` 仅部分函数可用;cube3 的长方体所有区域函数通用 |
| D3 | 层区间越界 | Excel 报错;cube3 **裁剪**(仅区间;单点仍 `#REF!`) |
| D4 | 通配符条件 | Excel 的 `SUMIF` 支持 `*` `?`;cube3 **不支持** |
| D5 | 隐式交集 | Excel 有;cube3 **无**,多格传标量位 ⇒ `#VALUE!` |
| D6 | 动态数组 | Excel 有溢出;cube3 **无**,函数只返回标量 |
| D7 | 迭代计算 | Excel 可开启;cube3 循环引用一律 `#CIRC!` |
| D8 | `VLOOKUP` 跨层 | Excel 无此情形;cube3 只在区域第一层查找 |
| D9 | 日期类型 | Excel 有序列值日期;cube3 **MVP 无日期类型**,日期以文本或数字存在 |
| D10 | 新增错误值 | `#CIRC!` `#PARSE!` `#UNSUP!` 是 cube3 扩展,导出 xlsx 时映射见 [05](05-persistence.md) |

---

## 3.8 验收要点

M2(词法/语法)、M3(求值/函数)、M5(三维引用/层向函数)的验收测试见
[08-acceptance-tests.md](08-acceptance-tests.md)。重点必测项:

- `power_is_left_associative`(`2^3^2 == 64`)
- `unary_minus_binds_tighter_than_power`(`-2^2 == 4`)
- `mod_follows_divisor_sign`、`round_half_away_from_zero`
- `text_functions_are_char_based`(中文字符串)
- `relative_layer_ref_resolves_per_layer`
- `layer_range_clamps_at_boundary`(滚动窗口)
- `single_relative_layer_ref_out_of_range_is_ref_error`
- `cuboid_flatten_order_is_layer_row_col`
- `to_source_roundtrip_is_idempotent`
- `fill_across_layers_keeps_relative_offset`
