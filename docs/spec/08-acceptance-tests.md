# 08 — 验收测试

每个里程碑的验收测试。**这些是最低要求,不是全部** —— 实现时该补的边界测试照补。

测试放置约定:

| 测试对象 | 位置 |
|---|---|
| 公开 API 的行为 | `crates/<crate>/tests/*.rs`(集成测试) |
| 私有实现(词法器、解析器内部、重算计数) | 对应模块内的 `#[cfg(test)] mod tests` |
| 元测试(函数覆盖) | `crates/cube3-core/tests/coverage.rs` |

---

## 测试辅助模块

`crates/cube3-core/tests/common/mod.rs`,所有集成测试共用:

```rust
#![allow(dead_code)]

use cube3_core::*;

/// 建一个含指定层名的工作簿。第一个名字用于重命名 `Workbook::new()` 的默认层。
pub fn wb(names: &[&str]) -> Workbook {
    let mut wb = Workbook::new();
    let first = wb.layer_id_at(0).expect("默认层存在");
    wb.rename_layer(first, names[0]).expect("重命名首层");
    for name in &names[1..] {
        wb.add_layer(name).expect("新建层");
    }
    wb
}

/// 层下标(0-based)+ A1 记法 -> Addr
pub fn at(wb: &Workbook, layer: usize, a1: &str) -> Addr {
    let (row, col) = parse_a1(a1).expect("合法的 A1 记法");
    Addr { layer: wb.layer_id_at(layer).expect("层存在"), row, col }
}

pub fn set(wb: &mut Workbook, layer: usize, a1: &str, input: &str) {
    let a = at(wb, layer, a1);
    wb.set_input(a, input).expect("输入应被接受");
}

pub fn val(wb: &Workbook, layer: usize, a1: &str) -> Value {
    wb.value(at(wb, layer, a1))
}

/// 在第 `layer` 层的 `a1` 位置作为上下文求值一个表达式(不写入)
pub fn eval_in(wb: &Workbook, layer: usize, a1: &str, src: &str) -> Value {
    wb.eval_at(at(wb, layer, a1), src)
}

/// 上下文固定为第 1 层的 A1,用于与引用无关的纯表达式
pub fn eval0(wb: &Workbook, src: &str) -> Value {
    eval_in(wb, 0, "A1", src)
}

#[macro_export]
macro_rules! assert_num {
    ($actual:expr, $expected:expr) => {
        match $actual {
            Value::Number(n) => assert!(
                (n - $expected as f64).abs() < 1e-9,
                "期望 {},实际 {}", $expected, n
            ),
            other => panic!("期望数字 {},实际 {:?}", $expected, other),
        }
    };
}

#[macro_export]
macro_rules! assert_err {
    ($actual:expr, $expected:expr) => {
        assert_eq!($actual, Value::Error($expected));
    };
}
```

---

## M1 数据模型

`crates/cube3-core/tests/model.rs`

```rust
mod common;
use common::*;
use cube3_core::*;

#[test]
fn a1_roundtrip() {
    for &(row, col, s) in &[
        (0u32, 0u32, "A1"), (0, 25, "Z1"), (0, 26, "AA1"),
        (99, 1, "B100"), (1_048_575, 16_383, "XFD1048576"),
    ] {
        assert_eq!(a1_of(row, col), s);
        assert_eq!(parse_a1(s), Some((row, col)));
    }
}

#[test]
fn col_letters_boundaries() {
    assert_eq!(letters_to_col("A"), Some(0));
    assert_eq!(letters_to_col("a"), Some(0));          // 大小写不敏感
    assert_eq!(letters_to_col("XFD"), Some(16_383));   // 上限
    assert_eq!(letters_to_col("XFE"), None);           // 越界
    assert_eq!(letters_to_col("AAAA"), None);          // 超过 3 字母
    assert_eq!(letters_to_col(""), None);
    assert_eq!(col_to_letters(16_383), "XFD");
}

#[test]
fn rect_normalizes_corners() {
    let r = Rect::from_corners((5, 3), (1, 7));
    assert_eq!((r.r0, r.c0, r.r1, r.c1), (1, 3, 5, 7));
    assert_eq!(r.rows(), 5);
    assert_eq!(r.cols(), 5);
    assert_eq!(r.cell_count(), 25);
    assert!(r.contains(3, 5));
    assert!(!r.contains(0, 5));
}

#[test]
fn cuboid_iter_order() {
    // 展平顺序必须是 层 -> 行 -> 列
    let w = wb(&["L1", "L2"]);
    let c = Cuboid {
        layers: vec![w.layer_id_at(0).unwrap(), w.layer_id_at(1).unwrap()],
        rect: Rect::from_corners((0, 0), (1, 1)),
    };
    let got: Vec<(usize, u32, u32)> = c
        .iter()
        .map(|a| (w.layer_index(a.layer).unwrap(), a.row, a.col))
        .collect();
    assert_eq!(
        got,
        vec![
            (0, 0, 0), (0, 0, 1), (0, 1, 0), (0, 1, 1),
            (1, 0, 0), (1, 0, 1), (1, 1, 0), (1, 1, 1),
        ]
    );
    assert_eq!(c.cell_count(), 8);
}

#[test]
fn layer_name_validation() {
    assert!(validate_layer_name("Sales").is_ok());
    assert!(validate_layer_name("2024-01").is_ok());
    assert!(validate_layer_name("北区").is_ok());
    assert!(validate_layer_name("").is_err());          // 空
    assert!(validate_layer_name("  ").is_err());        // 全空白
    assert!(validate_layer_name("A!B").is_err());       // 非法字符
    assert!(validate_layer_name("A1").is_err());        // 形如单元格地址
    assert!(validate_layer_name("XFD100").is_err());
    assert!(validate_layer_name("L").is_err());         // 保留字
    assert!(validate_layer_name(&"x".repeat(65)).is_err());

    let mut w = wb(&["Sales"]);
    assert!(w.add_layer("sales").is_err());             // 大小写不敏感冲突
}

#[test]
fn layer_rename_and_move_keep_id() {
    let mut w = wb(&["A", "B", "C"]);
    let b = w.layer_id_at(1).unwrap();

    w.rename_layer(b, "BB").unwrap();
    assert_eq!(w.layer_id_at(1).unwrap(), b);
    assert_eq!(w.layer_by_name("bb"), Some(b));         // 大小写不敏感查找
    assert_eq!(w.layer_by_name("B"), None);

    w.move_layer(b, 0).unwrap();
    assert_eq!(w.layer_index(b), Some(0));
    assert_eq!(w.layer(b).unwrap().name, "BB");         // ID 与内容都没变
    assert_eq!(w.layer_at(1).unwrap().name, "A");
}

#[test]
fn remove_last_layer_rejected() {
    let mut w = wb(&["Only"]);
    let id = w.layer_id_at(0).unwrap();
    assert!(matches!(w.remove_layer(id), Err(ModelError::LastLayer)));
    assert_eq!(w.layer_count(), 1);
}

#[test]
fn sparse_grid_used_range() {
    let mut w = wb(&["L1"]);
    assert!(w.layer_at(0).unwrap().grid.used_range().is_none());
    set(&mut w, 0, "B3", "1");
    set(&mut w, 0, "D10", "2");
    let r = w.layer_at(0).unwrap().grid.used_range().unwrap();
    assert_eq!((r.r0, r.c0, r.r1, r.c1), (2, 1, 9, 3));
    assert_eq!(w.layer_at(0).unwrap().grid.len(), 2);
}

#[test]
fn input_interpretation() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "");        assert_eq!(val(&w, 0, "A1"), Value::Empty);
    set(&mut w, 0, "A2", "12.5");    assert_num!(val(&w, 0, "A2"), 12.5);
    set(&mut w, 0, "A3", "-3e2");    assert_num!(val(&w, 0, "A3"), -300.0);
    set(&mut w, 0, "A4", "50%");     assert_num!(val(&w, 0, "A4"), 0.5);
    set(&mut w, 0, "A5", "true");    assert_eq!(val(&w, 0, "A5"), Value::Bool(true));
    set(&mut w, 0, "A6", "hello");   assert_eq!(val(&w, 0, "A6"), Value::Text("hello".into()));
    set(&mut w, 0, "A7", "'123");    assert_eq!(val(&w, 0, "A7"), Value::Text("123".into()));
    set(&mut w, 0, "A8", "'=1+1");   assert_eq!(val(&w, 0, "A8"), Value::Text("=1+1".into()));

    // 50% 同时设置了百分比格式
    let style_id = w.cell(at(&w, 0, "A4")).unwrap().style;
    assert!(matches!(
        w.styles().get(style_id).number_format,
        NumberFormat::Percent(_)
    ));

    // 公式解析失败时不写入,且返回 Err
    let a = at(&w, 0, "A9");
    assert!(w.set_input(a, "=1+").is_err());
    assert!(w.cell(a).is_none());
}

#[test]
fn style_interning() {
    let mut t = StyleTable::new();
    let s = Style { number_format: NumberFormat::Fixed(2), ..Default::default() };
    let a = t.intern(s.clone());
    let b = t.intern(s);
    assert_eq!(a, b);                             // 同样的样式复用同一个 id
    assert_eq!(t.get(DEFAULT_STYLE), &Style::default());
    assert_eq!(t.len(), 2);                       // 默认样式 + 新样式
}
```

