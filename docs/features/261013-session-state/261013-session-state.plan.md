# `dsh-session-state` 需求调研与实现计划

## 1. 背景与目标

参考 `dsh-manage-session` 的架构与工程实践，开发独立 DSH 插件项目 **`dsh-session-state`**（位于 `/root/projects/dsh-session-state`）。

核心目标：
- 通过在会话标题（`session/title`）前添加/替换/剥离**可自定义的状态前缀**（默认是一组直观的 Emoji），标记会话当前的项目状态。
- 支持**新会话默认状态（`defaultState`）**：默认设为 `"wip"`（`🚧`），也可在设置页选择其他任意状态或 `"none"`（不自动添加状态前缀）。
- **纯视觉标记，无任何其他行为副作用**：不改变会话生命周期、不阻断回合、不打断宿主后台的自动标题生成（LLM Title Provider），以会话标题本身作为唯一事实来源（Single Source of Truth）。
- 同时提供**面向用户的斜杠命令**（`/state`）与**面向 Agent 的模型工具**（`session_state`），以及**Web 插件设置页**（支持选择新会话默认状态、自定义状态列表、前缀、工具开关与给模型的 Operator Instructions）。

---

## 2. 宿主机制调研结论

### 2.1 标题读写与前缀幂等替换
- **写标题**：主动改状态走 `ctx.sessionTitle.rename(liveSession, title)`（追加 `source: { kind: "user" }` 的 log-only `session/title` 事件并更新客户端 `title` 投影）。与 `dsh-manage-session` 一致，仅操作当前进程中的 live 会话（`ctx.sessions.get(id)`），不为冷会话调用 `agents.resume` 拉活，保护 8GB 设备内存。
- **读当前标题**：通过 `ctx.sessionTitle.get(liveSession)?.title` 读取最新折叠标题。
  - **首轮/空白会话兜底**：若会话刚收到第一条消息但 `ensureFallback` 微任务尚未落盘（`titles.get(session)` 为 `undefined`），从 `session.snapshotEvents()` 中提取首条人类 `user/message` 文本派生默认标题；若为尚未发消息的纯空白会话，则使用默认基底标题 `"新会话"`。
- **前缀剥离与防叠罗汉**：切换状态时，先按前缀长度降序匹配并剥离标题开头已有的状态前缀（覆盖当前配置的全部状态前缀及内置默认前缀，支持连续剥离），提取纯净的 `baseTitle`，再拼接 `${newPrefix} ${baseTitle}`（或清除状态时直接还原为 `baseTitle`）。

### 2.2 新会话默认状态（`defaultState`）与宿主自动命名协同机制
宿主 `SessionTitleService` 在新会话收到首条用户消息时：
1. 先通过微任务 `ensureFallback(session)` 追加一条 `source: { kind: "fallback" }` 的 `session/title`；
2. 紧接着在 `onRequestHeader` 启动异步 LLM Title Provider，完成后追加一条 `source: { kind: "provider", ... }` 的 `session/title`。
3. 若在 `fallback` 阶段直接调用 `titles.rename()`，会写入 `source: { kind: "user" }` 并调用 `supersede()` **中断正在后台运行的 LLM Title Provider**。

**正向协同方案**：
- 插件监听 `ctx.on("session/event", (session, event) => ...)` 中的 `session/title` 事件：
  - 仅针对根会话（跳过 `session.header.parentSession !== undefined` 或 `session.header.origin === "subagent"` 的子代理会话）；
  - 当收到 `event.data.source.kind === "fallback"` 或 `"provider"` 的自动生成标题，且其标题尚未携带状态前缀时：
    - 查找该会话的期望状态：若该会话曾被显式 `/state clear` 清除则跳过；若曾设置过特定状态则沿用该状态；若为未操作过的新会话则读取 `settings.defaultState`（默认为 `"wip"`，若配置为 `"none"` 则跳过）；
    - 直接通过 `session.append("session/title", { title: prefixedTitle, messageSeqs: event.data.messageSeqs, source: event.data.source })` 追加带前缀的标题事件（保持原有的 `fallback` / `provider` source 不变）！
  - **效果**：新会话在 `fallback` 产生瞬间立即显示 `🚧 <首句摘要>`，同时**不打断后台 LLM Title Provider**；当几百毫秒后 LLM 生成出精准标题时，自动衔接为 `🚧 <LLM标题>`！

### 2.3 列表筛选能力（非 MVP）可行性评估
对 `@deepseek-ai/dsh-client-ui-workspace` 的源码调研结论如下：
1. **原生搜索框已天然支持按状态前缀筛选（零侵入）**：
   侧边栏内置搜索框在 `deriveSearchResults` 中对 `sessionTitle(summary).toLowerCase().includes(query)` 做即时本地匹配。由于状态直接作为标题前缀写入 `session/title`，用户在侧边栏搜索栏输入 `🚧`、`✅` 等前缀即可原生、即时筛选出对应状态的会话。
2. **自定义列表过滤器扩展点现状**：
   `sidebar.workspaces` 是由 `ui-workspace` 独占的 `single` 槽位，只向下声明了单行级 slot（`sidebar.session.row.leading`、`session.menu.item`、`session.row.action`），未暴露列表级 Filter Slot 或 `WorkspaceViewState` 过滤钩子。
3. **结论**：MVP 保持零 hack 的纯粹设计，在文档与命令提示中说明可通过侧边栏搜索框输入状态 Emoji 直接过滤。

---

## 3. 用户体验与使用路径设计

### 3.1 默认状态集（Default States）与新会话默认状态
开箱即用提供 6 个高频状态预设（用户可在设置页自由增、删、改），**新会话默认状态 `defaultState` 默认为 `"wip"`（`🚧 进行中`），支持切换为任意状态或 `"none"`（无默认状态）**：

