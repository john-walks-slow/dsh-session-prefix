# dsh-session-prefix

[中文](README.md) | English

> Automatic session classification for DeepSeek Harness via Jev decision models or Agent tools, displayed directly as title emoji prefixes.

As conversations accumulate in DeepSeek Harness, the sidebar quickly fills up with a flat list of titles, making it difficult to spot what each session is doing. `dsh-session-prefix` classifies sessions automatically and puts status emojis right at the front of each title:

| Sidebar Badges | Settings Panel |
| :---: | :---: |
| ![Sidebar session prefixes](assets/screenshot-1-session-prefixes.png) | ![Settings page](assets/screenshot-2-settings.png) |

---

## Quick Install

```bash
# Online install
dsh plugin --profile web add dsh-session-prefix

# From GitHub source
dsh plugin --profile web add github:john-walks-slow/dsh-session-prefix

# Local checkout
dsh plugin --profile web add link:/path/to/session-prefix
```

No manual setup required: the plugin automatically mounts with the `session_prefix` tool, the `/prefix` slash command, and the "会话前缀" settings tab.

---

## Auto-Classification Mechanisms

`dsh-session-prefix` provides two complementary ways to classify sessions automatically. Both work out of the box and can run independently or in tandem:

### 1. Jev Decision Model Classification (Zero-Config & Seamless)
- **Zero Prompt bloat, zero context overhead**: Leverages the lightweight TypeSafe Jev decision model for phase classification. No need to inject long prompt instructions or consume your primary model's context budget.
- **Adaptive lifecycle awareness**:
  - **Mid-turn responsiveness**: When you submit a new instruction, it quickly detects intent shifts (e.g., from development to testing, debugging, or planning) in combination with recent outputs.
  - **Turn-end precision**: Once the Agent finishes its work, the session is classified based on the actual outcome (e.g., marked as ready for review `👀` or completed `✅`).
- **Privacy-conscious & lightweight**: Only the immediate instruction and output summaries are provided to the decision model (full historical context is never transmitted). Silently skips if no API key is configured without interrupting the session.

### 2. Agent Tool-Driven Classification (Proactive Badge Maintenance)
- **Model autonomy**: Equips the Agent with the `session_prefix` tool, allowing it to advance its state badge as work progresses across multi-stage tasks.
- **Self-explanatory criteria**: Tool descriptions clearly define when each badge applies. You can also append custom rules in Settings (e.g., "never mark as done without explicit user approval").

### 3. Lifecycle Healing & Smooth Auto-Naming
- **Active state fallback**: When you send a follow-up message in a resting session (`⏸️` blocked / `👀` review / `✅` done), the badge immediately resets to in-progress (`🚧`), reflecting real-time activity.
- **Seamless title provider compatibility**: New sessions automatically receive a default badge (`🚧`) without interrupting background LLM title generation. Once the title is generated, the prefix reattaches smoothly.

---

## Default Classification System

| Prefix Emoji | State Key | Label | Applicable Phase |
| :---: | :--- | :--- | :--- |
| `🚧` | `wip` | In Progress | Coding, implementing, or running tasks (default for new sessions) |
| `⏸️` | `blocked` | Waiting/Blocked | Awaiting user input, approvals, or stuck on blockers |
| `👀` | `review` | Review | Implementation or plan ready for user verification |
| `✅` | `done` | Done | All session goals delivered and completed |
| `💡` | `plan` | Planning | Requirements discovery, system design, or discussions |
| `🐛` | `bug` | Debugging | Troubleshooting, incident triage, or bug fixing |

> **Tip**: Type an emoji (such as `🚧` or `✅`) directly into the sidebar search bar to instantly filter sessions by category.

---

## Controls & Customization

### Slash Command `/prefix`
Inspect, switch, or reset classifications anytime:

```text
/prefix              # Show current state and list available presets
/prefix review       # Switch to "👀 Review"
/prefix done         # Switch to "✅ Done"
/prefix none         # Clear prefix, restoring clean title
```

### Web Settings Page (Settings → 会话前缀)
- **Preset Management**: Add, remove, or customize state prefixes (supports emojis or short text like `[DEV]`).
- **Jev Configuration**: Toggle inference, configure API keys, models, endpoints, and run one-click latency probes.
- **Title Skip Rules**: Built-in regex rule (default `^\S+ · `) automatically ignores titles with external service tags (e.g. `Telegram · xxx`), preventing badge duplication.
- **Purely visual, zero side effects**: The only modification is renaming the title string in the session header. No data corruption, no behavioral side effects.

---

## Development

```bash
npm run check       # TypeScript check
npm run build       # Build dist/ and lib/client.js
npm test            # Run unit tests
```

## Acknowledgments
- Thanks to the [LINUX DO](https://linux.do/) community for the discussion environment.