---

## M2 词法与语法分析

词法器测试放 `formula/lexer.rs` 内的 `#[cfg(test)] mod tests`,解析器测试放
`formula/parser.rs` 内。这里给出代表性写法:

```rust
#[test]
fn lex_basic_tokens() {
    let toks = lex_all("=1.5+B2*\"a\"\"b\"&TRUE").unwrap();
    assert_eq!(toks[0], Token::Number(1.5));
    assert_eq!(toks[1], Token::Plus);
    assert!(matches!(toks[2], Token::A1 { col: 1, row: 1, .. }));
    assert_eq!(toks[3], Token::Star);
    assert_eq!(toks[4], Token::Text("a\"b".into()));   // "" 转义为一个引号
    assert_eq!(toks[5], Token::Amp);
    assert_eq!(toks[6], Token::Bool(true));
}

#[test]
fn lex_hash_ambiguity() {
    assert_eq!(lex_all("#N/A").unwrap()[0], Token::ErrorLit(CellError::NA));
    assert_eq!(lex_all("#DIV/0!").unwrap()[0], Token::ErrorLit(CellError::Div0));
    assert_eq!(lex_all("#3").unwrap()[0], Token::LayerIdx(3));
    assert!(lex_all("#x").is_err());   // BadHash
}

#[test]
fn lex_a1_vs_ident() {
    assert!(matches!(lex_all("B2").unwrap()[0], Token::A1 { col: 1, row: 1, .. }));
    assert!(matches!(lex_all("$B$2").unwrap()[0],
        Token::A1 { col_abs: true, row_abs: true, .. }));
    assert_eq!(lex_all("SUM(").unwrap()[0], Token::Ident("SUM".into()));
    // 形如 A1 但后跟 '(' 的,按标识符处理(求值时成为 #NAME?)
    assert_eq!(lex_all("A1(").unwrap()[0], Token::Ident("A1".into()));
}

#[test]
fn lex_layer_rel_no_space() {
    assert_eq!(lex_all("L[-1]").unwrap()[0], Token::LayerRel(-1));
    assert_eq!(lex_all("L[+2]").unwrap()[0], Token::LayerRel(2));
    assert_eq!(lex_all("L[0]").unwrap()[0], Token::LayerRel(0));
    assert!(lex_all("L [1]").is_err());   // 中间不允许空白
}

// M2 阶段还没有求值器,结合性只能在 AST 上断言。
// 测试辅助:把 AST 渲染成**全括号**形式,一眼看出结合方向。
// (与 `Expr::to_source` 不同 —— 后者只在必要时加括号)
fn parens(src: &str) -> String { /* 递归渲染 parse_formula(src) 的结果 */ }

#[test]
fn parse_precedence_table() {
    assert_eq!(parens("=1+2*3"),   "(1+(2*3))");
    assert_eq!(parens("=(1+2)*3"), "((1+2)*3)");
    assert_eq!(parens("=1&2=3"),   "((1&2)=3)");     // & 紧于 =
    assert_eq!(parens("=1<2&3"),   "(1<(2&3))");
    assert_eq!(parens("=1+2-3"),   "((1+2)-3)");     // 同级左结合
}

#[test]
fn power_is_left_associative() {
    // Excel 行为:2^3^2 解析为 (2^3)^2,求值得 64 而非 512
    assert_eq!(parens("=2^3^2"), "((2^3)^2)");
}

#[test]
fn unary_minus_binds_tighter_than_power() {
    // Excel 行为:-2^2 解析为 (-2)^2,求值得 4 而非 -4
    assert_eq!(parens("=-2^2"), "((-2)^2)");
    assert_eq!(parens("=0-2^2"), "(0-(2^2))");   // 二元减号则是常规优先级
}

#[test]
fn percent_postfix() {
    assert_eq!(parens("=50%"), "(50%)");
    assert_eq!(parens("=200%*3"), "((200%)*3)");
}

#[test]
fn parse_all_reference_forms() {
    for s in [
        "B2", "$B$2", "B$2", "$B2", "B2:D10",
        "Sales!B2", "'North Region'!B2", "#3!B2",
        "L[-1]!B2", "L[+2]!B2", "*!B2",
        "Q1:Q4!B2:D10", "L[-2]:L[0]!B2", "#1:#3!A1:A5",
    ] {
        assert!(parse_formula(s).is_ok(), "应能解析:{s}");
    }
}

#[test]
fn parse_error_reports_position() {
    let e = parse_formula("=1+*2").unwrap_err();
    assert_eq!(e.pos, 3);
    let e = parse_formula("=SUM(1,2").unwrap_err();
    assert!(matches!(e.kind, ParseErrorKind::UnexpectedEof | ParseErrorKind::UnbalancedParen));
}

#[test]
fn nesting_depth_limit_rejected() {
    let deep = format!("={}1{}", "SUM(".repeat(70), ")".repeat(70));
    assert!(matches!(parse_formula(&deep).unwrap_err().kind, ParseErrorKind::TooDeep));
}

#[test]
fn dollar_on_layer_rejected() {
    assert!(matches!(
        parse_formula("=$Sales!B2").unwrap_err().kind,
        ParseErrorKind::DollarOnLayer
    ));
}

#[test]
fn to_source_roundtrip_is_idempotent() {
    for s in [
        "1+2*3", "(1+2)*3", "-2^2", "2^3^2", "50%",
        "SUM(A1:B2)", "IF(A1>0,\"正\",\"负\")",
        "L[-1]!B2+*!C3", "'North Region'!B2:D4",
        "SUM(L[-2]:L[0]!B5)", "#2!A1", "A1&\"x\"\"y\"",
    ] {
        let a = parse_formula(s).expect(s);
        let once = a.to_source();
        let b = parse_formula(&once).expect(&once);
        assert_eq!(a, b, "AST 不稳定:{s} -> {once}");
        assert_eq!(once, b.to_source(), "to_source 不幂等:{s}");
    }
}
```

