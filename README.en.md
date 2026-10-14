# session-prefix

[中文](README.md) | English

Mark DeepSeek Harness session states using customizable title prefixes (Emoji or short text badges by default) — **purely for visual distinction in the session list, with no other behavioral side effects**.

Features:
- **Default state for new sessions**: Automatically prefixes newly titled sessions with your chosen default state (defaults to `wip` `🚧`, or choose any state / `none`), without interrupting background LLM title generation;
- **Agent tool `session_prefix`**: Lets the agent set a session's state by key as task phases change;
- **User command `/state`**: View, switch, or clear the current session's state prefix by key at any time;
- **Title skip rule**: titles that already carry their own leading label (e.g. `Telegram · xxx` written by an IM bridge) are left untouched by every automatic prefixing path — the rule is a regex you can edit in Settings;
- **Web Settings panel ("会话状态")**: Add, edit, or remove custom states (key, prefix, label, description), pick the default state for new sessions, edit the title skip rule, toggle the model tool, and configure custom operator instructions;
- **Sidebar search filtering**: Type any state badge (e.g. `🚧`, `✅`, `👀`) into the native DSH sidebar search box to filter sessions by state immediately.

## Install

```bash
dsh plugin --profile web add session-prefix
```

From GitHub (source install — runs this repository's `prepare` build):

```bash
dsh plugin --profile web add github:john-walks-slow/session-prefix
```

From a local checkout:

```bash
dsh plugin --profile web add link:/path/to/session-prefix
```

No manual configuration is needed: the bundled `cordis.patch.yml` mounts automatically — the model tool table gains `session_prefix`, the command table gains `/state`, and Settings gains the "会话状态" page.

> A source install needs Node ≥ 22.5 and runs the build (`tsc` + `esbuild`, producing `dist/` and `lib/client.js`). On pnpm ≥ 10, allow that build (`pnpm approve-builds`, or add this package to `onlyBuiltDependencies`).

## Screenshots

![Sessions in different states in the sidebar](assets/screenshot-1-session-prefixes.png)

![The "会话状态" settings page](assets/screenshot-2-settings.png)

## Permissions and compatibility

- **No network, no local file access, no external services.** The only write is appending one `session/title` event to the target session's own log (the host's own rename path).
- **Title skip rule (`skipPattern`)**: when a title matches the regex after this plugin's own state prefix is stripped (default `^\S+ · `, i.e. titles that already start with their own label such as `Telegram · xxx`), every **automatic** path (new-session default state, running-state fallback, Jev inference) leaves it alone — the label has to stay first, and pushing it aside makes the other system re-add it as `Telegram · 🚧 Telegram · xxx`. Explicit `/state` and tool calls are never blocked; clear the field to disable the rule.
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

**No configuration needed**: the tool description itself states that the agent maintains the badge on its own initiative as phases change, and each state's description is the criterion for when it applies. Extra operator instructions are only for additional preferences (for example "never set done without my confirmation").

## Development

```bash
npm run check   # TypeScript typecheck
npm run build   # Build dist/ and lib/client.js
npm test        # Build and run unit tests
```

## Community

- Thanks to the [LINUX DO](https://linux.do/) community for providing the discussion environment.
