# Jev 自动状态推断与双开关支持总结

## 背景与需求

用户提出在 `session-prefix` 插件中支持基于 TypeSafe Jev 决策模型的自动会话状态推断：
1. **触发节点**：在回合开始（`turn/start`）与回合结束（`turn/end`）两个节点自动调用 Jev 判断项目状态；
2. **独立双开关**：分别提供 Jev 自动推断开关（`jevEnabled`）与模型工具 `session_prefix` 开关（`toolEnabled`），两者可独立开启或关闭，互不干扰；
3. **零配置与协同**：自动读取环境凭据，保护后台 Title Provider 正常运作，不打断自动命名。

## 架构与核心实现

### 1. Jev 决策客户端与调度器（`src/jev.ts`）
- **凭据解析（三级回落）**：插件配置（`jevApiKey`） → 环境变量（`OPENROUTER_API_KEY`） → 系统密码本（`~/.config/api-vault/vault.json` 中的 `openrouter.key`）。缺失时静默跳过，绝不报错或阻塞会话；
- **上下文裁剪**：
  - `turn/start`：提取用户最新指令（≤ 1000 字符）；
  - `turn/end`：提取用户指令（≤ 600 字符）+ 助手末尾输出摘录（≤ 1000 字符）；
- **动态 Criteria 映射**：将当前配置的状态预设表（`states`）动态映射为 OpenRouter Decisions API（`typesafe/jev-1.13`）的 choice 选项；
- **严格响应核验**：
  - 必须为 `answer.type === "choice"` 且选项合法；
  - 置信度必须为 `0 <= confidence <= 1` 的有限数字；
  - 置信度阈值要求 ≥ 0.7，低于阈值或状态与当前一致时不触发更新；
- **并发与生命周期守护（`JevInferenceManager`）**：
  - 实例级独立管理，递增 generation 机制；
  - 飞行中请求遇到早期退出或新推断时立刻 abort 并淘汰；
  - 提交阶段实时通过 `SettingsProvider` 校验当前最新配置，确保网络等待期间被禁用时绝不写回。

### 2. 平滑状态写回（`src/state.ts`）
- 实现 `applyInferredSessionState`：
  - 若最新标题来源为 `fallback` 或 `provider`，保持原 source 纯追加，保护后台 LLM Title Provider 不被 supersede 打断；
  - 仅在标题成功追加或改名后，才更新 `tracker.assigned`，防止状态污染；
  - 以当前标题解析为唯一事实来源，不再受过期 tracker 干扰。

### 3. 配置与双开关（`src/config.ts`、`src/assembly.ts`）
- `toolEnabled`：控制模型工具 `session_prefix` 的注册；未显式指定时平滑回退到历史 `enabled`；
- `jevEnabled`：控制后台 Jev 自动推断；
- 两者独立生效，互不干扰。

### 4. Web 设置面板（`src/client/settings-panel.tsx`）
- 增加「启用 Jev 自动状态推断」独立卡片与说明文案；
- 模型工具开关绑定 `toolEnabled`；
- 前端剔除敏感 Key 字段，恢复默认改为串行原子执行。

## 测试与验证

全量 16 项自动化单元测试全部通过（`npm test`）：
1. `parseTitleState` 单前缀与叠罗汉前缀剥离测试；
2. `session_prefix` 工具增改查与去重测试；
3. 空白会话首消息基底标题兜底测试；
4. `defaultState` 自动标题挂载与 LLM provider 平滑衔接测试；
5. `defaultState=none` 跳过前缀测试；
6. `volatile` 配置热重载测试；
7. `/state` 用户斜杠命令全功能测试；
8. `toolEnabled` 与 `jevEnabled` 双开关独立控制测试；
9. `extractTurnContext` 上下文精确裁剪测试；
10. Jev 在 `turn/start` 与 `turn/end` 自动更新标题测试；
11. **B-01 竞态守护**：旧请求晚返回时通过 generation 检查淘汰；
12. **B-02 保护 Provider**：自动推断保留 `provider` source；
13. **B-03 & B-04 严格校验**：单事实来源与响应类型/置信度/选项校验；
14. **B-08 严格数值边界**：`Infinity`、负数、越界置信度严格拦截；
15. **B-07 实时开关校验**：飞行中请求在用户关闭 Jev 后被实时拦截；
16. **B-09 配置优先级**：显式 `toolEnabled` 优先级与历史配置兼容测试。