---

## M3 求值与函数库

`crates/cube3-core/tests/eval.rs`

```rust
mod common;
use common::*;
use cube3_core::*;

#[test]
fn arith_and_coercion() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "10");
    set(&mut w, 0, "A2", "'20");        // 文本 "20"
    set(&mut w, 0, "A3", "true");
    assert_num!(eval_in(&w, 0, "Z1", "=A1+A2"), 30.0);   // 文本可解析 -> 数字
    assert_num!(eval_in(&w, 0, "Z1", "=A1+A3"), 11.0);   // TRUE -> 1
    assert_num!(eval_in(&w, 0, "Z1", "=A1+A9"), 10.0);   // 空格 -> 0
    assert_eq!(eval_in(&w, 0, "Z1", "=A1&\"x\""), Value::Text("10x".into()));
    set(&mut w, 0, "A4", "abc");
    assert_err!(eval_in(&w, 0, "Z1", "=A1+A4"), CellError::Value);
    assert_err!(eval_in(&w, 0, "Z1", "=1/0"), CellError::Div0);

    // M2 在 AST 上验证过的两条反直觉优先级,这里再做数值确认
    assert_num!(eval0(&w, "=2^3^2"), 64.0);    // 不是 512
    assert_num!(eval0(&w, "=-2^2"), 4.0);      // 不是 -4
    assert_num!(eval0(&w, "=200%*3"), 6.0);
}

#[test]
fn empty_cell_semantics() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "1");
    set(&mut w, 0, "A3", "3");          // A2 留空
    assert_num!(eval_in(&w, 0, "Z1", "=SUM(A1:A3)"), 4.0);
    assert_num!(eval_in(&w, 0, "Z1", "=AVERAGE(A1:A3)"), 2.0);   // 空格不进分母
    assert_num!(eval_in(&w, 0, "Z1", "=COUNT(A1:A3)"), 2.0);
    assert_num!(eval_in(&w, 0, "Z1", "=COUNTBLANK(A1:A3)"), 1.0);
    assert_eq!(eval_in(&w, 0, "Z1", "=A2=0"), Value::Bool(true));
    assert_eq!(eval_in(&w, 0, "Z1", "=A2=\"\""), Value::Bool(true));
}

#[test]
fn error_propagation_order() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "=1/0");        // #DIV/0!
    set(&mut w, 0, "A2", "=SQRT(-1)");   // #NUM!
    // 从左到右,第一个错误胜出
    assert_err!(eval_in(&w, 0, "Z1", "=A1+A2"), CellError::Div0);
    assert_err!(eval_in(&w, 0, "Z1", "=A2+A1"), CellError::Num);
    assert_eq!(eval_in(&w, 0, "Z1", "=ISERROR(A1)"), Value::Bool(true));
    assert_num!(eval_in(&w, 0, "Z1", "=IFERROR(A1,7)"), 7.0);
}

#[test]
fn comparison_cross_type_order() {
    let w = wb(&["L1"]);
    // 数字 < 文本 < 布尔
    assert_eq!(eval0(&w, "=1<\"a\""), Value::Bool(true));
    assert_eq!(eval0(&w, "=\"a\"<TRUE"), Value::Bool(true));
    // 文本比较大小写不敏感
    assert_eq!(eval0(&w, "=\"ABC\"=\"abc\""), Value::Bool(true));
}

#[test]
fn mod_follows_divisor_sign() {
    let w = wb(&["L1"]);
    assert_num!(eval0(&w, "=MOD(-1,3)"), 2.0);    // 不是 -1
    assert_num!(eval0(&w, "=MOD(1,-3)"), -2.0);
    assert_num!(eval0(&w, "=MOD(7,3)"), 1.0);
    assert_err!(eval0(&w, "=MOD(1,0)"), CellError::Div0);
}

#[test]
fn round_half_away_from_zero() {
    let w = wb(&["L1"]);
    assert_num!(eval0(&w, "=ROUND(2.5,0)"), 3.0);     // 不是银行家舍入的 2
    assert_num!(eval0(&w, "=ROUND(-2.5,0)"), -3.0);
    assert_num!(eval0(&w, "=ROUND(1.005,2)"), 1.01);
    assert_num!(eval0(&w, "=ROUNDUP(1.001,2)"), 1.01);
    assert_num!(eval0(&w, "=ROUNDDOWN(-1.999,2)"), -1.99);
}

#[test]
fn int_floors_negatives() {
    let w = wb(&["L1"]);
    assert_num!(eval0(&w, "=INT(2.9)"), 2.0);
    assert_num!(eval0(&w, "=INT(-2.1)"), -3.0);   // 向下取整,不是截断
}

#[test]
fn text_functions_are_char_based() {
    let w = wb(&["L1"]);
    assert_num!(eval0(&w, "=LEN(\"中文字符\")"), 4.0);        // 不是 12 字节
    assert_eq!(eval0(&w, "=LEFT(\"中文字符\",2)"), Value::Text("中文".into()));
    assert_eq!(eval0(&w, "=RIGHT(\"中文字符\",1)"), Value::Text("符".into()));
    assert_eq!(eval0(&w, "=MID(\"中文字符\",2,2)"), Value::Text("文字".into()));
    assert_eq!(eval0(&w, "=TRIM(\"  a   b  \")"), Value::Text("a b".into()));
    assert_err!(eval0(&w, "=MID(\"abc\",0,1)"), CellError::Value);
}

#[test]
fn sumif_criteria_forms() {
    let mut w = wb(&["L1"]);
    for (i, v) in ["10", "20", "30"].iter().enumerate() {
        set(&mut w, 0, &format!("A{}", i + 1), v);
        set(&mut w, 0, &format!("B{}", i + 1), &format!("{}", (i + 1) * 100));
    }
    assert_num!(eval_in(&w, 0, "Z1", "=SUMIF(A1:A3,20)"), 20.0);
    assert_num!(eval_in(&w, 0, "Z1", "=SUMIF(A1:A3,\">15\")"), 50.0);
    assert_num!(eval_in(&w, 0, "Z1", "=SUMIF(A1:A3,\">15\",B1:B3)"), 500.0);
    assert_num!(eval_in(&w, 0, "Z1", "=COUNTIF(A1:A3,\"<>20\")"), 2.0);
    // 已知差异:不支持通配符,当作普通文本比较
    assert_num!(eval_in(&w, 0, "Z1", "=COUNTIF(A1:A3,\"*\")"), 0.0);
}

#[test]
fn if_lazily_evaluates_branches() {
    let w = wb(&["L1"]);
    // 未被选中的分支即使会出错也不求值
    assert_num!(eval0(&w, "=IF(TRUE,1,1/0)"), 1.0);
    assert_num!(eval0(&w, "=IF(FALSE,1/0,2)"), 2.0);
    assert_eq!(eval0(&w, "=IF(FALSE,1)"), Value::Bool(false));   // 省略第三参
}

#[test]
fn and_or_do_not_short_circuit() {
    let w = wb(&["L1"]);
    // 与 Excel 一致:所有参数都求值,错误会传播出来
    assert_err!(eval0(&w, "=AND(FALSE,1/0)"), CellError::Div0);
    assert_err!(eval0(&w, "=OR(TRUE,1/0)"), CellError::Div0);
}

#[test]
fn vlookup_and_match() {
    let mut w = wb(&["L1"]);
    for (i, (k, v)) in [("apple", "3"), ("banana", "5"), ("cherry", "7")].iter().enumerate() {
        set(&mut w, 0, &format!("A{}", i + 1), k);
        set(&mut w, 0, &format!("B{}", i + 1), v);
    }
    assert_num!(eval_in(&w, 0, "Z1", "=VLOOKUP(\"banana\",A1:B3,2,FALSE)"), 5.0);
    assert_err!(eval_in(&w, 0, "Z1", "=VLOOKUP(\"durian\",A1:B3,2,FALSE)"), CellError::NA);
    assert_err!(eval_in(&w, 0, "Z1", "=VLOOKUP(\"apple\",A1:B3,3,FALSE)"), CellError::Ref);
    assert_num!(eval_in(&w, 0, "Z1", "=MATCH(\"cherry\",A1:A3,0)"), 3.0);
    assert_num!(eval_in(&w, 0, "Z1", "=INDEX(B1:B3,2)"), 5.0);
}

#[test]
fn scalar_position_rejects_multi_cell_range() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "1");
    set(&mut w, 0, "A2", "2");
    assert_err!(eval_in(&w, 0, "Z1", "=ABS(A1:A2)"), CellError::Value);
    assert_num!(eval_in(&w, 0, "Z1", "=ABS(A1:A1)"), 1.0);   // 单格区域可退化为标量
}

#[test]
fn unknown_function_parses_but_evals_to_name_error() {
    let w = wb(&["L1"]);
    assert!(parse_formula("=NOSUCHFN(1)").is_ok());
    assert_err!(eval0(&w, "=NOSUCHFN(1)"), CellError::Name);
}
```

