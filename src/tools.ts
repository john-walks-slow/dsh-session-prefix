/**
 * 模型面工具 `session_state` 定义。
 *
 * 工具描述与参数说明根据当前 `SettingsSnapshot` 动态构建，确保用户在 Web 设置页修改状态预设、
 * 默认状态或自定义指令后，下一个回合的模型提示词立即反映最新状态表。
 * 输入面只有状态 `key`（外加 `"none"` / `"clear"`），名称与前缀仅供模型识别，不作为入参。
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

/** 状态预设的说明文本（列在工具描述里，供模型选 key 与判断时机）。 */
export function buildStateCatalogText(settings: SettingsSnapshot): string {
  const lines = settings.states.map((item) => {
    const desc = item.description.length > 0 ? ` — ${item.description}` : "";
    return `- "${item.key}" (${item.prefix} ${item.label})${desc}`;
  });
  lines.push('- "none" — Remove the state badge (the title keeps its plain text)');
  return lines.join("\n");
}

/** 构建 `session_state` 工具定义。 */
export function stateToolDefinition(
  ctx: Context,
  tracker: StateTracker,
  settings: SettingsSnapshot,
  config?: SettingsConfig,
): ToolDefinition {
  const keysList = settings.states.map((item) => `"${item.key}"`).join(", ");
  const defaultNote =
    settings.defaultState === "none"
      ? "New sessions start with no state badge."
      : `New sessions already start in state "${settings.defaultState}" — do not set it again, just move it forward when the phase changes.`;

  const parameters = {
    state: {
      type: "string",
      required: true,
      description: `State key, one of: ${keysList}, or "none" to strip the state prefix.`,
    },
    session_id: {
      type: "string",
      description:
        "Target session id. Omit to update the session you are running in. Only a session that is currently live " +
        "(your own, or one open in the UI) can be updated.",
    },
  } satisfies ParameterSchemaSpec;

  // 默认契约写在这里（而不是让用户去填自定义指令）：不填任何指令时，模型也应自主维护这个标记。
  const baseDescription =
    "Keep the visual project state of a session current by setting or replacing the state badge prefix on its title. " +
    "Maintain it on your own initiative: whenever the session moves into a different phase, update the badge without " +
    "being asked. It is cheap and safe — a purely visual marker in the session list with no other behavioral side " +
    "effects — so prefer updating it over leaving it stale. Pick the state whose description matches the current " +
    "phase; if no state clearly matches, leave the badge as it is. Switching strips any existing prefix first, so " +
    `badges never stack. ${defaultNote}\n\n` +
    "Use each state's description as the criterion for when it applies:\n" +
    buildStateCatalogText(settings);

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
