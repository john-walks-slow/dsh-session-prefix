/**
 * 模型面工具 `session_state` 定义。
 *
 * 工具描述与参数说明根据当前 `SettingsSnapshot` 动态构建，确保用户在 Web 设置页修改状态预设、
 * 默认状态或自定义指令后，下一个回合的模型提示词立即反映最新状态表。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  defineTool,
  type ParameterSchemaSpec,
  type ToolCallView,
  type ToolDefinition,
  type ValueSchemaSpec,
} from "@deepseek-ai/dsh-tools";
import { readSettings, type SettingsConfig, type SettingsSnapshot } from "./config.js";
import { applySessionState, type StateTracker } from "./state.js";
import { targetSessionId } from "./target.js";
import { oneLine, quoted } from "./text.js";

const SESSION_STATE_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", required: true },
    state: { type: "string" },
    prefix: { type: "string" },
    label: { type: "string" },
    title: { type: "string", required: true },
    baseTitle: { type: "string", required: true },
    previousState: { type: "string" },
    seq: { type: "integer", required: true },
  },
} satisfies ValueSchemaSpec;

export function text(body: string): ContentBlock[] {
  return [{ type: "text", text: body }];
}

/** 构造状态预设的说明文本（用于工具描述与参数描述）。 */
export function buildStateCatalogText(settings: SettingsSnapshot): string {
  const lines = settings.states.map((item) => {
    const desc = item.description.length > 0 ? ` — ${item.description}` : "";
    return `- "${item.key}" (${item.prefix} ${item.label})${desc}`;
  });
  lines.push('- "none" / "clear" — Remove the state prefix and keep the plain title');
  return lines.join("\n");
}

/** 构建 `session_state` 工具定义。 */
export function stateToolDefinition(
  ctx: Context,
  tracker: StateTracker,
  settings: SettingsSnapshot,
  config?: SettingsConfig,
): ToolDefinition {
  const keysList = settings.states.map((item) => `"${item.key}" (${item.prefix})`).join(", ");
  const customNote = settings.allowCustomPrefix
    ? " A custom badge prefix is also allowed when no preset matches."
    : "";
  const defaultNote =
    settings.defaultState === "none"
      ? "New sessions have no automatic default state."
      : `New sessions start with default state "${settings.defaultState}".`;

  const stateParamDescription =
    `Target state key, label, or prefix (${keysList}), or "none" / "clear" to strip the state prefix.${customNote}`;

  const parameters = {
    state: {
      type: "string",
      required: true,
      description: stateParamDescription,
    },
    session_id: {
      type: "string",
      description:
        "Target session id. Omit to update the session you are running in. Only a session that is currently live " +
        "(your own, or one open in the UI) can be updated.",
    },
  } satisfies ParameterSchemaSpec;

  const baseDescription =
    "Mark or clear a session's visual project state by setting or replacing the state badge prefix on its title. " +
    "Existing state prefixes are stripped automatically before applying the new one so prefixes never stack. " +
    `This is purely a visual indicator in the session list and has no other behavioral side effects. ${defaultNote}\n\n` +
    `Available states:\n${buildStateCatalogText(settings)}`;

  const fullDescription =
    settings.instructions.length > 0
      ? `${baseDescription}\n\nOperator instructions for this tool:\n${settings.instructions}`
      : baseDescription;

  return defineTool({
    name: "session_state",
    description: fullDescription,
    parameters,
    output: {
      schema: SESSION_STATE_VALUE_SCHEMA,
      render: (_args, value) => {
        if (value.state === undefined) {
          return text(
            `Cleared state prefix on session ${value.sessionId}; title is now ${quoted(value.title, 80)} (seq ${value.seq}).`,
          );
        }
        return text(
          `Updated session ${value.sessionId} state to "${value.state}" (${value.prefix ?? ""} ${value.label ?? ""}); ` +
            `title is now ${quoted(value.title, 80)} (seq ${value.seq}).`,
        );
      },
    },
    presentCall(args): ToolCallView | undefined {
      const stateArg = typeof args.state === "string" ? oneLine(args.state, 24) : "";
      const target = typeof args.session_id === "string" ? ` on ${oneLine(args.session_id, 32)}` : "";
      return {
        card: "generic",
        kind: "edit",
        title: `session_state${target} → ${stateArg}`,
        rawInput: JSON.stringify(args),
      };
    },
    async execute(args, exec) {
      const target = targetSessionId(args.session_id, exec);
      // 执行时读取最新配置引用，保证设置页刚修改的状态表当即可用
      const currentSettings = config !== undefined ? readSettings(config) : settings;
      const outcome = applySessionState(ctx, tracker, target, args.state, currentSettings);
      return {
        sessionId: outcome.sessionId,
        ...(outcome.state === null ? {} : { state: outcome.state }),
        ...(outcome.prefix === null ? {} : { prefix: outcome.prefix }),
        ...(outcome.label === null ? {} : { label: outcome.label }),
        title: outcome.title,
        baseTitle: outcome.baseTitle,
        ...(outcome.previousState === null ? {} : { previousState: outcome.previousState }),
        seq: outcome.seq,
      };
    },
  });
}