`crates/cube3-core/tests/coverage.rs`

```rust
use cube3_core::FUNCTIONS;

/// 手工维护:每实现并测试一个函数,把名字加进来。
const TESTED: &[&str] = &[
    "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTBLANK", "PRODUCT",
    "ABS", "SQRT", "POWER", "MOD", "INT", "ROUND", "ROUNDUP", "ROUNDDOWN",
    "SUMIF", "COUNTIF", "AVERAGEIF",
    "IF", "IFS", "AND", "OR", "NOT", "TRUE", "FALSE", "IFERROR", "ISERROR",
    "ISBLANK", "ISNUMBER", "ISTEXT",
    "CONCAT", "TEXTJOIN", "LEN", "LEFT", "RIGHT", "MID", "UPPER", "LOWER", "TRIM", "VALUE",
    "VLOOKUP", "INDEX", "MATCH", "CHOOSE",
    // 以下 7 个在 M5 加入
    "LAYERSUM", "LAYERAVG", "LAYERCOUNT", "LAYERIDX", "LAYERNAME", "PREV", "DELTA",
];

#[test]
fn all_functions_have_tests() {
    for f in FUNCTIONS {
        assert!(TESTED.contains(&f.name), "函数 {} 尚未列入已测清单", f.name);
    }
    for name in TESTED {
        assert!(
            FUNCTIONS.iter().any(|f| f.name == *name),
            "已测清单里的 {name} 不存在于 FUNCTIONS"
        );
    }
}
```

