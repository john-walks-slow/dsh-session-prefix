/**
 * dsh-session-state — 用会话标题前缀（可自定义，默认 Emoji）标记项目状态：
 * - 面向 Agent 的工具：`session_state`
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
import {
  createStateTracker,
  handleAutoSessionTitleEvent,
  type AutoTitledSession,
  type SessionTitleEventPayload,
} from "./state.js";

export const name = "dsh-session-state";

/** 仅强依赖 tools；sessions / sessionTitle / commands 一律按需懒取，保证各部署形态兼容。 */
export const inject = ["tools"];

export { Config, DEFAULT_STATES } from "./config.js";
export type { SettingsConfig, SettingsSnapshot, StatePreset } from "./config.js";

export function apply(ctx: Context, config?: SettingsConfig): () => void {
  const tracker = createStateTracker();
  const registered: Registration[] = [];
  syncTools(ctx, tracker, readSettings(config), registered, config);

  const disposers: (() => void)[] = [];

  const disposeCommand = registerStateCommand(ctx, tracker, config);
  if (disposeCommand === undefined) {
    ctx.logger.info("dsh-session-state: no command service available; /state is not registered");
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
        } else if (event.type === "session/title" && event.data !== undefined && event.data !== null) {
          try {
            handleAutoSessionTitleEvent(
              session,
              event.data as SessionTitleEventPayload,
              tracker,
              readSettings(config),
            );
          } catch (error) {
            ctx.logger.warn(
              `dsh-session-state: failed to apply state prefix on session/title for ${session.id}: ${String(error)}`,
            );
          }
        }
      },
    ),
  );

  return () => {
    for (const dispose of disposers) dispose();
    disposeTools(registered);
  };
}