| 状态 Key (`key`) | 默认前缀 (`prefix`) | 名称 (`label`) | 适用场景说明 (`description`) |
| :--- | :--- | :--- | :--- |
| `wip` | `🚧` | 进行中 | 正在编码、实施或执行任务（新会话默认状态） |
| `blocked` | `⏸️` | 等待/阻塞 | 等待用户确认、审批、外部输入或遇到阻塞 |
| `review` | `👀` | 待验收 | 实施或计划已完成，等待用户检视或验收 |
| `done` | `✅` | 已完成 | 当前会话任务已全部交付完成 |
| `plan` | `💡` | 规划/调研 | 正在进行需求调研、方案设计或讨论 |
| `bug` | `🐛` | 排障/修复 | 正在定位问题、排查故障或修复缺陷 |

> 另内置清除指令：`clear` / `none`（剥离已有状态前缀，恢复原始裸标题）。

### 3.2 路径一：用户使用 `/state` 命令
- **`/state` 或 `/state list`**（无参数或 `list`）：
  显示当前会话所处状态、当前完整标题与裸标题、当前配置的新会话默认状态，并列出所有可用状态及用法示例。
- **`/state <state>`**（支持传 `key`、`label` 或 `prefix`，例如 `/state wip`、`/state 进行中`、`/state 🚧`）：
  立即将当前会话标题前缀切换为对应状态，回执：`Updated session state to 🚧 进行中 ("🚧 修复登录问题").`
- **`/state clear` 或 `/state none`**：
  移除当前会话标题的状态前缀，回执：`Cleared session state ("修复登录问题").`
- 当启用 `allowCustomPrefix` 时，传入未预定义的短前缀（如 `/state 🔥` 或 `/state [紧急]`）可直接作为自定义前缀应用。

### 3.3 路径二：Agent 调用 `session_state` 工具
- 工具名：`session_state`
- 参数：
  - `state` (`string`, 必填)：目标状态的 `key`（如 `"wip"`, `"blocked"`, `"review"`, `"done"`, `"plan"`, `"bug"`）或 `"none"` / `"clear"` 清除状态。参数描述会根据当前设置动态生成可用状态清单。
  - `session_id` (`string`, 可选)：目标会话 ID，省略时作用于当前会话（仅限 live 会话）。

### 3.4 路径三：Web 插件设置页（「会话状态」）
在设置面板挂载 `settings.section`（entry id: `session-state`，标签：`会话状态`）：
1. **工具开关（`enabled`）**：启用/禁用 `session_state` 模型工具。
2. **新会话默认状态（`defaultState`）**：下拉选择框，选项包括 `none（不自动标记）` 以及当前状态列表中所有状态（默认选中 `wip — 🚧 进行中`）。
3. **自定义前缀开关（`allowCustomPrefix`）**：是否允许命令/工具使用预设列表之外的自由前缀（默认 `false`）。
4. **工具自定义指令（`instructions`）**：追加到 `session_state` 描述尾部的 `Operator instructions for this tool`，最多 2000 字。
5. **状态预设列表编辑器（`states`）**：
   - 可视化列表展示每一项的 `前缀 (prefix)`、`键值 (key)`、`名称 (label)`、`说明 (description)`；
   - 支持直接修改任意状态的 emoji/文字前缀、名称与说明；
   - 支持**新增状态**、**删除状态**、**一键恢复默认状态集**。

---

## 4. 架构与模块设计

项目路径：`/root/projects/dsh-session-state`

```
dsh-session-state/
├── package.json              # 包名 dsh-session-state，peerDeps 对齐 dsh-tools / schemastery
├── cordis.patch.yml          # insert: [{ id: session-state, name: dsh-session-state }]
├── tsconfig.json             # 类型检查配置（含 src/ 与 src/client/）
├── tsconfig.build.json       # 构建 dist/（排除 src/client/）
├── scripts/
│   └── build-client.mjs      # esbuild 打包 src/client/index.ts -> lib/client.js（id: "dsh-session-state"）
├── src/
│   ├── index.ts              # 插件入口：inject=["tools"]，装配工具、命令、turn/start 同步与 session/title 默认状态挂钩
│   ├── config.ts             # Volatile Config 定义（enabled, defaultState, allowCustomPrefix, instructions, states）
│   ├── state.ts              # 核心领域逻辑：标题前缀解析、剥离、替换、自动标题挂载默认状态与 rename 调用
│   ├── tools.ts              # defineTool("session_state") 定义，动态拼接状态表与自定义指令
│   ├── assembly.ts           # turn/start 工具表对齐（syncTools / disposeTools）
│   ├── commands.ts           # /state 命令注册与解析
│   ├── services.ts           # 懒取 sessions / sessionTitle 服务
│   ├── target.ts             # callerSessionId / targetSessionId 解析
│   ├── text.ts               # oneLine / quoted 文本整形
│   ├── errors.ts             # SessionTitleInvalidError 等按 error.name 识别
│   └── client/
│       ├── index.ts          # 挂载 settings.section (id: "session-state")
│       ├── settings-panel.tsx# 会话状态设置面板（工具开关 + 默认状态选择 + 指令 + 状态列表增删改）
│       └── styles.ts         # 面板样式（命名空间前缀 dss-*）
├── test/
│   └── session-state.test.mjs# 全面单测（假宿主：默认状态自动挂载、前缀替换/剥离/防叠罗汉、空白兜底、自定义状态、命令、装配）
├── AGENTS.md                 # 项目级开发指引
├── README.md                 # 中文说明文档
└── README.en.md              # 英文说明文档
```