---

## M4 依赖图与增量重算

`crates/cube3-core/tests/recalc.rs`(增量性那条放 `engine/recalc.rs` 的 `#[cfg(test)]` 内,
因为它要读私有的求值计数器)

```rust
#[test]
fn dependency_registered_and_unregistered() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "1");
    set(&mut w, 0, "B1", "=A1*2");
    assert_num!(val(&w, 0, "B1"), 2.0);

    set(&mut w, 0, "A1", "5");
    assert_num!(val(&w, 0, "B1"), 10.0);

    set(&mut w, 0, "B1", "99");        // 改成字面量,依赖应被注销
    set(&mut w, 0, "A1", "1000");
    assert_num!(val(&w, 0, "B1"), 99.0);
}

#[test]
fn long_chain_recalc_order() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "1");
    for i in 2..=100 {
        set(&mut w, 0, &format!("A{i}"), &format!("=A{}+1", i - 1));
    }
    assert_num!(val(&w, 0, "A100"), 100.0);
    set(&mut w, 0, "A1", "101");
    assert_num!(val(&w, 0, "A100"), 200.0);
}

#[test]
fn circular_reference_detected() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "=B1");
    set(&mut w, 0, "B1", "=A1");
    assert_err!(val(&w, 0, "A1"), CellError::Circular);
    assert_err!(val(&w, 0, "B1"), CellError::Circular);

    // 打破环之后恢复正常
    set(&mut w, 0, "B1", "7");
    assert_num!(val(&w, 0, "A1"), 7.0);
}

#[test]
fn self_reference_detected() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "=A1+1");
    assert_err!(val(&w, 0, "A1"), CellError::Circular);
}

#[test]
fn range_dependency_triggers_on_new_cell() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "C1", "=SUM(A1:A10)");
    assert_num!(val(&w, 0, "C1"), 0.0);
    set(&mut w, 0, "A5", "42");        // 区域内此前不存在的格
    assert_num!(val(&w, 0, "C1"), 42.0);
}

#[test]
fn clearing_cell_updates_dependents() {
    let mut w = wb(&["L1"]);
    set(&mut w, 0, "A1", "10");
    set(&mut w, 0, "B1", "=A1+1");
    w.clear(at(&w, 0, "A1")).unwrap();
    assert_num!(val(&w, 0, "B1"), 1.0);
}
```

`engine/recalc.rs` 内:

```rust
#[test]
fn incremental_recalc_touches_only_dependents() {
    // 100 个互不相关的公式格 + 一条 A1 -> B1 的依赖
    let mut w = /* 构造 */;
    reset_eval_count();
    w.set_input(a1, "5").unwrap();
    // 只应求值 B1 一个格,不是 101 个
    assert_eq!(eval_count(), 1);
}
```

---

## M5 三维引用与层向函数

`crates/cube3-core/tests/cube.rs` —— **本项目最重要的一组测试**

