# 三维扫雷规格书 (3D Minesweeper Spec)

版本：v1.0
目标实现方：Codex
语言/引擎：Rust + [bevy](https://bevyengine.org/)

本文档是**实现规格**，不是建议。第 3 节的公开 API 签名、第 4 节的规则、第 8 节的
测试用例均为硬性要求，命名与行为不得擅自改动。第 5 节（bevy 前端）只规定**行为契
约**，具体调用方式由实现方查证当前 bevy 版本的真实 API 决定。

---

## 1. 目标与非目标

### 1.1 目标

一个单机的三维扫雷游戏：

- 雷区是 `X × Y × Z` 的立方体格阵（默认正方体）。
- 每个格子的"邻居"是 3×3×3 减去自身，共 **26 个方向**（含面邻接、棱邻接、角邻接）。
- 真 3D 桌面窗口：轨道相机可自由旋转、缩放观察整个立方体。
- 可按层剖切隐藏外壳，看到内部格子。
- 左键翻开、右键插旗，规则与经典扫雷一致，只是维度从 2 升到 3。
- 首次点击保证安全，必定展开一片空腔。

### 1.2 非目标（v1 明确不做）

以下功能**不要实现**，不要"顺手加上"：

- 和弦点击（chord / 双键快开）
- 问号标记（`?`）
- 计时器、最佳成绩、排行榜
- 存档 / 读档
- 音效、背景音乐
- 网络对战、多人
- 非立方体形状的雷区（球形、异形、环绕拓扑）
- WASM / 移动端构建
- 自动求解器、提示功能

如实现过程中认为某项非目标是必需的，先停下来在 PR 描述里提出，不要直接写进代码。

---

## 2. 工程结构

Rust workspace 放在仓库子目录 `minesweeper3d/` 下，**不要动仓库根目录已有的 Chrome
插件文件**（`manifest.json`、`content.js` 等与本项目无关）。

```
minesweeper3d/
  Cargo.toml              # [workspace]，members = ["crates/core", "crates/app"]
  Cargo.lock              # 提交进版本库
  .gitignore              # target/
  README.md               # 构建与运行说明
  crates/
    core/
      Cargo.toml          # package.name = "msweeper_core"
      src/lib.rs
      src/board.rs
      src/geom.rs
      tests/              # 或 #[cfg(test)] mod tests，二选一即可
    app/
      Cargo.toml          # package.name = "msweeper_app"，bin 名 "minesweeper3d"
      src/main.rs
      src/cli.rs
      src/grid.rs         # 格子实体的生成与视觉同步
      src/camera.rs       # 轨道相机
      src/interaction.rs  # 拾取与输入
      src/hud.rs
      src/palette.rs      # 颜色映射
```

### 2.1 依赖约束（硬性）

- `msweeper_core` 的依赖**只允许** `rand`。不得依赖 bevy、不得依赖任何图形、窗口、
  文件 IO、日志、异步运行时。目的是让规则逻辑 100% 可单元测试，且编译只要几秒。
- `msweeper_app` 依赖 `bevy` 与 `clap`，以及 `msweeper_core`。
- workspace 根 `Cargo.toml` 用 `[workspace.dependencies]` 统一版本。
- Rust edition 2021 或更高（本机工具链为 1.94，任选）。

### 2.2 bevy 版本与 API 查证（重要，请先读完再动手）

截至本规格书编写时，crates.io 上 bevy 的最新版本是 **0.19.0**（`cargo search bevy`
实测）。

> **警告**：bevy 的 API 在 0.1x 系列的各个小版本之间变动很大——组件名、插件名、
> 事件与观察者（observer）机制、拾取（picking）子系统、材质与可见性 API 都经历过
> 重命名或重构。网上绝大多数三维教程针对的是 0.12~0.15，**照抄会编译不过**。

因此实现时必须：

1. 在 `Cargo.toml` 中固定一个具体版本（推荐 `bevy = "0.19"`）。
2. 动手写业务代码之前，先执行 `cargo doc -p bevy --no-deps --open`，或直接阅读
   `~/.cargo/registry/src/*/bevy-<version>/` 下的源码，确认以下几件事在该版本里的
   **真实**名称与用法：
   - 如何添加默认插件、如何开窗
   - 3D 相机、方向光/环境光的组件构成
   - 网格（cuboid mesh）与标准材质的创建，以及如何做半透明
   - 如何隐藏/显示一个实体（可见性组件）
   - 鼠标按键、滚轮、键盘输入的读取方式
   - **网格拾取（mesh picking）是否内置、插件叫什么、点击事件如何监听**
   - UI 文本节点的创建方式，以及是否需要显式启用默认字体特性
3. 先用 bevy 自带 examples 里最接近的一个跑通最小可运行程序（一个立方体 + 相机 +
   点击），再往上叠本项目的逻辑。
4. 如果 `0.19` 出现无法绕开的问题（例如系统依赖缺失），可降级到能跑通的最新
   `0.1x`，但必须在 PR 描述里写明降级原因与最终版本号。

**不要**在代码里写下你"记得"的 bevy API，一律以本地文档/源码为准。

---

## 3. 核心库 `msweeper_core` 的公开 API

以下签名为硬性要求。字段私有，通过方法访问。

```rust
/// 雷区尺寸。三个维度都必须 >= 2。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dims {
    pub x: u8,
    pub y: u8,
    pub z: u8,
}

/// 格子坐标，原点在 (0,0,0)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Pos {
    pub x: u8,
    pub y: u8,
    pub z: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellState {
    Hidden,
    Flagged,
    Revealed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameState {
    /// 已创建但还没有第一次点击（此时尚未布雷）。
    Ready,
    Playing,
    Won,
    Lost,
}

/// 前端读取单个格子时看到的信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellView {
    pub state: CellState,
    /// 26 邻域内的雷数，范围 0..=26。仅当 state == Revealed 时有意义，
    /// 其余情况下实现方可返回真实值，前端不得使用（不得据此作弊）。
    pub adjacent: u8,
    /// 该格是否是雷。仅当 GameState 为 Lost 或 Won 时返回真实值，
    /// 否则一律返回 false。
    pub is_mine: bool,
}

/// 一次 reveal 的结果，供前端做增量更新。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealOutcome {
    /// 本次调用中新翻开的所有格子（含洪泛展开的全部格子）。
    /// 若本次踩雷，则包含被引爆的雷以及因败局而一并揭示的所有雷。
    pub revealed: Vec<Pos>,
    /// 被点中的雷；没踩雷则为 None。
    pub hit_mine: Option<Pos>,
    /// 本次操作之后的游戏状态。
    pub state: GameState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardError {
    /// 坐标超出雷区范围。
    OutOfBounds(Pos),
    /// 尺寸非法（任一维 < 2）。
    DimsTooSmall(Dims),
    /// 雷数超过上限，max 为该尺寸下允许的最大雷数。
    TooManyMines { requested: usize, max: usize },
    /// 雷数为 0（无意义的局面）。
    NoMines,
    /// 游戏已结束，不接受进一步操作。
    GameOver,
}

pub struct Board { /* 私有字段 */ }

impl Board {
    /// 创建雷区。此时**不布雷**，state == Ready。
    pub fn new(dims: Dims, mines: usize, seed: u64) -> Result<Board, BoardError>;

    /// 翻开一个格子。第一次调用时才真正布雷（首点安全，见 4.3）。
    pub fn reveal(&mut self, pos: Pos) -> Result<RevealOutcome, BoardError>;

    /// 切换旗标：Hidden <-> Flagged。对 Revealed 的格子无效果，
    /// 返回该格切换后的状态。
    pub fn toggle_flag(&mut self, pos: Pos) -> Result<CellState, BoardError>;

    pub fn state(&self) -> GameState;
    pub fn dims(&self) -> Dims;
    pub fn seed(&self) -> u64;
    pub fn cell(&self, pos: Pos) -> Result<CellView, BoardError>;

    pub fn mines_total(&self) -> usize;
    pub fn flags_placed(&self) -> usize;
    pub fn revealed_count(&self) -> usize;

    /// 该格子的全部合法邻居（26 邻域，越界裁剪），顺序不作要求。
    pub fn neighbors(&self, pos: Pos) -> impl Iterator<Item = Pos> + '_;

    /// 该尺寸下允许的最大雷数，等于 total_cells - 27（见 4.4）。
    pub fn max_mines(dims: Dims) -> usize;
}
```

### 3.1 内部存储

- 一维 `Vec`，索引公式固定为：

  ```
  idx = (z as usize * dims.y as usize + y as usize) * dims.x as usize + x as usize
  ```

- 每格至少需要：是否是雷、`CellState`、`adjacent` 计数。可以用一个 `Cell` 结构体的
  `Vec`，也可以用三个平行 `Vec`，实现方自选。
- `adjacent` 在布雷完成后一次性全量计算并缓存，不要每次查询现算。

---

## 4. 游戏规则（硬性）

### 4.1 邻域定义

`p` 的邻居 = 所有满足 `Δx, Δy, Δz ∈ {-1, 0, 1}` 且不全为 0、且落在雷区范围内的格
子。因此：

| 格子位置 | 邻居数 |
|---|---|
| 角（3 个维度都在边界） | 7 |
| 棱（2 个维度在边界） | 11 |
| 面（1 个维度在边界） | 17 |
| 内部 | 26 |

`adjacent` 的取值范围是 `0..=26`。

### 4.2 坐标系与朝向

- `x` 向右，`y` 向上，`z` 朝向观察者（右手系，与 bevy 默认一致）。
- 格子 `(x, y, z)` 的世界坐标中心 = `(x, y, z) * SPACING - center_offset`，其中
  `SPACING = 1.1`（立方体边长 1.0 + 间隙 0.1），`center_offset` 使整个阵列的几何中
  心落在世界原点。

### 4.3 首点安全

- `Board::new` 只保存 `dims / mines / seed`，`state = Ready`，**不布雷**。
- 第一次 `reveal(p)` 时：
  1. 计算安全集合 `safe = {p} ∪ neighbors(p)`（最多 27 格）。
  2. 在 `all_cells - safe` 中用 `StdRng::seed_from_u64(seed)` 随机选出 `mines` 个格
     子布雷。推荐做法：把候选格收集成 `Vec`，用 `rand` 的 `shuffle` 后取前 `mines`
     个，或用部分 Fisher–Yates；不要用"随机取点、撞了重试"的循环（雷密度高时会退化）。
  3. 计算全部 `adjacent`。
  4. `state = Playing`，然后按 4.5 执行本次翻开。
- 由于 `p` 的全部邻居都无雷，`p.adjacent == 0` 必然成立，首点必定展开一片空腔。

### 4.4 雷数上限

`max_mines(dims) = total_cells - 27`。

27 是最坏情况下安全集合的大小（点在内部时）。取这个保守上限，可以保证无论玩家第一
下点哪里，剩余候选格都够放下所有雷。

- `mines > max_mines(dims)` → `TooManyMines { requested, max }`
- `mines == 0` → `NoMines`
- 任一维度 `< 2` → `DimsTooSmall(dims)`

### 4.5 翻开与洪泛

`reveal(pos)`：

1. 若 `state` 为 `Won` 或 `Lost` → `Err(GameOver)`。
2. 若 `pos` 越界 → `Err(OutOfBounds(pos))`。
3. 若该格为 `Revealed` 或 `Flagged` → 什么都不做，返回
   `RevealOutcome { revealed: vec![], hit_mine: None, state: <当前状态> }`（**不是**
   错误）。插旗的格子受保护，误点不会踩雷。
4. 若为首次点击，先执行 4.3 的布雷。
5. 若该格是雷 → `state = Lost`，把**所有**雷置为 `Revealed`，
   `hit_mine = Some(pos)`，`revealed` 包含本次由隐藏变为揭示的全部格子。
6. 否则把该格置为 `Revealed` 并计入 `revealed`。若 `adjacent == 0`，用 **BFS/栈的
   迭代方式**（禁止递归，避免深层栈溢出）沿 26 邻域扩散：
   - 从队列取出一个 `adjacent == 0` 的格子，把它所有 `Hidden` 邻居翻开并计入
     `revealed`；
   - 其中 `adjacent == 0` 的邻居继续入队；
   - **`Flagged` 的格子跳过**，既不翻开也不入队；
   - 已 `Revealed` 的格子不重复处理。
7. 翻开后检查胜利条件（4.6）。
8. 返回 `RevealOutcome`。

### 4.6 胜负判定

- **胜利**：`revealed_count == total_cells - mines_total`。即所有非雷格都被翻开，
  与插了多少旗无关。胜利时把所有雷标记为已揭示（供前端展示），`state = Won`。
- **失败**：翻开了雷。`state = Lost`。
- 终局后 `reveal` 与 `toggle_flag` 一律返回 `Err(GameOver)`，不改变任何状态。

### 4.7 插旗

`toggle_flag(pos)`：

- 越界 → `Err(OutOfBounds)`；终局 → `Err(GameOver)`。
- `Hidden` → `Flagged`，`flags_placed += 1`。
- `Flagged` → `Hidden`，`flags_placed -= 1`。
- `Revealed` → 不变，返回 `Ok(CellState::Revealed)`。
- 旗数不设上限（可以插得比雷多），HUD 显示的剩余数允许为负。

### 4.8 确定性

同一个 `seed` + 同一个首点坐标 ⇒ 完全相同的雷分布。这是可测试性与"复盘同一局"的基
础，必须成立。RNG 只在布雷时使用一次，不要在其他地方消费同一个 RNG 实例。

---

## 5. bevy 前端行为契约

再次强调：本节描述**要达成什么效果**，不描述调用哪个 bevy API。所有 API 以 2.2 节的
查证结果为准。

### 5.1 场景构成

- 一个 3D 透视相机（轨道相机，见 5.4）。
- 光照：一盏方向光 + 一份环境光，保证立方体六个面都能看清，不要有全黑的面。
- 每个格子一个实体，携带一个标记组件记录它的 `Pos`：

  ```rust
  #[derive(Component, Debug, Clone, Copy)]
  pub struct CellTag(pub Pos);
  ```

- **共享资源**：整个网格共用**一份** cuboid mesh handle，以及一小组按视觉状态分类
  的材质 handle（见 5.2），统一存放在一个资源里：

  ```rust
  #[derive(Resource)]
  pub struct CellAssets {
      pub mesh: Handle<Mesh>,
      pub hidden: Handle<StandardMaterial>,
      pub hovered: Handle<StandardMaterial>,
      pub flagged: Handle<StandardMaterial>,
      pub mine: Handle<StandardMaterial>,
      pub exploded: Handle<StandardMaterial>,
      /// 索引 0..=26，对应 adjacent 数字的半透明材质。
      pub numbers: Vec<Handle<StandardMaterial>>,
  }
  ```

  上面代码块里的 `Handle` / `Mesh` / `StandardMaterial` 等类型名按当前 bevy 版本的实
  际情况调整（见 2.2）；**结构不变的要求是**：mesh 与材质集中存放、全网格共享。
  **禁止**为每个格子新建材质（512 个格子会产生 512 份材质，浪费且难以统一调色）。

- 全局资源：

  ```rust
  #[derive(Resource)]
  pub struct GameSession {
      pub board: Board,
      pub config: GameConfig,   // dims / mines / seed / difficulty 名称
  }

  #[derive(Resource)]
  pub struct ViewState {
      /// 当前可见的 z 层区间，闭区间。
      pub layer_lo: u8,
      pub layer_hi: u8,
  }
  ```

### 5.2 各状态的视觉表现

| 格子状态 | 表现 |
|---|---|
| `Hidden` | 不透明灰色立方体 |
| `Hidden` 且被鼠标悬停 | 高亮色（明显亮于普通 hidden） |
| `Flagged` | 红色立方体 |
| `Revealed` 且 `adjacent == 0` | **完全隐藏**（不渲染、不可拾取） |
| `Revealed` 且 `adjacent > 0` | 半透明彩色立方体（alpha ≈ 0.35）+ 数字标签 |
| 败局揭示的雷（非引爆点） | 深黑色不透明立方体 |
| 引爆的那颗雷 | 亮橙红色，与其他雷区分 |

"翻开的空格子直接消失"是三维扫雷能玩下去的关键——玩家正是靠翻开形成的空腔看到并点
到内部的格子。

### 5.3 数字的显示

`adjacent` 的范围是 `0..=26`，远超经典扫雷的 1..=8，因此**必须**同时用颜色和文字：

1. **颜色映射**（`palette.rs`）：

   ```rust
   /// n 取值 1..=26。用 HSL 从蓝(210°) 渐变到红(0°)。
   pub fn number_color(n: u8) -> Color {
       let t = (n.clamp(1, 26) - 1) as f32 / 25.0;
       let hue = 210.0 * (1.0 - t);           // 210° -> 0°
       // 饱和度 0.75，亮度 0.55（具体构造方式按 bevy 当前版本的 Color API）
       ...
   }
   ```

2. **数字文本**：用屏幕空间的 UI 文本标签，而不是 3D 文字网格。做法：

   - 维护一个 UI 文本节点池（数量上限取"可见的数字格子数上限"，可按需扩容）。
   - 每帧（或在相机/棋盘变化时）把每个需要显示数字的格子的世界坐标投影到屏幕坐标，
     把对应的 UI 文本节点移动过去并设置文字与颜色。
   - 投影落在视口外、或格子位于相机背后、或该格被剖切隐藏 ⇒ 该标签隐藏。
   - 池中多余的节点隐藏，不要每帧创建/销毁实体。

   这种做法不依赖任何 3D 文字扩展，跨 bevy 版本最稳。已知取舍：被前面的立方体挡住
   的数字标签仍会显示。这是**可接受的**，配合剖切功能足以正常游玩，不要为此引入复
   杂的遮挡剔除。

3. 字体：使用 bevy 内置的默认字体，不要向仓库添加字体资源文件。若该版本需要显式开
   启默认字体的 feature，在 `Cargo.toml` 里开启并在 README 注明。

### 5.4 相机

轨道相机，围绕雷区几何中心：

- **右键拖拽**：旋转（水平拖动改变方位角 yaw，垂直拖动改变俯仰角 pitch）。
  俯仰角限制在 `(-89°, 89°)`，防止翻转。
- **滚轮**：缩放（改变相机到中心的距离），距离限制在合理区间，例如
  `[max_dim * 0.8, max_dim * 6.0]`。
- **`F` 键**：复位到默认视角（一个能看到三个面的等距视角，例如 yaw 45°、pitch 30°）。
- 左键**不**用于相机，避免与"翻开格子"冲突。

### 5.5 拾取（点击到格子）

- 优先使用 bevy 该版本内置的网格拾取能力（先查证插件名与事件类型）。
- 若内置能力不可用或行为不符，用兜底方案：由鼠标位置构造从相机出发的射线，与每个
  **当前可见且可拾取**的格子的 AABB 求交，取参数 `t` 最小者。9³ = 729 个格子的暴力
  遍历完全够用，不要引入八叉树等空间索引。
- **硬性要求**：被剖切隐藏的格子、以及已翻开的空格子，**必须同时失去可拾取性**。否
  则玩家会点到看不见的东西，这是最容易出的 bug。
- 悬停时高亮当前会被点中的格子，并在 HUD 显示它的坐标。

### 5.6 输入映射

| 输入 | 行为 |
|---|---|
| 左键点击格子 | `board.reveal(pos)` |
| 右键点击格子 | `board.toggle_flag(pos)` |
| 右键拖拽（移动超过阈值） | 旋转相机；此时不触发插旗 |
| 滚轮 | 缩放 |
| `F` | 复位视角 |
| `[` / `]` | 可见层区间上界 `layer_hi` 减 / 加 |
| `Shift+[` / `Shift+]` | 可见层区间下界 `layer_lo` 减 / 加 |
| `\` | 恢复全部层可见 |
| `R` | 用新的随机 seed 重开一局（尺寸雷数不变） |
| `Esc` | 退出程序 |

右键的"点击"与"拖拽"需要区分：按下到抬起之间鼠标位移小于阈值（例如 4 像素）才算点
击。

### 5.7 剖切

- `ViewState { layer_lo, layer_hi }` 定义沿 **z 轴**的可见闭区间，初始为
  `[0, dims.z - 1]`。
- `z` 不在区间内的格子：隐藏 + 不可拾取。
- 两个边界都被夹在 `[0, dims.z - 1]` 内，且保证 `layer_lo <= layer_hi`。
- HUD 显示当前区间，例如 `层 2..=6 / 共 7`。

（v1 只支持沿 z 轴剖切，不需要切换剖切轴。）

### 5.8 HUD

屏幕上用 UI 文本显示：

- 剩余雷数：`mines_total - flags_placed`（可为负）
- 游戏状态：`进行中 / 你赢了 / 踩雷了`
- 雷区尺寸、雷数、当前 seed
- 当前可见层区间
- 当前悬停格子的坐标（没有则留空）
- 操作提示（可折叠或常驻底部小字）

胜负结算时在屏幕中央显示大字提示，并提示按 `R` 重开。

### 5.9 状态同步策略

- 前端**不要**每帧遍历整个 board 刷新所有实体外观。
- 正确做法：`reveal` / `toggle_flag` 返回后，只更新 `RevealOutcome.revealed` 里列出
  的格子和被操作的那一格；剖切或视角变化时只更新可见性。
- 用一个 `bool` 脏标记或 bevy 的变更检测（`Changed<T>`）驱动同步系统。

---

## 6. 难度与命令行

### 6.1 预设

| 难度 | 尺寸 | 格数 | 雷数 | 密度 |
|---|---|---|---|---|
| `easy` | 5×5×5 | 125 | 10 | 8.0% |
| `medium` | 7×7×7 | 343 | 40 | 11.7% |
| `hard` | 9×9×9 | 729 | 99 | 13.6% |

默认 `medium`。

（三维扫雷因为邻居多达 26 个，密度不宜照搬二维的 16%~20%，上表的密度是可玩的。）

### 6.2 CLI

用 `clap`（derive 风格）：

```
minesweeper3d [OPTIONS]

  -d, --difficulty <easy|medium|hard>   使用预设，默认 medium
      --dims <X,Y,Z>                    自定义尺寸，覆盖预设
      --mines <N>                       自定义雷数，覆盖预设
      --seed <N>                        指定随机种子，默认随机生成
  -h, --help
  -V, --version
```

- `--dims` 与 `--mines` 可单独使用，未指定的一项沿用所选难度的值。
- 参数非法时（尺寸解析失败、雷数超上限等）打印**人话**错误信息并以非 0 状态码退出，
  不要 panic。例如：
  `错误：9x9x9 最多允许 702 颗雷，但请求了 800 颗。`
- 未指定 `--seed` 时随机生成一个并在启动日志与 HUD 中显示，方便复盘。

---

## 7. 实施顺序

分四个阶段，每个阶段结束时代码必须能编译、`clippy` 无警告，并单独提交一次。

- **Phase 1 — `msweeper_core`**：数据结构、全部规则、第 8 节的全部单元测试。
  此阶段**完全不碰 bevy**，必须先做到 `cargo test -p msweeper_core` 全绿。
- **Phase 2 — 渲染骨架**：开窗、光照、按 board 生成格子实体、轨道相机（旋转/缩放/
  复位）。此时格子可以全是灰色方块，不需要交互。
- **Phase 3 — 交互**：拾取、悬停高亮、左键翻开、右键插旗、按 `RevealOutcome` 做增
  量视觉更新、数字颜色与标签。
- **Phase 4 — 完善**：HUD、剖切、CLI 与难度、胜负结算画面、`R` 重开、README。

---

## 8. 测试要求

以下用例必须全部实现，放在 `msweeper_core` 里（`cargo test -p msweeper_core`，无需
GPU/显示器）。

1. **索引往返**：对 `Dims { 4, 5, 6 }` 的每个 `Pos`，`pos -> idx -> pos` 还原一致；
   且不同 `Pos` 的 `idx` 互不相同。
2. **邻居计数**：在 `3×3×3` 中，`(0,0,0)` 有 7 个邻居、`(1,0,0)` 有 11 个、
   `(1,1,0)` 有 17 个、`(1,1,1)` 有 26 个；且邻居列表不含自身、无重复、全部在界内。
3. **邻居对称**：`a` 是 `b` 的邻居 ⟺ `b` 是 `a` 的邻居（在若干随机坐标上验证）。
4. **首点安全**：对 seed `0..50`，在 `6×6×6 / 30 雷` 上分别以角落、棱、面心、体心
   为首点，`reveal` 后该格 `adjacent == 0`，且它的所有邻居都不是雷，`revealed` 长
   度 > 1。
5. **雷数上限**：`Board::new(Dims{5,5,5}, 125 - 26, 0)` 返回
   `Err(TooManyMines { max: 98, .. })`；`125 - 27 = 98` 颗雷可以成功创建；`0` 颗雷
   返回 `Err(NoMines)`；`Dims { 1, 5, 5 }` 返回 `Err(DimsTooSmall)`。
6. **洪泛边界**：构造一个已知布局（可通过固定 seed 后读取内部状态，或提供
   `#[cfg(test)]` 专用构造函数），验证：`adjacent > 0` 的格子被翻开但不再向外扩散；
   洪泛过程中不翻开任何雷。
7. **旗标保护**：给某个会被洪泛波及的格子插旗后再触发洪泛，该格仍为 `Flagged`；直
   接 `reveal` 一个插旗的格子（哪怕它是雷）不会踩雷，且 `revealed` 为空。
8. **踩雷**：翻开一颗雷后 `state == Lost`，`hit_mine == Some(那颗雷)`，所有雷的
   `CellView.state == Revealed` 且 `is_mine == true`；此后 `reveal` 与
   `toggle_flag` 都返回 `Err(GameOver)`。
9. **胜利**：在小雷区（如 `3×3×3 / 2 雷`）上把所有非雷格逐个翻开，最后一格翻开后
   `state == Won`，且**不需要**插任何旗。
10. **确定性**：同 `seed`、同首点，两次独立开局的雷分布完全一致；不同 seed 在统计
    上应产生不同分布（至少验证若干 seed 两两不全相同）。
11. **越界**：`reveal` / `toggle_flag` / `cell` 传入越界坐标返回
    `Err(OutOfBounds)`，且不 panic、不改变棋盘状态。
12. **雷数准确**：布雷后统计真实雷数 == 请求的雷数（多个 seed 验证）。
13. **无递归栈溢出**：在 `20×20×20 / 100 雷` 上做一次首点翻开，正常返回（验证洪泛
    是迭代实现的）。

`msweeper_app` 不要求单元测试（bevy 的无头测试成本高、收益低），只要求能编译通过。

---

## 9. 验收标准

### 9.1 自动化（无显示器环境即可验证）

```bash
cd minesweeper3d
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p msweeper_core
cargo build --workspace --release
```

四条全部通过。注意：**本项目的开发容器没有显示器和 GPU，bevy 窗口跑不起来**，因此
自动化验收只到"能编译"为止。

### 9.2 人工（需要有显示器的机器）

`cargo run -p msweeper_app -- --difficulty easy` 后逐项确认：

- [ ] 正常开窗，能看到 5×5×5 的灰色立方体阵列，光照下各面可辨
- [ ] 右键拖拽可绕中心旋转，滚轮可缩放，`F` 复位视角
- [ ] 鼠标悬停时目标格子高亮，HUD 显示其坐标
- [ ] 左键点击首格后翻开一片空腔，空格子消失、能看进内部
- [ ] 数字格半透明并带彩色数字标签，数字颜色随大小从蓝渐变到红
- [ ] 右键插旗变红，HUD 剩余雷数减 1；再次右键取消
- [ ] 插旗的格子左键点不动，不会踩雷
- [ ] `[` `]` 可逐层剖切隐藏外壳，`\` 恢复；被隐藏的格子点不到
- [ ] 踩雷后所有雷显现，引爆点颜色与其他雷不同，出现失败提示
- [ ] 翻开所有非雷格后出现胜利提示
- [ ] `R` 重开一局，seed 变化且 HUD 同步更新
- [ ] `Esc` 正常退出

### 9.3 代码质量

- 公开 API 有文档注释（`///`），`msweeper_core` 的 `lib.rs` 有 crate 级说明。
- 没有 `unwrap()` / `expect()` 出现在 `msweeper_core` 的非测试代码里。
- 没有被注释掉的死代码、没有 `TODO` 残留（真有待办就写进 issue 或 PR 描述）。
- `Cargo.lock` 提交进版本库。
