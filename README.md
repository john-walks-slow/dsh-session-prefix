# dsh-session-state

中文 | [English](README.en.md)

用会话标题前缀（默认 Emoji，可完全自定义）标记 DeepSeek Harness 会话的项目状态——**纯视觉区分，无任何其他行为副作用**。

支持：
- **新会话默认状态**：新会话产生标题时自动冠上默认状态前缀（默认为 `wip` `🚧`，也可在设置页改为其他状态或 `none`），且不会打断后台 LLM 自动生成标题；
- **面向 Agent 的模型工具 `session_state`**：让 Agent 在工作流阶段切换时自动更新会话状态前缀；
- **面向用户的斜杠命令 `/state`**：随时查看、切换或清除当前会话的状态前缀；
- **Web 插件设置页（「会话状态」）**：可视化增删改状态列表（自定义 Emoji 或文本前缀、Key、名称、说明）、选择新会话默认状态、开关模型工具并编写自定义 `Operator instructions`；
- **原生侧边栏搜索筛选**：在 DSH 侧边栏搜索框输入任意状态前缀（如 `🚧`、`✅`、`👀`），即可即时筛选出对应状态的所有会话。

## 安装

从 GitHub 直接安装（源码安装，会执行本仓库的 `prepare` 构建）：

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-session-state
```

本地开发目录直链：

```bash
dsh plugin --profile web add link:/path/to/dsh-session-state
```

安装后无需手工改配置：插件自带的 `cordis.patch.yml` 自动挂载生效，模型工具表里多出 `session_state`，命令表里多出 `/state`，设置页里多出「会话状态」。

> 源码安装需要 Node ≥ 22.5，并在安装时执行构建（`tsc` + `esbuild`，产出 `dist/` 与 `lib/client.js`）。pnpm ≥ 10 需放行该构建（`pnpm approve-builds`，或在 `onlyBuiltDependencies` 中加入本包）。

## 权限与兼容

- **不联网、不读写本机文件、不调用任何外部服务**。唯一的写入是往目标会话日志追加一条 `session/title` 事件（宿主自己的改名路径）。
- 只作用于当前进程内 **live** 的会话（你自己，或 GUI 里打开着的会话）；不会为冷会话拉起 agent。
- 需要提供 `sessionTitle` 服务的 dsh 宿主（`@deepseek-ai/dsh-base` 自带）。宿主没有 `commands` 服务时 `/state` 不注册，其余功能照常。

## 默认状态预设

| Key | 默认前缀 | 名称 | 说明 |
| :--- | :--- | :--- | :--- |
| `wip` | `🚧` | 进行中 | 正在编码、实施或执行任务（新会话默认） |
| `blocked` | `⏸️` | 等待/阻塞 | 等待用户确认、审批、外部输入或遇到阻塞 |
| `review` | `👀` | 待验收 | 实施或计划已完成，等待用户检视或验收 |
| `done` | `✅` | 已完成 | 当前会话任务已全部交付完成 |
| `plan` | `💡` | 规划/调研 | 正在进行需求调研、方案设计或讨论 |
| `bug` | `🐛` | 排障/修复 | 正在定位问题、排查故障或修复缺陷 |
| `clear` / `none` | — | 清除状态 | 剥离已有状态前缀，恢复原始裸标题 |

## 使用方法

### 1. 用户命令 `/state`

```text
/state              # 查看当前会话状态、标题、新会话默认状态及可用状态列表
/state list         # 同上，列出所有可用状态预设
/state wip          # 设为「🚧 进行中」
/state review       # 切换为「👀 待验收」（自动剥离旧前缀，绝不叠加）
/state done         # 切换为「✅ 已完成」
/state none         # 清除状态前缀，恢复原始标题（同 /state clear）
```

状态只用 **key** 选择（如 `wip`、`review`、`done`）；名称与前缀只用于展示，不作为入参。

### 2. 模型工具 `session_state`

- `state`（必填）：状态 key（如 `"wip"`、`"review"`、`"done"`），或 `"none"` / `"clear"` 清除状态前缀。
- `session_id`（可选）：目标会话 ID，省略时作用于当前会话（仅限当前进程内的 live 会话）。

**无需任何配置**：工具描述本身就把「按阶段自主维护状态标记」写成明确预期，并给出每个状态的适用场景（取自状态项的「说明」字段）。模型会在开始实施、等待你确认、待验收、完工等阶段自行切换；只有想追加额外偏好（例如「没有我的确认不要设 done」）时才需要在设置页填写指令。

### 3. Web 设置面板

打开 **Settings → 会话状态**：
- 选择**新会话默认状态**（默认 `wip`，可选 `none` 或任意自定义状态）；
- 开关 **`session_state` 工具**并配置给 Agent 的自定义触发指令（如：`开始实施时设为 wip，等待用户验收时设为 review，完工后设为 done`）；
- **增、删、改**状态预设列表（每项含 key、前缀、名称、说明），或一键恢复默认状态集。所有修改在保存后的下一个回合立即生效。

## 开发与测试

```bash
npm run check   # TypeScript 类型检查
npm run build   # 构建 dist/ 与 lib/client.js
npm test        # 运行构建与全部单元测试
```
