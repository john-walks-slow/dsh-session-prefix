# dsh-session-state

[中文](README.md) | English

Mark DeepSeek Harness session states using customizable title prefixes (Emoji or short text badges by default) — **purely for visual distinction in the session list, with no other behavioral side effects**.

Features:
- **Default state for new sessions**: Automatically prefixes newly titled sessions with your chosen default state (defaults to `wip` `🚧`, or choose any state / `none`), without interrupting background LLM title generation;
- **Agent tool `session_state`**: Lets the agent update the session's state badge as task phases change;
- **User command `/state`**: View, switch, or clear the current session's state prefix at any time;
- **Web Settings panel ("会话状态")**: Add, edit, or remove custom states (prefix, key, label, description), pick the default state for new sessions, toggle the model tool, and configure custom operator instructions;
- **Sidebar search filtering**: Type any state badge (e.g. `🚧`, `✅`, `👀`) into the native DSH sidebar search box to filter sessions by state immediately.

## Default State Presets

| Key | Default Prefix | Label | Description |
| :--- | :--- | :--- | :--- |
| `wip` | `🚧` | 进行中 | In progress / coding / executing tasks (default for new sessions) |
| `blocked` | `⏸️` | 等待/阻塞 | Waiting for user confirmation, input, or blocked |
| `review` | `👀` | 待验收 | Ready for user review or verification |
| `done` | `✅` | 已完成 | Task completed and delivered |
| `plan` | `💡` | 规划/调研 | Researching, planning, or designing |
| `bug` | `🐛` | 排障/修复 | Troubleshooting or fixing bugs |
| `clear` / `none` | — | Clear state | Strip existing state prefix and restore the plain title |

## Usage

```text
/state              # Inspect current session state, title, default state, and available presets
/state wip          # Set state to "🚧 进行中" (accepts key, label, or prefix)
/state review       # Switch to "👀 待验收" (existing prefixes are stripped automatically)
/state done         # Switch to "✅ 已完成"
/state clear        # Remove the state prefix (alias: /state none)
```

## Development

```bash
npm run check   # TypeScript typecheck
npm run build   # Build dist/ and lib/client.js
npm test        # Build and run unit tests
```
