# 261014 插件改名后线上 profile 残留旧名，web 端 client bundle 加载失败

## 现象

dsh web（4180）打开即报：

```
Failed to load plugins
dsh-session-state
web boot: 1 entry did not activate
dsh-session-state: import failed: client-modules: could not load "dsh-session-state":
  plugins/??…,dsh-session-state/client.js&rev=d2e190a363b4: already executed without registering "dsh-session-state";
  plugins/??dsh-session-state/client.js&rev=6b9bce196435: loaded without registering "dsh-session-state" via __ModuleLoader__.load
```

影响面：仅 Web 设置页一个 entry 未激活；host 侧插件（标题前缀、徽标、`/state`、`session_prefix` 工具）全程正常。

## 根因

插件在 2026-10-14 09:40 前后由 `dsh-session-state` 改名为 `session-prefix`（目录 `/root/projects/dsh-session-state` → `/root/projects/session-prefix`），
package name、client bundle 注册 id（`id: "session-prefix"`）、README 均已同步，**但线上 profile 未跟进**，三处仍是旧名：

1. `~/.dsh/profiles/web/package.json`：依赖键 `"dsh-session-state": "link:/root/projects/dsh-session-state"` + `dsh.profile.bundles` 含 `dsh-session-state`；
2. `~/.dsh/profiles/web/node_modules/dsh-session-state`：指向已删除目录的**悬空软链**；
3. `~/.dsh/profiles/web/cordis.patch.yml:1366`：`- id: session-state / name: dsh-session-state` 仍为启用行。

dsh 于 05:03 启动（早于改名），插件图按旧名构建。浏览器请求 host 组合的批式 combo bundle 时，
`dsh-session-state` 段解析不到文件 → 整批其余 27 个包正常注册、它自己没注册 →
`loaded without registering`。旧名 entry 因此永久 `not-registered`。

### 判定依据

- 悬空软链：`readlink -f node_modules/dsh-session-state` → `/root/projects/dsh-session-state`（不存在）；
- 会话存档曾以旧名发布过 npm 包 `dsh-session-state@0.1.0`（registry 现存），印证该名是历史上线名；
- `/plugins/<id>/client.js` 对**健康插件同样 404**（单包 URL 已废弃，改走 combo），故 404 非本次原因。

## 修复

`DshPluginManager.setBundleEnabled` 走 `hmr.runExclusive` + `reconcileProfilePatches`，纯热重载、无需重启。

1. 备份 profile：`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` → `.bak-rename-20261014-115623/`；
2. `package.json`：依赖键与 `bundles` 项 `dsh-session-state` → `session-prefix`（link 目标改为 `/root/projects/session-prefix`）；
3. `cordis.patch.yml`：`- id: session-state / name: dsh-session-state` → `- id: session-prefix / name: session-prefix`（config 段不变）；
4. 删除悬空软链 `node_modules/dsh-session-state`，`pnpm install` 重建（`Package: -57` 为悬空链接清理，非误删；46 个依赖零异常）；
5. `pluginManager/setBundleEnabled({name:"session-prefix", enabled:false})` → `true` 触发热重载，两次均 `application: "applied"`、`changed: true`。

## 验收证据

| 检查项 | 结果 |
|---|---|
| `listPlugins` | 新增 `include:session-prefix`（`enabled: true`、`fiberPhase: active`、`patchId: session-prefix`），行数 231 → 233 |
| 首页 `__DSH_BOOT__` | `dsh-session-state` 0 次；`session-prefix` 1 个 entry，URL `plugins/??session-prefix/client.js&rev=d4c9f3317afc` |
| 该 URL | HTTP 200 / 28368 B；注册 `id: "session-prefix"` |
| 真实浏览器（Playwright headless） | **无 `Failed to load plugins`**；consoleErrors `[]`、失败请求 `[]` |
| 插件设置页 | 渲染 `session-prefix v0.1.0`、`Components 1 total · 1 running`、开关已启用 |

## 遗留（未处理，待决策）

- **npm 包名仍是旧名**：registry 上 `dsh-session-state@0.1.0` 存在，`session-prefix` 尚未发布。
  改名未传导到发布链路；如需对外发布新名，须另行 `npm publish`。
- **失效工作区行**：`~/.dsh/storages/workspace.json:3625` 仍指向 `/root/projects/dsh-session-state`，
  侧边栏显示为一条空工作区。历史会话日志目录 `~/.dsh/sessions/--root-projects-dsh-session-state--` 保留（不动，避免破坏历史数据）。
- **历史文档被改写**：本次改名的 find/replace 把 `docs/features/261013-session-state/*` 的**历史记录**一并改成了 `session-prefix`
  （如 summary §4 声称「线上 profile 已是 session-prefix」，与当时事实不符）。`git show HEAD:<old path>` 是唯一可信来源。

## 教训

1. **改名要三处齐步**：目录名、profile 依赖键+bundles、cordis patch 行 id/name。漏掉 profile 这层，
   运行中的 dsh 会一直按旧名构建 client 图，表现为前端单 entry 不激活。
2. **不要 find/replace 历史文档**：`docs/features/`、`docs/issues/` 是当时事实的记录，改名应新增说明而非回改历史。
   本次正是被改写的文档一度误导了归因方向。
3. **`/plugins/<id>/client.js` 404 无诊断价值**：先取首页 `__DSH_BOOT__` 看 combo 图，再验 combo URL。