```rust
mod common;
use common::*;
use cube3_core::*;

/// 4 个层,每层 B2 = 层序号 * 100
fn four_layers() -> Workbook {
    let mut w = wb(&["Q1", "Q2", "Q3", "Q4"]);
    for i in 0..4 {
        set(&mut w, i, "B2", &format!("{}", (i + 1) * 100));
    }
    w
}

#[test]
fn resolve_all_layer_selector_forms() {
    let w = four_layers();
    assert_num!(eval_in(&w, 2, "Z1", "=B2"), 300.0);        // 当前层(第 3 层)
    assert_num!(eval_in(&w, 2, "Z1", "=Q1!B2"), 100.0);     // 具名
    assert_num!(eval_in(&w, 2, "Z1", "=q1!B2"), 100.0);     // 大小写不敏感
    assert_num!(eval_in(&w, 2, "Z1", "=#2!B2"), 200.0);     // 序号 1-based
    assert_num!(eval_in(&w, 2, "Z1", "=L[-1]!B2"), 200.0);  // 相对
    assert_num!(eval_in(&w, 2, "Z1", "=L[+1]!B2"), 400.0);
    assert_num!(eval_in(&w, 2, "Z1", "=SUM(*!B2)"), 1000.0);
    assert_err!(eval_in(&w, 2, "Z1", "=NoSuch!B2"), CellError::Name);
    assert_err!(eval_in(&w, 2, "Z1", "=#9!B2"), CellError::Ref);
}

#[test]
fn relative_layer_ref_resolves_per_layer() {
    let mut w = four_layers();
    // 同一条公式写进每一层,各自解析到不同目标
    for i in 1..4 {
        set(&mut w, i, "C2", "=L[-1]!B2");
    }
    assert_num!(val(&w, 1, "C2"), 100.0);
    assert_num!(val(&w, 2, "C2"), 200.0);
    assert_num!(val(&w, 3, "C2"), 300.0);
}

#[test]
fn single_relative_layer_ref_out_of_range_is_ref_error() {
    let w = four_layers();
    assert_err!(eval_in(&w, 0, "Z1", "=L[-1]!B2"), CellError::Ref);
    assert_err!(eval_in(&w, 3, "Z1", "=L[+1]!B2"), CellError::Ref);
}

#[test]
fn layer_range_clamps_at_boundary() {
    let w = four_layers();
    // 区间端点越界要裁剪,而不是报错 —— 这是滚动窗口能用起来的前提
    assert_num!(eval_in(&w, 0, "Z1", "=SUM(L[-2]:L[0]!B2)"), 100.0);           // 只有本层
    assert_num!(eval_in(&w, 1, "Z1", "=SUM(L[-2]:L[0]!B2)"), 300.0);           // 1+2 层
    assert_num!(eval_in(&w, 2, "Z1", "=SUM(L[-2]:L[0]!B2)"), 600.0);           // 1+2+3 层
    assert_num!(eval_in(&w, 3, "Z1", "=SUM(L[-2]:L[0]!B2)"), 900.0);           // 2+3+4 层
    // 端点顺序无关
    assert_num!(eval_in(&w, 3, "Z1", "=SUM(L[0]:L[-2]!B2)"), 900.0);
    // 整个区间都在范围外 -> #REF!
    assert_err!(eval_in(&w, 0, "Z1", "=SUM(L[-5]:L[-3]!B2)"), CellError::Ref);
}

#[test]
fn rolling_window_across_layers() {
    let mut w = four_layers();
    for i in 0..4 {
        set(&mut w, i, "D2", "=SUM(L[-2]:L[0]!B2)");   // 近三期滚动合计
    }
    assert_num!(val(&w, 0, "D2"), 100.0);
    assert_num!(val(&w, 1, "D2"), 300.0);
    assert_num!(val(&w, 2, "D2"), 600.0);
    assert_num!(val(&w, 3, "D2"), 900.0);
}

#[test]
fn cuboid_flatten_order_is_layer_row_col() {
    let mut w = wb(&["L1", "L2"]);
    // L1: A1=1 B1=2 A2=3 B2=4;  L2: A1=5 B1=6 A2=7 B2=8
    let vals = [["1", "2", "3", "4"], ["5", "6", "7", "8"]];
    for (li, row) in vals.iter().enumerate() {
        set(&mut w, li, "A1", row[0]);
        set(&mut w, li, "B1", row[1]);
        set(&mut w, li, "A2", row[2]);
        set(&mut w, li, "B2", row[3]);
    }
    // 展平顺序 层->行->列,所以第 3 个元素是 L1 的 A2 = 3
    assert_num!(eval_in(&w, 0, "Z1", "=INDEX(*!A1:B2,1,1,1)"), 1.0);
    assert_eq!(
        eval_in(&w, 0, "Z1", "=TEXTJOIN(\",\",FALSE,*!A1:B2)"),
        Value::Text("1,2,3,4,5,6,7,8".into())
    );
}

#[test]
fn layer_functions_match_star_ref() {
    let w = four_layers();
    assert_eq!(eval_in(&w, 0, "Z1", "=LAYERSUM(B2)"),   eval_in(&w, 0, "Z1", "=SUM(*!B2)"));
    assert_eq!(eval_in(&w, 0, "Z1", "=LAYERAVG(B2)"),   eval_in(&w, 0, "Z1", "=AVERAGE(*!B2)"));
    assert_eq!(eval_in(&w, 0, "Z1", "=LAYERCOUNT(B2)"), eval_in(&w, 0, "Z1", "=COUNT(*!B2)"));
    assert_num!(eval_in(&w, 2, "Z1", "=LAYERIDX()"), 3.0);
    assert_eq!(eval_in(&w, 2, "Z1", "=LAYERNAME()"), Value::Text("Q3".into()));
    assert_eq!(eval_in(&w, 2, "Z1", "=LAYERNAME(1)"), Value::Text("Q1".into()));
    assert_err!(eval_in(&w, 2, "Z1", "=LAYERNAME(9)"), CellError::Ref);
}

#[test]
fn prev_and_delta_on_first_layer() {
    let w = four_layers();
    assert_num!(eval_in(&w, 1, "Z1", "=PREV(B2)"), 100.0);
    assert_num!(eval_in(&w, 1, "Z1", "=DELTA(B2)"), 100.0);
    assert_err!(eval_in(&w, 0, "Z1", "=PREV(B2)"), CellError::Ref);
    assert_err!(eval_in(&w, 0, "Z1", "=DELTA(B2)"), CellError::Ref);
    // 惯用兜底写法
    assert_eq!(eval_in(&w, 0, "Z1", "=IFERROR(DELTA(B2),\"\")"), Value::Text("".into()));
}

#[test]
fn index_with_layer_argument() {
    let w = four_layers();
    // INDEX(cuboid, row, col, layer):第 3 个层、第 1 行、第 1 列
    assert_num!(eval_in(&w, 0, "Z1", "=INDEX(*!B2:B2,1,1,3)"), 300.0);
    assert_err!(eval_in(&w, 0, "Z1", "=INDEX(*!B2:B2,1,1,9)"), CellError::Ref);
}

#[test]
fn fill_across_layers_keeps_relative_offset() {
    let mut w = four_layers();
    set(&mut w, 1, "C2", "=L[-1]!B2*2");
    let src = at(&w, 1, "C2");
    for i in 2..4 {
        let dst = at(&w, i, "C2");
        w.copy_cell(src, dst).unwrap();
    }
    // 相对层偏移保持不变,各层解析到各自的上一层
    assert_num!(val(&w, 2, "C2"), 400.0);
    assert_num!(val(&w, 3, "C2"), 600.0);
    assert_eq!(w.input_text(at(&w, 3, "C2")), "=L[-1]!B2*2");

    // 绝对层引用不随填充变化
    set(&mut w, 1, "D2", "=Q1!B2");
    w.copy_cell(at(&w, 1, "D2"), at(&w, 3, "D2")).unwrap();
    assert_num!(val(&w, 3, "D2"), 100.0);
}

#[test]
fn fill_out_of_range_becomes_ref_error() {
    let mut w = four_layers();
    set(&mut w, 0, "B3", "=A3");        // 相对引用左边一列
    w.copy_cell(at(&w, 0, "B3"), at(&w, 0, "A3")).unwrap();   // 左移一列 -> 列 -1
    assert_eq!(w.input_text(at(&w, 0, "A3")), "=#REF!");
    assert_err!(val(&w, 0, "A3"), CellError::Ref);
}

#[test]
fn layer_move_redirties_layer_sensitive_cells() {
    let mut w = four_layers();
    set(&mut w, 3, "C2", "=L[-1]!B2");
    assert_num!(val(&w, 3, "C2"), 300.0);

    // 把 Q1 移到末尾:Q4 的上一层从 Q3 变成 Q3(顺序 Q2 Q3 Q4 Q1)
    let q1 = w.layer_by_name("Q1").unwrap();
    w.move_layer(q1, 3).unwrap();
    // Q4 现在在第 3 位,它的上一层是 Q3 = 300
    assert_num!(val(&w, 2, "C2"), 300.0);
    // 末尾的 Q1 没有 C2 公式
    assert_eq!(val(&w, 3, "C2"), Value::Empty);

    // 全层引用也要跟着变
    set(&mut w, 0, "E2", "=SUM(*!B2)");
    assert_num!(val(&w, 0, "E2"), 1000.0);
}
```

