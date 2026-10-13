# dsh-session-state

[中文](README.md) | English

Mark DeepSeek Harness session states using customizable title prefixes (Emoji or short text badges by default) — **purely for visual distinction in the session list, with no other behavioral side effects**.

Features:
- **Default state for new sessions**: Automatically prefixes newly titled sessions with your chosen default state (defaults to `wip` `🚧`, or choose any state / `none`), without interrupting background LLM title generation;
- **Agent tool `session_state`**: Lets the agent set a session's state by key as task phases change;
- **User command `/state`**: View, switch, or clear the current session's state prefix by key at any time;
- **Web Settings panel ("会话状态")**: Add, edit, or remove custom states (key, prefix, label, description), pick the default state for new sessions, toggle the model tool, and configure custom operator instructions;
- **Sidebar search filtering**: Type any state badge (e.g. `🚧`, `✅`, `👀`) into the native DSH sidebar search box to filter sessions by state immediately.

## Install

From GitHub (source install — runs this repository's `prepare` build):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-session-state
```

From a local checkout:

```bash
dsh plugin --profile web add link:/path/to/dsh-session-state
```

No manual configuration is needed: the bundled `cordis.patch.yml` mounts automatically — the model tool table gains `session_state`, the command table gains `/state`, and Settings gains the "会话状态" page.

> A source install needs Node ≥ 22.5 and runs the build (`tsc` + `esbuild`, producing `dist/` and `lib/client.js`). On pnpm ≥ 10, allow that build (`pnpm approve-builds`, or add this package to `onlyBuiltDependencies`).

## Permissions and compatibility

- **No network, no local file access, no external services.** The only write is appending one `session/title` event to the target session's own log (the host's own rename path).
- Only acts on **live** sessions in the current process (your own, or one open in the GUI); it never resumes a cold session.
- Requires a dsh host that provides the `sessionTitle` service (`@deepseek-ai/dsh-base` ships it). Without a `commands` service, `/state` is not registered and everything else keeps working.

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
/state wip          # Set state to "🚧 进行中"
/state review       # Switch to "👀 待验收" (existing prefixes are stripped automatically)
/state done         # Switch to "✅ 已完成"
/state none         # Remove the state prefix (alias: /state clear)
```

States are selected by **key** only (`wip`, `review`, `done`, …); labels and prefixes are display-only and are not accepted as input.

## Development

```bash
npm run check   # TypeScript typecheck
npm run build   # Build dist/ and lib/client.js
npm test        # Build and run unit tests
```
