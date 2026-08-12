# AGENTS.md — 本仓库的工作约定

## 当前任务

实现 **cube3**:一个三维电子表格(层 × 行 × 列),Rust 编写,核心库 + 终端 TUI,
支持与 `.xlsx` 双向互通。

**完整规格在 [`docs/spec/`](docs/spec/README.md),开工前先通读
[`docs/spec/README.md`](docs/spec/README.md) 与
[`docs/spec/01-overview.md`](docs/spec/01-overview.md)。**
执行主干是 [`docs/spec/07-milestones.md`](docs/spec/07-milestones.md) 的 M0–M9。

## 仓库里已有的 JS 文件与本任务无关

根目录的 `manifest.json` / `background.js` / `content.js` / `content.css` /
`popup.*` / `options.*` 属于一个早期的 Chrome 扩展,与 cube3 无关。
**不要修改、不要删除、不要重构它们。** Rust 工作区在根目录的 `Cargo.toml` +
`crates/` 下新建,与它们并存。

## 分支

在 `claude/3d-excel-spec-9g10tj` 上开发。不要直接推 `main`。

## 目录

```
Cargo.toml               workspace 根
crates/cube3-core/       数据模型 + 公式引擎(零 IO)
crates/cube3-io/         .c3 存档 + xlsx + csv
crates/cube3-tui/        二进制 cube3
docs/spec/               规格书(实现依据,改动前先说明理由)
examples/                示例工作簿(M9)
```

crate 依赖方向单向:`cube3-tui → cube3-io → cube3-core`。不得成环。

## 常用命令

```bash
cargo build --workspace
cargo test  --workspace
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p cube3-tui -- examples/12-months.c3
```

**每个里程碑结束时,上面前四条必须全绿才算完成。**

## 代码风格

- Rust edition 2021,MSRV 1.80(`std::sync::LazyLock`)
- `rustfmt.toml`:`max_width = 100`,其余用默认;提交前跑 `cargo fmt`
- **`cube3-core` 的非测试代码里不允许 `unwrap()` / `expect()` / `panic!()`**。
  唯一例外是能在注释里论证的内部不变量,且必须写成 `expect("<不变量说明>")`
- 公开 API 一律带 doc comment。注释写"为什么",不写"做了什么"
- 错误类型用 `thiserror`;二进制里(`cube3-tui`)可以用 `anyhow`
- 错误信息面向用户,用中文;代码标识符、类型名、函数名一律英文
- 测试名用英文 snake_case,断言的失败信息用中文

## 依赖纪律

只用 [`docs/spec/07-milestones.md` M0](docs/spec/07-milestones.md#m0-项目脚手架) 列出的依赖。
需要新依赖时先说明理由。特别地,以下是**刻意不引入**的,不要"顺手加上":

| 不要引入 | 原因 |
|---|---|
| `nom` / `pest` / `chumsky` | 公式解析器必须手写,为了精确的错误位置与 Excel 的怪异优先级 |
| `petgraph` | 依赖图就是两个 `HashMap` + 二十行 Kahn 算法 |
| `crossterm`(直接依赖) | 用 `ratatui::crossterm` 的再导出,避免版本错配 |
| `chrono` / `time` | MVP 没有日期类型 |

## 规格与实现不一致时

1. 规格里的 Rust 签名是契约 —— 优先按规格实现
2. 若某个签名确实不可行(借用检查、API 现实),**改它,并在提交说明里写清楚改了什么、
   为什么**(下游文档引用了这些名字)
3. 规格没写到的边界行为,**一律向 Excel 对齐**,并在实现处写一行注释说明依据
4. Excel 行为本身也不明确时,选最简单的实现,加 `// TODO(spec-gap):` 注释,
   不要自行发明复杂规则

## 提交

- 一个里程碑一个(或几个)提交,提交信息说明完成了哪个里程碑、验收测试是否全绿
- 提交信息用中文或英文均可,首行 ≤ 72 字符
- 不要提交 `target/`、临时 xlsx/csv 产物(测试 fixture 由测试代码自己生成)
- 不要在提交信息、代码注释或任何入库产物里写入模型名称或工具标识

## 三个最容易做错的地方

规格里反复强调过,这里再列一遍:

1. **Excel 的运算符优先级是反直觉的** —— `^` 左结合(`2^3^2 = 64`),一元负号比 `^` 更紧
   (`-2^2 = 4`)。不要"修正"成常规数学写法
2. **层区间越界要裁剪,单点越界要报 `#REF!`** —— 两条规则不同。裁剪是滚动窗口
   (`SUM(L[-2]:L[0]!B2)`)能用起来的前提
3. **文本函数按 Unicode 字符切分,TUI 按显示宽度排版** —— 按字节切会切坏中文,
   按字符数排版会把中文表头撑歪(要用 `unicode-width`)