---

## M6 `.c3` 存档

`crates/cube3-io/tests/native.rs`

```rust
#[test]
fn c3_roundtrip_preserves_everything() {
    let mut w = /* 3 层,含公式、样式、隐藏层 */;
    let dir = std::env::temp_dir().join("cube3_test_roundtrip");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("a.c3");

    save_c3(&w, &path).unwrap();
    let loaded = load_c3(&path).unwrap();

    assert_eq!(loaded.layer_count(), w.layer_count());
    for i in 0..w.layer_count() {
        assert_eq!(loaded.layer_at(i).unwrap().name, w.layer_at(i).unwrap().name);
        assert_eq!(loaded.layer_at(i).unwrap().hidden, w.layer_at(i).unwrap().hidden);
    }
    // 公式文本与计算值都要一致
    assert_eq!(loaded.input_text(at(&loaded, 1, "C2")), w.input_text(at(&w, 1, "C2")));
    assert_eq!(loaded.value(at(&loaded, 1, "C2")), w.value(at(&w, 1, "C2")));
}

#[test]
fn c3_save_is_byte_stable() {
    let w = /* 任意工作簿 */;
    let p1 = /* tmp a.c3 */;  let p2 = /* tmp b.c3 */;
    save_c3(&w, &p1).unwrap();
    save_c3(&w, &p2).unwrap();
    assert_eq!(std::fs::read(&p1).unwrap(), std::fs::read(&p2).unwrap());
}

#[test]
fn input_text_roundtrip() {
    // 这些文本若不加前导单引号,重新加载时会被误判为公式/数字/布尔
    let mut w = wb(&["L1"]);
    for (i, s) in ["=1+1", "TRUE", "0123", "#N/A", "'已带引号", ""].iter().enumerate() {
        let a = at(&w, 0, &format!("A{}", i + 1));
        w.set_input(a, &format!("'{s}")).unwrap();
    }
    for i in 1..=6 {
        let a = at(&w, 0, &format!("A{i}"));
        let text = w.input_text(a);
        let before = w.value(a);
        let mut w2 = wb(&["L1"]);
        let a2 = at(&w2, 0, "A1");
        w2.set_input(a2, &text).unwrap();
        assert_eq!(w2.value(a2), before, "往返失败:{text}");
    }
}

#[test]
fn c3_broken_formula_loads_as_foreign() {
    // 手工改坏 JSON 里的一条公式,加载应当成功,该格成为 foreign + #PARSE!
    let path = /* 写一个 input 为 "=1+" 的 .c3 */;
    let loaded = load_c3(&path).unwrap();
    assert_eq!(loaded.value(at(&loaded, 0, "A1")), Value::Error(CellError::Parse));
}

#[test]
fn c3_version_mismatch_rejected() {
    let path = /* 写一个 "version": 999 的 .c3 */;
    assert!(matches!(load_c3(&path), Err(IoError::UnsupportedVersion(999, _))));
}
```

---

## M7 xlsx 与 CSV 互通

`crates/cube3-io/tests/xlsx.rs`。**fixture 由测试自己生成**,不提交二进制文件到仓库。

