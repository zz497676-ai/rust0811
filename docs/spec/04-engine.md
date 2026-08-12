# 04 — 公式引擎

模块划分:

```
crates/cube3-core/src/formula/
  mod.rs        // pub use
  ast.rs        // Expr 及其 to_source
  lexer.rs      // Token, Lexer
  parser.rs     // 优先级爬升解析器
  eval.rs       // 求值器、EvalContext、Operand
  functions/
    mod.rs      // FnDef 注册表
    math.rs     logic.rs     text.rs     lookup.rs     layer.rs
crates/cube3-core/src/engine/
  mod.rs
  depgraph.rs   // DepGraph
  recalc.rs     // 增量重算与循环检测
```

---

## 4.1 AST

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Number(f64),
    Text(Arc<str>),
    Bool(bool),
    /// 公式里直接写出的错误字面量,如 =#N/A
    ErrorLit(CellError),
    Ref(RefExpr),
    /// 填充越界后留下的永久 #REF!(见 03 §3.6)
    RefError,
    Unary { op: UnaryOp, operand: Box<Expr> },
    Binary { op: BinaryOp, lhs: Box<Expr>, rhs: Box<Expr> },
    /// 后缀百分号
    Percent(Box<Expr>),
    Call { name: Arc<str>, args: Vec<Expr> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp { Neg, Plus }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add, Sub, Mul, Div, Pow, Concat,
    Eq, Ne, Lt, Le, Gt, Ge,
}

