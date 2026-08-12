# 07 — 里程碑与执行清单

这是**执行主干**。按 M0 → M9 顺序推进,不要跳跃。每个里程碑的"完成判据"全部满足后,
才开始下一个。

每个里程碑结束时都必须跑通:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

验收测试的完整代码见 [08-acceptance-tests.md](08-acceptance-tests.md)。

---

## M0 项目脚手架

**产出**

```
Cargo.toml                       # workspace 根
crates/cube3-core/Cargo.toml
crates/cube3-core/src/lib.rs
crates/cube3-io/Cargo.toml
crates/cube3-io/src/lib.rs
crates/cube3-tui/Cargo.toml
crates/cube3-tui/src/main.rs
.gitignore                       # /target, *.xlsx 测试产物
rustfmt.toml                     # max_width = 100,其余用默认
.github/workflows/ci.yml
```

**workspace 配置**

- `edition = "2021"`,`rust-version = "1.80"`(`std::sync::LazyLock` 需要)
- workspace 级 `[workspace.dependencies]` 统一版本,子 crate 用 `workspace = true` 引用

**依赖清单**(已于 2026-08-12 对 crates.io 核实;写 `Cargo.toml` 时用同一 minor 系列即可)

| crate | 版本 | 用在哪 | 用途 |
|---|---|---|---|
| `thiserror` | 2.0 | core, io | 错误类型派生 |
| `serde` | 1.0 | core(可选特性), io | 序列化派生 |
| `serde_json` | 1.0 | io | `.c3` 格式 |
| `calamine` | 0.36 | io | 读 xlsx |
| `rust_xlsxwriter` | 0.97 | io | 写 xlsx |
| `ratatui` | 0.30 | tui | 终端界面 |
| `unicode-width` | 0.2 | tui | CJK 显示宽度 |
| `anyhow` | 1.0 | tui | 二进制里的错误汇总 |

**不要引入的依赖:**

