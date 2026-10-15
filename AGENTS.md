# session-prefix 项目指引

单插件项目：通过会话标题前缀（默认 Emoji，可自定义）标记项目状态，仅用于帮助用户在会话列表中从视觉上区分状态，无任何其他行为副作用。
同时提供面向 Agent 的工具 `session_prefix`、面向用户的斜杠命令 `/state`、新会话默认状态自动挂载机制（`defaultState`）、回合生命周期与 Jev 内容推断的自动状态（`activeState`、`jevEnabled`），以及一页 Web 插件设置面板（「会话前缀」）。

源码在 `src/`：
- `index.ts`：插件入口（`inject = ["tools"]`），注册命令、监听 `turn/start` 对齐工具表并回落执行态、监听人类 `user/message` 触发 Jev 推断、监听 `turn/end`、监听 `session/title` 为新会话自动挂载默认状态前缀；
- `config.ts`：Volatile 配置定义（`enabled`、`defaultState`、`activeState`、`skipPattern`、`jev*`、`instructions`、`states`）与输入归一化；
- `state.ts`：核心领域逻辑——标题前缀解析与剥离（防叠罗汉）、基底标题兜底派生、状态应用与 `fallback`/`provider` 自动标题事件挂钩、回合开始的执行态回落（`applyTurnStartState`）；
- `jev.ts`：Jev 决策客户端、上下文提取（`extractTurnContext`）与回合推断调度（`runJevStateInference`）；
- `tools.ts` + `assembly.ts`：`session_prefix` 工具定义与回合边界动态同步；
- `commands.ts`：用户命令 `/state`；
- `services.ts` / `target.ts` / `errors.ts` / `text.ts`：懒取服务、目标解析、按 `error.name` 识别错误、文本整形；
- `src/client/**`：Web 设置面板（构建产物为 `lib/client.js`）。

## 必须了解

- **标题即唯一事实来源**：主动切换状态走 `ctx.sessionTitle.rename(liveSession, title)`；每次切换前先用 `parseTitleState` 按前缀长度降序循环剥离已有状态前缀，确保不会出现 `✅ 🚧 标题` 叠加。只操作当前进程内的 live 会话，不为冷会话调用 `agents.resume` 拉活。
- **输入面只有状态 key**：命令与工具都只接受 `key`（外加 `none` / `clear` 清除），名称与前缀仅用于展示与拼接；不要在匹配逻辑里重新引入 label / prefix 别名。
- **新会话默认状态（`defaultState`）不打断后台自动起名**：宿主对新会话先产生 `source.kind === "fallback"` 的标题，随后后台异步运行 LLM Title Provider 产生 `source.kind === "provider"` 的标题。本插件在 `session/event` 中监听这两类自动生成的 `session/title` 事件，直接通过 `session.append("session/title", { title: prefixed, messageSeqs, source })` 保持原 `source` 追加带前缀的标题，因此既能在第一秒显示默认状态（如 `🚧`），又不会触发 `user` source 的 `supersede` 中断后台 LLM 自动生成标题；当 LLM 标题生成完毕后还会自动把前缀平滑衔接过去。子代理会话（`parentSession !== undefined` 或 `origin === "subagent"`）自动跳过。
- **写回必须在 microtask 里，不能同步**：宿主 `Session.append` 在发布 `session/event` 期间带重入守卫——同步回调里再 append 会抛 `session append cannot reenter while another append is being published`（真实宿主才有的约束，假宿主单测必须显式模拟这道守卫，否则测试会假绿）。因此 `session/title` 分支用 `queueMicrotask` 调度，且 `handleAutoSessionTitleEvent` 以「会话当前最新的一条 `session/title`」为基准重新判断，避免延迟期间更新的标题被旧值覆盖。
- **回合状态的两段式模型（生命周期 + 内容推断）**：宿主在 `turn/start` 之后才落库本回合的人类输入（`dsh-agent-loop` 的 `turn()` 先 append `turn/start`，本回合输入到首个 step 才 append `user/message`，实测相隔 2–300ms）。因此：
  - `turn/start` 只做生命周期对齐——`applyTurnStartState` 把「已带状态前缀且不是执行态」的会话回落到 `activeState`（默认 wip）。这是「宿主恢复执行 ⇒ 立刻离开 ⏸️/👀/✅」的唯一可靠信号，**不要在这里做内容推断**；
  - `user/message`（`data.source.kind === "user"`）落库后才跑 Jev `start` 推断，此时上下文才包含本轮人类指令；
  - 从未打标的会话不会被回落强加前缀，`activeState: "none"` 关闭该行为。
- **标题跳过规则（`skipPattern`）先行于所有自动行为**：标题剥离本插件状态前缀后命中该正则（默认 `^\S+ · `，覆盖 IM 桥接写入的 `Telegram · xxx`）时，`handleAutoSessionTitleEvent`、`applyInferredSessionState`（因此也含回合回落）、`runJevStateInference`（连决策请求都不发）一律直接放弃——外部标签必须留在行首，被状态前缀顶开会被对方重新补标签，叠成 `Telegram · 🚧 Telegram · xxx`。规则只挡**自动**路径：用户 `/state` 与模型工具照常写入；空规则 = 关闭（`compileSkipPattern` 对空串返回 `null`）；非法正则按关闭处理。
- **`extractTurnContext` 只认人类指令**：`user/message` 必须按 `data.source.kind === "user"` 过滤——宿主的注入消息（runtime-context / dsh-mnemon / dsh-message-datetime / tool-jobs / agent-instructions / skill-catalog）紧跟在人类消息之后落库，倒序扫描会先命中它们；两段各自保号（指令保头 ≤800 字符，上轮回复/本轮产出保尾），避免超长产出把指令挤出预算。
- **服务懒取**：`inject` 仅声明 `["tools"]`；`sessions`、`sessionTitle`、`commands` 均通过 `ctx.get(name, false)` 懒取。
- **客户端构建产物**：`src/client/**` 由 `scripts/build-client.mjs` 打成 `lib/client.js`（`id: "session-prefix"`），构建后必须通过 `node --check lib/client.js`。

## 常用命令

```bash
npm run check         # tsc --noEmit（含 src/client 的 TSX）
npm run build         # 构建 dist/ + lib/client.js 并执行 node --check
npm test              # 构建 + 单元测试
npm run e2e:state     # GUI e2e（真实模型；需先 dsh-e2e start --patch e2e/profile.patch.yml）
```
