/**
 * session-prefix — 用会话标题前缀（可自定义，默认 Emoji）标记项目状态：
 * - 面向 Agent 的工具：`session_prefix`
 * - 面向用户的命令：`/state`
 * - 新会话默认状态：监听 `session/title` 的 `fallback`/`provider` 事件自动挂载默认状态前缀，
 *   不打断后台自动标题生成，且在 LLM 生成新标题后自动衔接状态前缀
 * - Web 插件设置页：开关工具、选择新会话默认状态、配置自定义指令、可视化增删改状态列表
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import { disposeTools, syncTools, type Registration } from "./assembly.js";
import { registerStateCommand } from "./commands.js";
import { readSettings, type SettingsConfig } from "./config.js";
import { abortAllJevInferences, JevInferenceManager, probeJevEndpoint, runJevStateInference } from "./jev.js";
import {
  createStateTracker,
  handleAutoSessionTitleEvent,
  type AutoTitledSession,
  type SessionTitleEventPayload,
} from "./state.js";

export const name = "session-prefix";

/** 仅强依赖 tools；sessions / sessionTitle / commands / connection 一律按需懒取，保证各部署形态兼容。 */
export const inject = ["tools"];

/** Web 壳提供的 Fetch 路由注册面（不在 cordis 的 Context 类型上）。 */
interface JevProbeConnection {
  fetch: { register(route: unknown): () => Promise<void> };
}

export { Config, DEFAULT_STATES } from "./config.js";
export type { SettingsConfig, SettingsSnapshot, StatePreset } from "./config.js";
export {
  runJevStateInference,
  queryJevState,
  extractTurnContext,
  resolveJevCredentials,
  JevInferenceManager,
  defaultJevManager,
  abortAllJevInferences,
} from "./jev.js";

export function apply(ctx: Context, config?: SettingsConfig): () => void {
  const tracker = createStateTracker();
  const jevManager = new JevInferenceManager();
  const registered: Registration[] = [];
  syncTools(ctx, tracker, readSettings(config), registered, config);

  const disposers: (() => void)[] = [];

  // Jev 测速路由：浏览器读不到 process.env，因此探测在宿主进程内执行，
  // 复用与回合推断同源的凭据解析（插件设置 → 环境变量 → 默认值）。
  // 用 ctx.inject 等待 connection 就绪：它是 Web 壳提供的服务，apply 时可能尚未挂载。
  ctx.inject(["connection"], (connCtx) => {
    // `connection` 由 Web 壳提供，不在 cordis 的 Context 类型面上。
    const conn = (connCtx as unknown as { connection: JevProbeConnection }).connection;
    const disposeProbe = connCtx.effect(() =>
      conn.fetch.register({
        path: "/api/session-prefix/jev-probe",
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request: Request) => {
          const body = (await request.json().catch(() => ({}))) as {
            baseUrl?: string;
            model?: string;
          };
          return Response.json(await probeJevEndpoint(body, readSettings(config)));
        },
      })
    );
    disposers.push(disposeProbe);
  });

  const disposeCommand = registerStateCommand(ctx, tracker, config);
  if (disposeCommand === undefined) {
    ctx.logger.info("session-prefix: no command service available; /state is not registered");
  } else {
    disposers.push(disposeCommand);
  }

  disposers.push(
    ctx.on(
      "session/event",
      (
        session: AutoTitledSession,
        event: { readonly type: string; readonly data?: unknown },
      ) => {
        if (event.type === "turn/start") {
          syncTools(ctx, tracker, readSettings(config), registered, config);
          queueMicrotask(() => {
            void runJevStateInference(ctx, session, "start", tracker, () => readSettings(config), jevManager).catch((error) => {
              ctx.logger.warn(
                `session-prefix: Jev turn/start inference error for ${session.id}: ${String(error)}`,
              );
            });
          });
          return;
        }

        if (event.type === "turn/end") {
          queueMicrotask(() => {
            void runJevStateInference(ctx, session, "end", tracker, () => readSettings(config), jevManager).catch((error) => {
              ctx.logger.warn(
                `session-prefix: Jev turn/end inference error for ${session.id}: ${String(error)}`,
              );
            });
          });
          return;
        }

        if (event.type !== "session/title" || event.data === undefined || event.data === null) return;
        // 宿主在 `Session.append` 的发布过程中同步派发 session/event，而 append 有重入守卫
        // （"session append cannot reenter while another append is being published"），
        // 所以写回推迟到 microtask：那时本次 append 已经收尾。
        const payload = event.data as SessionTitleEventPayload;
        queueMicrotask(() => {
          try {
            handleAutoSessionTitleEvent(session, payload, tracker, readSettings(config));
          } catch (error) {
            ctx.logger.warn(
              `session-prefix: failed to apply state prefix on session/title for ${session.id}: ${String(error)}`,
            );
          }
        });
      },
    ),
  );

  return () => {
    jevManager.abortAll();
    for (const dispose of disposers) dispose();
    disposeTools(registered);
  };
}