```rust
#[test]
fn xlsx_sheet_name_sanitized_and_formulas_follow() {
    // 生成一个 sheet 名为 "A1" 与 "My:Sheet" 的 xlsx,其中有公式 ='My:Sheet'!B2
    let path = make_xlsx_with_tricky_sheet_names();
    let rep = import_xlsx(&path).unwrap();
    assert_eq!(rep.renamed_layers.len(), 2);
    // 层名被清洗
    assert!(rep.workbook.layer_by_name("A1_").is_some());
    assert!(rep.workbook.layer_by_name("My_Sheet").is_some());
    // 公式里的层名也跟着改了
    assert!(rep.workbook.input_text(at(&rep.workbook, 0, "C1")).contains("My_Sheet"));
}

#[test]
fn xlsx_import_values_and_formulas() {
    let path = /* 2 个 sheet,含数字/文本/布尔/公式 */;
    let rep = import_xlsx(&path).unwrap();
    assert_eq!(rep.workbook.layer_count(), 2);
    assert_num!(rep.workbook.value(at(&rep.workbook, 0, "A1")), 42.0);
    // 原生可解析的公式重新求值后一致
    assert_num!(rep.workbook.value(at(&rep.workbook, 0, "B1")), 84.0);
    assert_eq!(rep.foreign_formulas, 0);
}

#[test]
fn xlsx_import_unknown_function_becomes_foreign() {
    let path = /* 含 =XLOOKUP(...) 且缓存值为 7 的 xlsx */;
    let rep = import_xlsx(&path).unwrap();
    assert_eq!(rep.foreign_formulas, 1);
    let a = at(&rep.workbook, 0, "A1");
    assert!(rep.workbook.cell(a).unwrap().is_foreign());
    assert_num!(rep.workbook.value(a), 7.0);              // 沿用缓存值
    assert!(rep.workbook.input_text(a).contains("XLOOKUP"));
}

#[test]
fn xlsx_export_expands_relative_layer_ref() {
    let mut w = wb(&["Jan", "Feb", "Mar"]);
    set(&mut w, 1, "B2", "=L[-1]!B2+1");
    let path = /* tmp */;
    export_xlsx(&w, &path).unwrap();
    // 重新读回,Feb!B2 的公式应当已展开为对 Jan 的具体引用
    let back = read_formula_text(&path, "Feb", "B2");
    assert_eq!(back, "=Jan!B2+1");
}

#[test]
fn xlsx_export_all_layers_ref_becomes_3d_ref() {
    let mut w = wb(&["Jan", "Feb", "Mar"]);
    set(&mut w, 0, "C1", "=SUM(*!B2)");
    let path = /* tmp */;
    export_xlsx(&w, &path).unwrap();
    assert_eq!(read_formula_text(&path, "Jan", "C1"), "=SUM(Jan:Mar!B2)");
}

#[test]
fn xlsx_export_devalues_layeridx_with_comment() {
    let mut w = wb(&["Jan", "Feb"]);
    set(&mut w, 1, "C1", "=LAYERIDX()*10");
    let path = /* tmp */;
    let rep = export_xlsx(&w, &path).unwrap();
    assert_eq!(rep.devalued_formulas.len(), 1);
    // 写入的是静态值 20,批注里保留原公式
    assert_eq!(read_cell_number(&path, "Feb", "C1"), 20.0);
    assert!(read_comment(&path, "Feb", "C1").contains("=LAYERIDX()*10"));
}

#[test]
fn xlsx_roundtrip_preserves_foreign_formula() {
    // 导入含 XLOOKUP 的文件 -> 改动别处 -> 导出 -> 再导入,XLOOKUP 原文仍在
    let rep = import_xlsx(&make_xlsx_with_xlookup()).unwrap();
    let mut w = rep.workbook;
    set(&mut w, 0, "Z9", "1");
    let out = /* tmp */;
    export_xlsx(&w, &out).unwrap();
    let again = import_xlsx(&out).unwrap();
    assert!(again.workbook.input_text(at(&again.workbook, 0, "A1")).contains("XLOOKUP"));
}

#[test]
fn csv_import_export_roundtrip() {
    let mut w = wb(&["L1"]);
    let csv = "a,b\n1,2\n=1+1,\"含,逗号\"\n";
    /* 写入临时 csv */
    import_csv(&mut w, &csv_path, "Imported").unwrap();
    let li = w.layer_index(w.layer_by_name("Imported").unwrap()).unwrap();
    assert_num!(val(&w, li, "A3"), 2.0);                    // CSV 里的公式被解析
    assert_eq!(val(&w, li, "B3"), Value::Text("含,逗号".into()));

    export_csv(&w, w.layer_by_name("Imported").unwrap(), &out_path).unwrap();
    let text = std::fs::read_to_string(&out_path).unwrap();
    assert!(text.contains("\"含,逗号\""));                  // 逗号被正确转义
    assert!(text.contains("\n2,"));                          // 公式导出为计算值
}
```

---

## M8 TUI(手工验收清单)

自动化测试只覆盖三个纯函数模块:

```rust
#[test] fn key_to_action_mapping() { /* input.rs:按键 -> Action */ }
#[test] fn command_parsing()       { /* command.rs:":layer move 3" -> Command::LayerMove(3) */ }
#[test] fn display_width_cjk()     { /* "中文abc" 显示宽度 = 7,不是 6 也不是 9 */ }
```

其余逐条手工勾选:

**基础编辑**
- [ ] 启动后能看到网格、层标签、状态栏;`Ctrl+Q` 能干净退出且终端未被弄乱
- [ ] 方向键移动光标,地址框同步更新
- [ ] 直接键入字符进入编辑,`Enter` 提交并下移,`Esc` 取消且内容不变
- [ ] `F2` 进入编辑且保留原内容
- [ ] 输入 `=1+` 提交,停留在编辑模式,状态栏红字显示位置与原因,内容未丢
- [ ] `Ctrl+←/→/↑/↓` 跳到数据块边缘;`Ctrl+Home`/`Ctrl+End` 正确

**三维**
- [ ] `Ctrl+PgUp`/`Ctrl+PgDn`(以及 `Alt+↑/↓`)切层,标签条高亮跟随
- [ ] 层数多到放不下时,标签条能滚动且当前层始终可见
- [ ] `Shift+方向` 选区,状态栏显示 `和/均/数`
- [ ] `Ctrl+Shift+PgUp/PgDn` 形成跨层选区,地址框显示 `×N层`,统计覆盖全部层
- [ ] `Ctrl+L` 跨层填充:在一层写 `=L[-1]!B2+1`,填到其余层后每层结果各自正确

**深度视图**
- [ ] `F3` 打开面板,显示当前 `(行,列)` 在所有层的值,当前层高亮
- [ ] 移动网格光标,面板内容立即跟随
- [ ] 面板中公式格有 `▸` 标记,空格显示 `——`,错误值显示红色
- [ ] 面板聚焦后 `↑/↓` 切层,`Enter` 就地编辑其它层的该格,提交后网格同步更新
- [ ] `Esc` 回到网格且面板保持打开;再按 `F3` 关闭

**命令与文件**
- [ ] `Ctrl+P` 打开命令行,`Tab` 能补全命令名,`↑/↓` 翻历史
- [ ] `:layer add/del/rename/move/dup/hide` 全部生效,标签条同步
- [ ] 只剩一层时 `:layer del` 报错而非崩溃
- [ ] `:w` / `:e` 存取正常;有未保存改动时 `:e` 拒绝,`:e!` 强制
- [ ] `:import xlsx` 后显示导入报告摘要,`:report` 能看到明细
- [ ] `:export xlsx` 后用 Excel 或 LibreOffice 打开,跨层公式仍是活公式
- [ ] `:fmt fixed:2` / `:align right` / `:bold on` / `:width 20` 对选区生效
- [ ] 未知命令给出提示且不退出命令行

**显示**
- [ ] 中文表头对齐正确(用 `unicode-width`,不是字符数)
- [ ] 数字放不下显示 `####`;文本放不下截断为 `…`,右邻为空时允许溢出
- [ ] 1000 行的层滚动流畅,无明显卡顿
- [ ] 制造一个 panic(临时代码)验证终端被正确还原

---

## 覆盖率检查

M9 结束时,用一次 `cargo llvm-cov`(或 `cargo tarpaulin`)确认 `cube3-core` 的行覆盖率
**不低于 80%**。这不是硬性门槛,而是用来发现"整块没测到"的区域 ——
若某个函数分类整体未覆盖,补测;若只是错误分支未覆盖,可接受。
