# minesweeper3d — 三维扫雷

Rust + bevy 实现的三维扫雷。雷区是一个 `X × Y × Z` 的立方体格阵，每格的邻居是 3×3×3
减去自身，共 **26 个**。

> **当前状态：仅有规格书，代码尚未实现。**
> 完整规格见 [`../docs/3d-minesweeper-spec.md`](../docs/3d-minesweeper-spec.md)，
> 实现前请先完整阅读，尤其是其中关于 bevy 版本与 API 查证的 2.2 节。

## 计划中的结构

```
minesweeper3d/
  crates/core/   # msweeper_core —— 纯规则逻辑，不依赖 bevy，可独立测试
  crates/app/    # msweeper_app —— bevy 前端，二进制名 minesweeper3d
```

## 构建与运行（实现完成后）

```bash
cd minesweeper3d

# 只测规则逻辑，编译很快，不需要 GPU
cargo test -p msweeper_core

# 运行游戏（需要有显示器和 GPU 的机器）
cargo run -p msweeper_app -- --difficulty easy
cargo run -p msweeper_app -- --dims 7,7,7 --mines 40 --seed 12345
```

## 操作

| 输入 | 行为 |
|---|---|
| 左键 | 翻开格子 |
| 右键点击 | 插旗 / 取消旗 |
| 右键拖拽 | 旋转视角 |
| 滚轮 | 缩放 |
| `F` | 复位视角 |
| `[` / `]` | 剖切：调整可见层上界 |
| `Shift+[` / `Shift+]` | 剖切：调整可见层下界 |
| `\` | 恢复全部层可见 |
| `R` | 重开一局 |
| `Esc` | 退出 |

## 难度预设

| 难度 | 尺寸 | 格数 | 雷数 |
|---|---|---|---|
| easy | 5×5×5 | 125 | 10 |
| medium（默认） | 7×7×7 | 343 | 40 |
| hard | 9×9×9 | 729 | 99 |

## 注意

- 本仓库根目录的其他文件属于一个无关的 Chrome 插件项目，与本游戏互不影响。
- 开发容器通常没有显示器和 GPU，因此 CI 只做 `cargo build` / `cargo test -p msweeper_core`；
  图形与交互需要在本地机器上人工验证。