- ❌ `petgraph` —— 依赖图就是两个 `HashMap` 加二十行 Kahn 算法(见 [04 §4.5](04-engine.md#45-依赖图)),
  引图库反而更绕
- ❌ `nom` / `pest` / `chumsky` —— 解析器必须手写,理由见 [04 §4.3](04-engine.md#为什么手写解析器)
- ❌ `crossterm` 作为直接依赖 —— 用 `ratatui::crossterm` 的再导出,避免版本错配
- ❌ `chrono` / `time` —— MVP 没有日期类型

**crate 间依赖方向**(单向,不得成环):`cube3-tui → cube3-io → cube3-core`。
`cube3-core` 只依赖 `thiserror` 与可选的 `serde`。

**`cube3-core` 的 serde 特性**

```toml
[features]
default = []
serde = ["dep:serde"]
```

`cube3-io` 以 `cube3-core = { workspace = true, features = ["serde"] }` 引用。

**CI**(`.github/workflows/ci.yml`):在 `ubuntu-latest` + stable 上跑上面那三条命令,
带 `Swatinem/rust-cache` 或等价的 cargo 缓存。

**完成判据**
- `cargo build --workspace` 成功
- `cargo test --workspace` 成功(此时零个测试也算通过)
- `cargo run -p cube3-tui` 能启动并立即退出(先放一个打印版本号的 `main`)

---

## M1 数据模型

**依赖** M0
**产出** `cube3-core` 的 `addr.rs` `value.rs` `cell.rs` `grid.rs` `layer.rs` `style.rs` `error.rs` `workbook.rs`
**规格** [02-data-model.md](02-data-model.md)

此阶段**没有公式** —— `set_input` 遇到 `=` 开头的输入时,暂时返回
`Err(ModelError::Parse(...))`,M2 再接上解析器。

要点:

1. `addr.rs` 的 A1 转换必须处理三字母列(`AA`=26,`XFD`=16383)与越界
2. `Rect::from_corners` 必须归一化;`Cuboid::iter` 的顺序是 **层→行→列**
3. `SparseGrid::iter_rect` 的双路径实现(见 [02 §2.4](02-data-model.md#24-稀疏网格))
4. 层名校验集中在 `validate_layer_name`
5. `move_layer` / `rename_layer` 后 `LayerId` 不变
6. `StyleTable` 做驻留

**验收测试** [08 §M1](08-acceptance-tests.md#m1-数据模型):
`a1_roundtrip`、`col_letters_boundaries`、`rect_normalizes_corners`、`cuboid_iter_order`、
`layer_name_validation`、`layer_rename_and_move_keep_id`、`remove_last_layer_rejected`、
`sparse_grid_used_range`、`input_interpretation`、`style_interning`

**完成判据** 上述测试全绿;`cube3-core` 中无 `unwrap`/`expect`/`panic!`(测试代码除外)

---

## M2 词法与语法分析

**依赖** M1
**产出** `formula/ast.rs` `formula/lexer.rs` `formula/parser.rs`
**规格** [03 §3.2–3.3](03-formula-language.md#32-词法) + [04 §4.1–4.3](04-engine.md#41-ast)

要点:

1. 优先级表照抄 [04 §4.3](04-engine.md#43-解析器) 的 `binding_power`,**不要"修正"** `^` 的
   左结合与一元负号的高优先级
2. 词法器的三个坑(`#` 二义、A1 与标识符、`L[k]` 不容空白)见 [04 §4.2](04-engine.md#词法器的三个坑)
3. `parse_reference()` 的两记号前瞻单独成函数
4. `Expr::to_source` 与解析互为逆运算(幂等)
5. `ParseError` 带字节位置

此阶段**不求值**,`set_input` 把解析出的 AST 存进 `Cell`,`value` 先填 `Value::Empty`。

**验收测试** [08 §M2](08-acceptance-tests.md#m2-词法与语法分析):
`lex_basic_tokens`、`lex_hash_ambiguity`、`lex_a1_vs_ident`、`lex_layer_rel_no_space`、
`parse_precedence_table`、`power_is_left_associative`、`unary_minus_binds_tighter_than_power`、
`percent_postfix`、`parse_all_reference_forms`、`parse_error_reports_position`、
`nesting_depth_limit_rejected`、`to_source_roundtrip_is_idempotent`、`dollar_on_layer_rejected`

**完成判据** 上述测试全绿

---

## M3 求值与函数库

**依赖** M2
**产出** `formula/eval.rs`、`formula/functions/{mod,math,logic,text,lookup}.rs`
**规格** [03 §3.4–3.5](03-formula-language.md#34-求值语义) + [04 §4.4](04-engine.md#44-求值器)

此阶段只做**当前层**的引用(`LayerSel::Current`)与单层区域;三维引用留到 M5。
重算走 `recalc_all()` 全量路径,依赖图留到 M4。

要点:

1. `Operand` / `eval_scalar` / `eval_values` 三个辅助函数先写好,函数实现全部基于它们
2. 类型强转与错误传播照 [02 §2.2](02-data-model.md#类型强转规则与-excel-一致)
3. 45 个非层向函数全部实现(层向 7 个在 M5)
4. `MOD` 的符号、`ROUND` 的远离零舍入、文本函数按字符切分 —— 三个高危点
5. `all_functions_have_tests` 这个元测试要在本阶段建立

**验收测试** [08 §M3](08-acceptance-tests.md#m3-求值与函数库):
`arith_and_coercion`、`empty_cell_semantics`、`error_propagation_order`、
`comparison_cross_type_order`、`mod_follows_divisor_sign`、`round_half_away_from_zero`、
`int_floors_negatives`、`text_functions_are_char_based`、`sumif_criteria_forms`、
`if_lazily_evaluates_branches`、`and_or_do_not_short_circuit`、`vlookup_and_match`、
`scalar_position_rejects_multi_cell_range`、`unknown_function_parses_but_evals_to_name_error`、
`all_functions_have_tests`

**完成判据** 上述测试全绿;`FUNCTIONS` 表含 45 个非层向函数

---

## M4 依赖图与增量重算

**依赖** M3
**产出** `engine/depgraph.rs` `engine/recalc.rs`;`Workbook` 接上增量路径
**规格** [04 §4.5–4.6](04-engine.md#45-依赖图)

要点:

1. `DepGraph::register` 幂等(内部先 `unregister`)
2. 区域依赖用 `Vec<(Cuboid, Addr)>` 线性扫描 —— **这是有意的,不要提前优化**
3. Kahn 算法剩余节点 ⇒ `#CIRC!`
4. `recalc_all()` = 全部标脏 + 走同一条增量路径,**不写第二套求值实现**
5. 增量性要可验证:用一个测试专用的求值计数器(`#[cfg(test)]` 的原子计数)统计本次
   重算求值了几个格

**验收测试** [08 §M4](08-acceptance-tests.md#m4-依赖图与增量重算):
`dependency_registered_and_unregistered`、`incremental_recalc_touches_only_dependents`、
`long_chain_recalc_order`、`circular_reference_detected`、`self_reference_detected`、
`range_dependency_triggers_on_new_cell`、`clearing_cell_updates_dependents`

**完成判据** 上述测试全绿

---

## M5 三维引用与层向函数

**依赖** M4
**产出** `resolve_ref` 全功能、`formula/functions/layer.rs`、`Workbook::copy_cell` 的引用重写
**规格** [03 §3.1](03-formula-language.md#31-引用语法) + [03 §3.6](03-formula-language.md#36-复制与填充时的引用重写)

**这是整个项目的核心里程碑。** 要点:

1. `resolve_ref` 独立可测,覆盖全部 `LayerSel` 变体
2. **层区间越界裁剪**、**单点越界报 `#REF!`** —— 两条规则不同,必须分别测
3. 7 个层向函数;`LAYERSUM` 等直接改写成 `SUM(*!R)` 复用,不写两套
4. `PREV` / `DELTA` 在第一层返回 `#REF!`
5. `copy_cell` 的三轴引用重写 + 越界变 `Expr::RefError`
6. `DepGraph::layer_sensitive` 与层操作的重算触发([04 §4.6](04-engine.md#何时标脏))

**验收测试** [08 §M5](08-acceptance-tests.md#m5-三维引用与层向函数):
`resolve_all_layer_selector_forms`、`relative_layer_ref_resolves_per_layer`、
`layer_range_clamps_at_boundary`、`single_relative_layer_ref_out_of_range_is_ref_error`、
`cuboid_flatten_order_is_layer_row_col`、`layer_functions_match_star_ref`、
`prev_and_delta_on_first_layer`、`index_with_layer_argument`、
`fill_across_layers_keeps_relative_offset`、`fill_out_of_range_becomes_ref_error`、
`layer_move_redirties_layer_sensitive_cells`、`rolling_window_across_layers`

**完成判据** 上述测试全绿。此时 `cube3-core` 功能完整,**可以独立当库用**。

---

## M6 `.c3` 存档

**依赖** M5
**产出** `cube3-io` 的 `native.rs` `error.rs`;`cube3-core` 的 `WorkbookBuilder` 与 serde 特性
**规格** [05 §5.1](05-persistence.md#51-c3-存档格式)

要点:

1. `input_text` 的往返保证(边界文本加前导单引号)
2. `WorkbookBuilder` 批量构建,加载时只重算一次
3. `cells` 按 `(r, c)` 升序写出 ⇒ 字节稳定
4. 坏公式降级为 `foreign`,不让整个文件打不开

**验收测试** [08 §M6](08-acceptance-tests.md#m6-c3-存档):
`c3_roundtrip_preserves_everything`、`c3_save_is_byte_stable`、`input_text_roundtrip`、
`c3_broken_formula_loads_as_foreign`、`c3_version_mismatch_rejected`

**完成判据** 上述测试全绿

---

## M7 xlsx 与 CSV 互通

**依赖** M6
**产出** `xlsx_import.rs` `xlsx_export.rs` `translate.rs` `csv.rs`
**规格** [05 §5.2–5.5](05-persistence.md#52-层--worksheet-的映射)

要点:

1. sheet 名清洗**先做完再翻译公式**(建映射表)
2. 公式翻译在 **AST 上**做,不做文本替换
3. 未知函数 ⇒ `foreign`,保留原文 + 缓存值,导出时原样写回
4. 导出时相对层引用**展开为具体 sheet 引用**;`*!` 与层区间 ⇒ Excel 3D 引用
   (仅限白名单函数内)
5. 无法翻译 ⇒ 静态值 + 批注保留原公式 + 记入 `ExportReport`

测试用的 xlsx fixture 由**测试代码自己用 `rust_xlsxwriter` 生成**,不往仓库里提交二进制文件。

**验收测试** [08 §M7](08-acceptance-tests.md#m7-xlsx-与-csv-互通):
`xlsx_sheet_name_sanitized_and_formulas_follow`、`xlsx_import_values_and_formulas`、
`xlsx_import_unknown_function_becomes_foreign`、`xlsx_export_expands_relative_layer_ref`、
`xlsx_export_all_layers_ref_becomes_3d_ref`、`xlsx_export_devalues_layeridx_with_comment`、
`xlsx_roundtrip_preserves_foreign_formula`、`csv_import_export_roundtrip`

**完成判据** 上述测试全绿

---

## M8 TUI

**依赖** M7
**产出** `cube3-tui` 全部模块
**规格** [06-tui.md](06-tui.md)

建议实现顺序(每步都能跑起来看见东西,便于调试):

1. 终端初始化 + RAII 还原 + panic hook + 空白四区布局
2. 网格渲染(只渲染视口)+ 光标移动
3. 地址框 + 公式栏 + 状态栏
4. 编辑模式(提交/取消/解析错误提示)
5. 层标签条 + 切层
6. 选区(含跨层)+ 状态栏聚合统计
7. 剪贴板 + 撤销栈 + 三向填充(`Ctrl+D`/`Ctrl+R`/`Ctrl+L`)
8. 命令行 + 全部命令
9. **深度视图**(含聚焦编辑)
10. 帮助浮层 + 鼠标点击定位

要点:

- `unicode-width` 算显示宽度,中文表头必须对齐
- panic hook 里还原终端
- 纯函数部分(按键映射、命令解析、宽度计算)要有单元测试

**验收** [08 §M8](08-acceptance-tests.md#m8-tui手工验收清单) 的手工清单逐条勾选,
外加三组纯函数单元测试:`key_to_action_mapping`、`command_parsing`、`display_width_cjk`

**完成判据** 手工清单全部通过;单元测试全绿

---

## M9 打磨与收尾

**依赖** M8
**产出** 基准测试、README、示例文件

1. **基准**:`crates/cube3-core/benches/recalc.rs` 或一个集成测试,构造 10 层 × 1000 行 × 26 列,
   验证单次编辑的增量重算 < 50 ms([01 G8](01-overview.md#14-目标mvp-必须做到))。
   若不达标,先查是不是退化成全量重算,再看 `dependents_of` 的线性扫描是否成为瓶颈
   (占比 > 30% 才考虑换数据结构)
2. **示例**:`examples/12-months.c3` —— 12 个月份层,含 `L[-1]!`、`DELTA`、`SUM(*!B2)` 的
   真实用例;另附由它导出的 `examples/12-months.xlsx` 生成脚本
3. **文档**:仓库根 `README.md` 增加 cube3 章节(安装、快速上手、按键速查表);
   所有公开 API 加 doc comment,`cargo doc --no-deps` 无警告
4. **清理**:处理所有 `TODO(spec-gap)`;`cargo clippy -- -D warnings` 在 pedantic 级别下
   过一遍并有选择地修

**可选的加分项**(做完上面还有余力再做,不做也算 M9 完成):

- 命名区域(Defined Names):`:name add 名字 引用`,公式里直接用名字
- 更多数字格式(科学记数法、自定义格式串)
- `SUMIFS` / `COUNTIFS` / `XLOOKUP`

**完成判据** 基准达标(或有书面结论说明为何达不到及下一步);示例文件可打开;
`cargo doc` 无警告;CI 全绿

---

## 依赖关系总览

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5 ──▶ M6 ──▶ M7 ──▶ M8 ──▶ M9
                                    ▲
                            核心价值在这里
```

M5 完成时 `cube3-core` 就是一个可用的三维表格计算库;M7 完成时可以做无界面的批处理转换;
M8 才是给人用的产品。**如果时间不够,宁可 M0–M5 做扎实,也不要为了看见界面而跳过 M4。**
