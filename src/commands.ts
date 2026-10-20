/**
 * 用户命令 `/prefix`：
 * - `/prefix` 或 `/prefix list`：查看当前会话的状态、标题、新会话默认状态及所有可用状态列表；
 * - `/prefix <key|label|prefix>`：将当前会话标记为对应状态（自动替换已有状态前缀）；
 * - `/prefix clear` 或 `/prefix none`：移除当前会话的状态前缀，恢复原始裸标题。
 *
 * 命令走宿主 `ctx.commands`（可选服务），在宿主侧直接执行、不进模型上下文。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { readSettings, type SettingsConfig } from "./config.js";
import { messageOf } from "./errors.js";
import { applySessionState, inspectSessionState, type StateTracker } from "./state.js";

interface CommandsLike {
  register(definition: {
    name: string;
    description: string;
    input?: { hint?: string; attachments?: boolean };
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
  }): () => void;
}

export function registerStateCommand(
  ctx: Context,
  tracker: StateTracker,
  config?: SettingsConfig,
): (() => void) | undefined {
  const commands = ctx.get("commands", false) as CommandsLike | undefined;
  if (commands === undefined) return undefined;

  return commands.register({
    name: "prefix",
    description:
      "Set, inspect, or clear this session's visual state prefix on its title by state key (e.g. /prefix wip, /prefix done, /prefix none, or /prefix to view).",
    input: { hint: "[<key> | none | list]" },
    handler(invocation): CommandResult {
      const settings = readSettings(config);
      const sessionId = invocation.agent.session.id;
      const agentCtx = (invocation.agent.ctx as Context | undefined) ?? ctx;
      const raw = invocation.rawInput.trim();

      if (raw.length === 0 || raw.toLowerCase() === "list") {
        try {
          const info = inspectSessionState(agentCtx, sessionId, settings);
          const currentDesc =
            info.state === null
              ? "none (no state prefix)"
              : `${info.state.key} (${info.state.prefix} ${info.state.label})`;
          const defaultPreset = settings.states.find((item) => item.key === settings.defaultState);
          const defaultDesc =
            settings.defaultState === "none" || defaultPreset === undefined
              ? "none"
              : `${defaultPreset.key} (${defaultPreset.prefix} ${defaultPreset.label})`;
          const catalog = settings.states
            .map(
              (item) =>
                `${item.key} (${item.prefix} ${item.label}${item.description ? ` — ${item.description}` : ""})`,
            )
            .join("; ");
          return {
            kind: "success",
            text:
              `Current state: ${currentDesc}. Title: "${info.fullTitle || "(untitled)"}". ` +
              `Default for new sessions: ${defaultDesc}. ` +
              `Available state keys: ${catalog}. Use /prefix <key> to set, or /prefix none to remove.`,
          };
        } catch (error) {
          return { kind: "error", text: `prefix: ${messageOf(error)}` };
        }
      }

      try {
        const outcome = applySessionState(agentCtx, tracker, sessionId, raw, settings);
        if (outcome.state === null) {
          return {
            kind: "success",
            text: `Cleared session state prefix; title is now "${outcome.title}".`,
          };
        }
        return {
          kind: "success",
          text: `Updated session state to ${outcome.prefix ?? ""} ${outcome.label ?? outcome.state} ("${outcome.title}").`,
        };
      } catch (error) {
        return { kind: "error", text: `prefix: ${messageOf(error)}` };
      }
    },
  });
}
