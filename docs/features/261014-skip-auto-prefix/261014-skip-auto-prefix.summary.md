# 261014 标题跳过规则（skipPattern）总结

## 背景与触发

用户要求：**「如果会话是 `xxx · yyy` 这种格式，不自动加 prefix」**。

`xxx · yyy` 是 IM 桥接（`@johnnren/dsh-im-humanize`）写入的频道标签格式（`Telegram · xxx`、`飞书 · xxx`…，见
`src/channels/shared/session-channel-labels.mjs`）：它要求标签位于**行首**，`parseSessionChannelTitle` 只认行首前缀。
一旦本插件把状态前缀插到标签前面，对方就认不出自己的标签并**再补一次**，历史日志里因此出现过
`Telegram · 👀 Telegram · ⏸️ Telegram · …` 这类叠罗汉。

## 设计（经用户确认）

两个问题都问过用户：

1. **跳过范围**：所有**自动**路径一律停手（新会话默认状态、回合回落 `activeState`、Jev 推断），
   用户显式 `/state` 与模型工具 `session_prefix` 不受限制。
2. **判定方式**：做成可配置项（设置页可编辑的正则），而不是写死规则。

落地为 Volatile 配置 `skipPattern`：

- 默认值 `^\S+ · `（即「行首标签 + ` · `」，覆盖 IM 频道标签这一形态，开箱即用）；**留空 = 关闭规则**；
- 匹配对象是**剥离本插件状态前缀之后的裸标题**（`parseTitleState(...).baseTitle`），
  这样 `🚧 Telegram · x`（显式打标过）同样被规则覆盖；
- 编译失败的正则按「关闭」处理，绝不让一条写错的正则打断状态自动化（`compileSkipPattern` 返回 `null`）；
- 规则字符串带编译缓存，事件高频路径不重复 `new RegExp`。

三个接入点（`shouldSkipAutoPrefix`）：

| 位置 | 行为 |
|---|---|
| `handleAutoSessionTitleEvent` | 新会话 `fallback`/`provider` 自动标题不再冠默认前缀 |
| `applyInferredSessionState` | 推断类写入（含 `applyTurnStartState` 的回合回落）直接返回 `false` |
| `runJevStateInference` | 命中规则时**连决策请求都不发**，省一次 API 调用与成本 |

## 改动文件

- `src/config.ts`：`DEFAULT_SKIP_PATTERN`、`skipPattern` 字段与 `sanitizeSkipPattern`（缺失→默认值，显式 `""`→关闭）；
- `src/state.ts`：`shouldSkipAutoPrefix` + 两处接入；
- `src/jev.ts`：推断前置跳过；
- `src/client/settings-panel.tsx`：新增「标题跳过规则」输入行，保存前做正则校验并给出错误提示（不阻塞其它设置）；
- `README.md` / `README.en.md` / `AGENTS.md`：机制与用法同步；
- `test/session-prefix.test.mjs`：+2 个用例（自动路径全停手 + 规则可配置性）。

## 验证

| 检查 | 结果 |
|---|---|
| `npm run check` | 通过 |
| `npm run build` | `lib/client.js` 33,181 chars，`node --check` 通过 |
| `npm test` | 23/23 通过（新增 2 例：skip 规则全自动路径；空规则/自定义规则/非法正则） |

新增用例覆盖：`Telegram · xxx` 在 fallback、provider、turn/start、Jev 四条路径下标题逐字不变；
显式工具调用仍写入 `🐛 Telegram · xxx`；随后回合回落依然停手；空规则恢复自动前缀；非法正则视为关闭。

## 待办 / 注意

- 宿主侧改动在 `dist/`，需重启 dsh 才对线上 profile 生效（客户端面板刷新即可看到新输入行）。