/// 一个引用:层选择 + 行列范围。解析期不绑定 LayerId。
#[derive(Debug, Clone, PartialEq)]
pub struct RefExpr {
    pub layer: LayerSel,
    pub start: A1Ref,
    /// None 表示单点引用
    pub end: Option<A1Ref>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LayerSel {
    /// 层部分省略 —— 当前层
    Current,
    /// L[k],k 可正可负,L[0] 等价于 Current 但保留原写法以便 to_source 还原
    Relative(i32),
    /// 具名层,保留原始大小写用于 to_source;匹配时不敏感
    Named(Arc<str>),
    /// #n,1-based
    Index(u32),
    /// *
    All,
    /// 层区间。两端只能是 Current / Relative / Named / Index,
    /// 嵌套 All 或 Range 在解析期就报错。
    Range(Box<LayerSel>, Box<LayerSel>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct A1Ref {
    pub col: Col,
    pub col_abs: bool,
    pub row: Row,
    pub row_abs: bool,
}
```

`Expr::to_source(&self) -> String` 的要求见 [03 §3.6](03-formula-language.md#36-复制与填充时的引用重写)。
**幂等性是硬性要求**,须有 property 风格的测试:对一组代表性公式,`parse(s).to_source()`
再 parse 得到相等的 AST。

---

## 4.2 词法器

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Number(f64),
    Text(String),
    Bool(bool),
    ErrorLit(CellError),
    /// 标识符:函数名或层名
    Ident(String),
    /// 单引号包裹的层名(已去引号、已还原 '' 转义)
    QuotedName(String),
    /// L[k]
    LayerRel(i32),
    /// #n
    LayerIdx(u32),
    /// A1 片段:($)COL($)ROW
    A1 { col: Col, col_abs: bool, row: Row, row_abs: bool },
    Plus, Minus, Star, Slash, Caret, Amp, Percent,
    Eq, Ne, Lt, Le, Gt, Ge,
    LParen, RParen, Comma, Colon, Bang,
    Eof,
}

pub struct Lexer<'a> { /* ... */ }

impl<'a> Lexer<'a> {
    pub fn new(src: &'a str) -> Self;
    /// 返回下一个记号及其在源串中的字节起始位置。
    pub fn next_token(&mut self) -> Result<(Token, usize), ParseError>;
}
```

### 词法器的三个坑

**1. `#` 的二义性。** `#3!B2` 与 `#N/A` 都以 `#` 开头。规则:先按**最长匹配**尝试错误字面量表
(9 个字面量,见 [02](02-data-model.md#22-值与错误)),匹配成功即产出 `ErrorLit`;否则要求后面
跟至少一位数字,产出 `LayerIdx`;都不是则报 `ParseErrorKind::BadHash`。

**2. `A1` 与标识符的区分。** 读到字母开头的串时,先尝试按 `($)字母(1..=3)($)数字` 的完整形状
匹配 A1;匹配成功且**紧随其后不是 `(`** 则产出 `A1`;否则回退按 `Ident` 处理。
`SUM(...)` 里的 `SUM` 不匹配 A1 形状,`A1(...)` 因后跟 `(` 被当作函数名(随后求值为 `#NAME?`)。

**3. `L[k]` 不允许内部空白。** `L [1]` 应当被词法为 `Ident("L")` 后接 `[`,而 `[` 不是合法记号,
于是报错。这正是我们要的 —— 不要为了"宽容"去接受它。

---

## 4.3 解析器

### 为什么手写解析器

不引入 `nom` / `pest` / `chumsky`,理由有三条,请勿"优化"掉:

1. **错误信息位置**。用户在公式栏里打错字是高频事件,TUI 需要"第 7 个字符处:期望 `)`"这种
   精确定位。组合子库的错误恢复要拼装很久才能达到手写的质量。
2. **Excel 的怪异优先级**(一元负号紧于 `^`、`^` 左结合)在优先级爬升里就是两行常量表,
   在组合子里要绕。
3. **依赖面**。这是一个纯计算内核,少一个依赖就少一份升级负担。

优先级爬升(precedence climbing / Pratt)是这套文法的标准解法,约 250 行。

```rust
pub struct Parser<'a> { /* Lexer + 一个前瞻记号 */ }

/// 解析一条公式。`src` 可带或不带前导 "="。
pub fn parse_formula(src: &str) -> Result<Expr, ParseError>;
```

优先级表(数值越大结合越紧,与 [03 §3.3](03-formula-language.md#运算符优先级由低到高) 的表一一对应):

```rust
fn binding_power(op: BinaryOp) -> (u8, u8) {  // (左, 右);左 < 右 表示左结合
    match op {
        Eq | Ne | Lt | Le | Gt | Ge => (1, 2),
        Concat                      => (3, 4),
        Add | Sub                   => (5, 6),
        Mul | Div                   => (7, 8),
        Pow                         => (9, 10),   // 左结合
    }
}
const UNARY_BP: u8 = 11;   // 一元 +/- 比 ^ 更紧
// 后缀 % 在 primary 之后直接循环消费,优先级最高
```

### 引用的解析

引用是文法里唯一需要回溯的地方。策略:

1. 读到 `A1` / `Ident` / `QuotedName` / `LayerRel` / `LayerIdx` / `*` 之一
2. 若其后是 `!` ⇒ 前面那部分是 `layer_part`,继续解析 `range_part`
3. 若其后是 `:` ⇒ 可能是层区间(`Q1:Q4!...`),也可能是单元格区间(`A1:B2`)。
   **判据:先解析 `:` 右侧,再看其后是否为 `!`** —— 是则整体为层区间,否则为单元格区间
4. 否则前面那部分只能是 `A1`(单点引用)或 `Ident`(未知函数名/裸标识符 ⇒ `#NAME?`)

这个两记号前瞻是解析器里唯一的复杂点,单独写一个 `parse_reference()` 函数容纳它,
并配足够的测试:`A1:B2`、`Q1:Q4!A1`、`Q1:Q4!A1:B2`、`*!A1`、`L[-1]:L[0]!A1:B2`。

### 解析错误

```rust
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{kind}(位置 {pos})")]
pub struct ParseError {
    /// 出错处在源串中的字节偏移
    pub pos: usize,
    pub kind: ParseErrorKind,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ParseErrorKind {
    #[error("无法识别的字符 `{0}`")]         UnexpectedChar(char),
    #[error("不期望的记号 `{0}`")]           UnexpectedToken(String),
    #[error("公式意外结束")]                 UnexpectedEof,
    #[error("字符串缺少收尾引号")]           UnterminatedString,
    #[error("层名缺少收尾单引号")]           UnterminatedName,
    #[error("括号不匹配")]                   UnbalancedParen,
    #[error("`#` 后需要错误字面量或层序号")] BadHash,
    #[error("层序号必须 ≥ 1")]               ZeroLayerIndex,
    #[error("层引用无需 `$`")]               DollarOnLayer,
    #[error("层区间的端点不能是 `*` 或另一个区间")] NestedLayerRange,
    #[error("列超出上限 XFD")]               ColumnOutOfRange,
    #[error("行超出上限 1048576")]           RowOutOfRange,
    #[error("公式嵌套过深")]                 TooDeep,
}
```

嵌套深度上限 **64**,在解析期检查(而非求值期),避免恶意/误输入的深嵌套在解析时就爆栈。

**未知函数名不是解析错误** —— 解析成功,求值时返回 `#NAME?`。这是刻意的:xlsx 导入需要
保留无法识别的函数原文(见 [05](05-persistence.md#53-公式导入翻译规则))。

---

## 4.4 求值器

```rust
pub struct EvalContext<'a> {
    pub wb: &'a Workbook,
    /// 相对引用的解析基点 = 公式所在单元格
    pub cur: Addr,
    /// 函数调用深度,上限 64
    pub depth: u32,
}

/// 求值的中间结果:标量或区域。
pub enum Operand {
    Scalar(Value),
    Range(Cuboid),
}

pub fn eval(ctx: &mut EvalContext, expr: &Expr) -> Value;

/// 供函数实现使用的三个辅助函数:
pub fn eval_operand(ctx: &mut EvalContext, expr: &Expr) -> Result<Operand, CellError>;
/// 区域 ⇒ #VALUE!(单格区域除外)
pub fn eval_scalar(ctx: &mut EvalContext, expr: &Expr) -> Result<Value, CellError>;
/// 标量 ⇒ 视作 1×1×1 区域;返回按 层→行→列 展平的值序列
pub fn eval_values(ctx: &mut EvalContext, expr: &Expr) -> Result<Vec<Value>, CellError>;
```

### 引用解析

```rust
/// 把 RefExpr 在给定上下文中解析成具体的 Cuboid。
/// 层不存在 ⇒ Err(Name);层序号/相对偏移越界 ⇒ Err(Ref);
/// 层区间单端越界 ⇒ 裁剪(见 03 §3.1)。
pub fn resolve_ref(wb: &Workbook, cur: Addr, r: &RefExpr) -> Result<Cuboid, CellError>;
```

这个函数是三维语义的落脚点,必须**独立可测**,不要把它内联进求值器。

### 函数注册表

```rust
pub struct FnDef {
    pub name: &'static str,          // 全大写
    pub min_args: usize,
    /// None 表示可变参数上限不限
    pub max_args: Option<usize>,
    /// 注意:传入的是**未求值的 AST**,由函数自己决定求值哪些参数。
    /// 这样 IF 的惰性分支求值就是自然的,不需要特殊处理。
    pub eval: fn(&mut EvalContext, &[Expr]) -> Value,
}

/// 大小写不敏感查找。用 LazyLock<HashMap<&'static str, &'static FnDef>> 建索引。
pub fn lookup_function(name: &str) -> Option<&'static FnDef>;

/// 全部函数定义,按 03 §3.5 的分类分文件定义后在 mod.rs 汇总。
pub static FUNCTIONS: &[FnDef];
```

参数个数检查在 `Expr::Call` 的求值入口统一做,不必每个函数各写一遍:个数不符 ⇒ `#VALUE!`。

**测试要求:** 一个 `all_functions_have_tests` 测试,遍历 `FUNCTIONS`,断言每个函数名都出现在
一张手工维护的"已测函数名"列表里。这样新增函数忘了写测试会被 CI 拦住。

---

## 4.5 依赖图

```rust
#[derive(Debug, Default)]
pub struct DepGraph {
    /// 单点依赖:被引用的单元格 -> 引用它的公式单元格集合
    by_cell: HashMap<Addr, HashSet<Addr>>,
    /// 区域依赖:(被引用的长方体, 引用它的公式单元格)
    /// MVP 用线性扫描匹配,见下方性能说明。
    by_cuboid: Vec<(Cuboid, Addr)>,
    /// 全部公式单元格
    formulas: HashSet<Addr>,
    /// 引用中含相对层(L[k])或全层(*)选择的公式单元格。
    /// 层的增删/重排会改变它们的解析结果,必须整体标脏。
    layer_sensitive: HashSet<Addr>,
}

impl DepGraph {
    /// 注册一个公式单元格的全部依赖。先调用 unregister 再注册,保证幂等。
    pub fn register(&mut self, at: Addr, expr: &Expr, wb: &Workbook);
    pub fn unregister(&mut self, at: Addr);
    /// 直接依赖 `addr` 的公式单元格(单点 + 区域命中)。
    pub fn dependents_of(&self, addr: Addr) -> HashSet<Addr>;
    pub fn layer_sensitive(&self) -> &HashSet<Addr>;
    pub fn formulas(&self) -> &HashSet<Addr>;
}
```

依赖抽取:遍历 AST 收集所有 `Expr::Ref`,用 `resolve_ref` 解析。单点引用进 `by_cell`;
区域引用进 `by_cuboid`。**解析失败(`#REF!` / `#NAME?`)的引用不进图,但该格仍在 `formulas` 里**,
所以层结构变化时它会通过 `layer_sensitive` 或全量重算被重新求值。

### 已知的性能限制(不要提前优化)

`dependents_of` 对 `by_cuboid` 做线性扫描,复杂度 O(区域依赖条数)。在 [01 G8](01-overview.md#14-目标mvp-必须做到)
的目标规模(26 万单元格、区域依赖通常几百条)下完全够用。

**这是有意为之的选择,不是缺陷。** 升级路径已想好:把 `by_cuboid` 换成按层分桶的 R-tree
或区间树。**MVP 阶段不要实现它** —— 先让基准测试跑起来,数据说话。若 M9 的基准显示
`dependents_of` 占重算时间 > 30%,再考虑。

---

## 4.6 增量重算

```rust
impl Workbook {
    /// 把一个地址标脏(值可能已变)。
    fn mark_dirty(&mut self, addr: Addr);
    /// 处理全部脏格。set_input / clear / 层操作的末尾调用。
    fn flush_recalc(&mut self);
}
```

算法:

1. **收集受影响集合。** 从脏集合出发,沿 `dependents_of` 做广度优先遍历,得到闭包 `A`。
   遍历时用 `visited` 集合防止无限循环(环会在下一步被正式检出)。
2. **拓扑排序。** 只在 `A` 的导出子图上跑 Kahn 算法:边的方向是 前驱 → 依赖者;
   入度为 0 的先出队。
3. **求值。** 按拓扑序逐个求值,把结果写回 `cell.value`。
4. **环检测。** Kahn 算法结束后仍留在图中的节点即处于环上(或依赖于环),
   把它们的值全部设为 `Value::Error(CellError::Circular)`。
5. 清空脏集合。

### 何时标脏

| 事件 | 标脏范围 |
|---|---|
| `set_input(addr, ...)` | `addr` 本身 |
| `clear(addr)` | `addr` 本身 |
| `add_layer` / `insert_layer` / `remove_layer` / `move_layer` | **全部 `layer_sensitive`** + 被删层内所有公式的依赖者 |
| `rename_layer` | 引用了旧名或新名的公式格(简单实现:全部 `formulas`) |
| `copy_cell(dst)` | `dst` 本身 |
| 加载存档 / 导入 xlsx | 走 `recalc_all()`,不用增量路径 |

`recalc_all()` 就是把 `formulas` 全部标脏后走同一套流程 —— **不要写第二套求值路径**。

### 性能目标与验证

[01 G8](01-overview.md#14-目标mvp-必须做到):10 层 × 1000 行 × 26 列,单次编辑触发的增量重算
**< 50 ms**。M9 里用一个 `benches/recalc.rs`(`cargo bench` 或简单的 `Instant` 计时集成测试)验证。

不要求达到 Excel 的性能量级。若达不到,先确认是不是"每次编辑都在做全量重算"这类算法错误,
再考虑数据结构优化。

---

## 4.7 验收要点

M2/M3/M4 的验收测试见 [08-acceptance-tests.md](08-acceptance-tests.md)。引擎侧的关键必测项:

- `parse_error_reports_position`
- `to_source_roundtrip_is_idempotent`
- `nesting_depth_limit_rejected`
- `unknown_function_parses_but_evals_to_name_error`
- `incremental_recalc_touches_only_dependents`(用一个计数器统计求值次数)
- `circular_reference_detected`(A1 = B1,B1 = A1 ⇒ 两格都是 `#CIRC!`)
- `self_reference_detected`(A1 = A1 + 1)
- `long_chain_recalc_order`(A1←A2←…←A100,改 A1 后全链正确)
- `layer_move_redirties_layer_sensitive_cells`
