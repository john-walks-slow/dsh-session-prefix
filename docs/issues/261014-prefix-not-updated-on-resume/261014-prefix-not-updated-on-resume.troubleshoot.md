# 会话继续执行后状态前缀不回「进行中」

2026-10-14。用户报告：某个会话前缀停在 ⏸️（等待/阻塞），自己处理完阻塞原因、会话恢复执行后，前缀没有变回 🚧。

## 现象与证据

会话 `session-49eb4e97`（workspace `/root/projects/session-prefix`）的 `session/title` 事件时间线：

| 时刻 | 回合边界 | 用线上状态表复现的 Jev 判定 | 实际写入 |
| --- | --- | --- | --- |
| 12:19:16 | turn/end | validate 0.91 | 👀 ✓ |
| 12:21:41 | turn/end | validate 0.81 | 与现值相同 → 无 |
| 12:24:22 | turn/end | blocked 0.98 | ⏸️ ✓ |
| **12:24:44** | **turn/start** | **blocked 0.76** | **与现值相同 → 无写入** |
| 12:26:57 | turn/end | done 0.87 | ✅ ✓ |
| 12:29:08 | turn/start | done 0.85 | 与现值相同 → 无写入 |

复现方式：`~/.dsh/sessions/--root-projects-session-prefix--/session-49eb4e97-*/session.v4.jsonl.zstd` 解压后，用 `dist/jev.js` 的 `extractTurnContext` + `queryJevState`，状态表取自线上 `cordis.patch.yml`（key 为 `validate`，描述被自定义过）。六条边界逐条与实际写入吻合，说明模型与调度链路本身没有故障。

12:24:44 那个回合是**后台 npm 发布任务唤醒**的（回合内没有任何人类消息），插件的 start 推断只能看到上一回合的材料——助手在 12:24:22 说「去浏览器按指纹，我等你的结果」——于是再次判 blocked，与当前状态相同而跳过写回。整个回合（12:24:44–12:26:57）前缀都钉在 ⏸️。

## 根因

1. **`turn/start` 早于本回合的人类输入落库，start 阶段推断结构性滞后一轮。**
   宿主 `dsh-agent-loop/lib/index.js` 的 `turn()` 先 `append("turn/start")`（:943），本回合输入要到首个 step 才 `append("user/message")`（:1061）。实测顺序为 `turn/start → step/start → user/message(人类)`（相隔 2–300ms）。因此在 `turn/start` 抓快照做内容推断，永远拿不到本轮指令；后台任务唤醒的回合更是完全没有人类消息可看。
2. **人类指令槽被宿主注入污染。**
   `extractTurnContext` 只按 `type === "user/message"` 取「用户指令」，未区分 `source.kind`。注入消息（runtime-context / dsh-mnemon / dsh-message-datetime / tool-jobs / agent-instructions / skill-catalog）都紧跟人类消息之后落库，倒序扫描先命中它们：12:24:44 那次 2000 字符上下文里，后半整段是 MEMORY.md 快照；人类那句 `ok go` 在 12:21:41 与 12:26:57 两次判定中都没进入上下文。
3. **可观测性缺口**：插件 `ctx.logger` 输出不落 `/var/log/dsh.log`（该文件与 `~/.dsh/logs/*` 里 `session-prefix` 命中 0 条），排障只能靠会话 JSONL + 本地复现。

## 修复

- **回合开始回落执行态**：新增配置 `activeState`（默认 `wip`，`none` 表示不回落）。`turn/start` 不再做内容推断，只做生命周期对齐——若标题已带状态前缀且不是执行态，就回落到执行态；从未打标的会话不会被强行加前缀。这样人类追问与后台唤醒两种续跑都会立刻离开 ⏸️/👀/✅。
- **start 推断改挂到人类消息**：`user/message` 且 `source.kind === "user"` 时触发 Jev（每个回合每条人类消息一次，旧请求由 generation 守护淘汰）；注入消息不再触发。
- **上下文只认人类指令**：`extractTurnContext` 过滤 `source.kind === "user"`；指令保头部（≤800 字符）、上轮回复/本轮产出保尾部，避免超长产出把指令挤出预算。
- 设置面板新增「回合进行中状态」下拉。

## 验证

- `npm test` 21 项全绿（新增：turn/start 回落与不回落条件、注入消息不触发推断、上下文过滤与预算）。
- 用真实日志复现修复后的判定：12:24:44 与 12:29:08 两次 turn/start 都会先把 ⏸️/✅ 回落为 🚧；12:29:09 人类新指令的 start 判定为 done 0.61（低于 0.7 阈值被拒），因此前缀停在 🚧 —— 符合「用户刚派了新活」的事实。

## 遗留观察

- `StateTracker.cleared`（用户 `/state none` 清除过的会话）只被默认状态挂载路径消费；Jev 推断与本次新增的回落都不看它。若希望「清除后该会话彻底不再自动打标」，需要单独统一这个语义。
- `/var/log/dsh.log` 看不到插件日志，建议后续确认 cordis logger 的落盘级别/去向，必要时为状态写回补一条可见轨迹。
