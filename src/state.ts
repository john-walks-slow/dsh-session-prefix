/**
 * 会话状态领域逻辑：
 * - 以会话标题（`session/title`）的前缀作为唯一事实来源；
 * - 切换状态时先剥离已有前缀再拼接新前缀，杜绝多个前缀叠加；
 * - 监听宿主自动生成的 `fallback` / `provider` 标题事件，为新会话自动挂载 `defaultState` 前缀，
 *   并在异步 LLM 标题生成完成时保持状态前缀不丢失、且不打断后台自动起名。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  DEFAULT_STATES,
  isClearKeyword,
  sanitizePrefix,
  type SettingsSnapshot,
  type StatePreset,
} from "./config.js";
import { isNamedError, messageOf } from "./errors.js";
import { requireSessions, requireSessionTitles } from "./services.js";

/** 空会话尚无任何消息或标题时的兜底基底标题。 */
const EMPTY_BASE_TITLE = "新会话";

/** 宿主标题默认最大 UTF-8 字节数（与 dsh-session-title 默认对齐）。 */
const MAX_TITLE_UTF8_BYTES = 200;

/** 识别出的状态信息。 */
export interface MatchedState {
  readonly key: string;
  readonly prefix: string;
  readonly label: string;
}

/** 标题解析结果：拆分出当前状态与剥离前缀后的裸标题。 */
export interface ParsedTitleState {
  readonly state: MatchedState | null;
  readonly baseTitle: string;
  readonly fullTitle: string;
}

/** 查询会话当前状态的结果。 */
export interface SessionStateInspection {
  readonly sessionId: string;
  readonly state: MatchedState | null;
  readonly fullTitle: string;
  readonly baseTitle: string;
}

/** 更新会话状态的结果。 */
export interface ApplyStateOutcome {
  readonly sessionId: string;
  readonly state: string | null;
  readonly prefix: string | null;
  readonly label: string | null;
  readonly title: string;
  readonly baseTitle: string;
  readonly previousState: string | null;
  readonly seq: number;
}

/**
 * 进程内轻量状态追踪器：
 * - `assigned`：记录会话最近一次生效的状态（供异步 `provider` 标题写回时保持前缀）；
 * - `cleared`：记录用户/Agent 显式执行过 `clear`/`none` 的会话（不再对其自动套用 `defaultState`）；
 * - `knownPrefixes`：记录曾使用过的自定义前缀，确保后续切换或清除时能干净剥离。
 */
export interface StateTracker {
  readonly assigned: Map<string, MatchedState>;
  readonly cleared: Set<string>;
  readonly knownPrefixes: Set<string>;
}

export function createStateTracker(): StateTracker {
  return {
    assigned: new Map(),
    cleared: new Set(),
    knownPrefixes: new Set(),
  };
}

/**
 * 汇总所有已知的状态候选项（当前配置优先，补充内置默认与历史自定义前缀），按前缀长度降序排列。
 */
export function collectKnownStates(
  settings: SettingsSnapshot,
  tracker?: StateTracker,
): readonly MatchedState[] {
  const map = new Map<string, MatchedState>();
  for (const item of settings.states) {
    if (!map.has(item.prefix)) {
      map.set(item.prefix, { key: item.key, prefix: item.prefix, label: item.label });
    }
  }
  for (const item of DEFAULT_STATES) {
    if (!map.has(item.prefix)) {
      map.set(item.prefix, { key: item.key, prefix: item.prefix, label: item.label });
    }
  }
  if (tracker !== undefined) {
    for (const prefix of tracker.knownPrefixes) {
      if (!map.has(prefix)) {
        map.set(prefix, { key: "custom", prefix, label: prefix });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * 解析标题开头的状态前缀，并剥离所有连续的已知状态前缀。
 */
export function parseTitleState(
  rawTitle: string,
  settings: SettingsSnapshot,
  tracker?: StateTracker,
): ParsedTitleState {
  const fullTitle = rawTitle.trim();
  if (fullTitle.length === 0) {
    return { state: null, baseTitle: "", fullTitle: "" };
  }
  const candidates = collectKnownStates(settings, tracker);
  let remaining = fullTitle;
  let firstMatched: MatchedState | null = null;

  // 循环剥离连续前缀，彻底防止历史叠罗汉（如 "✅ 🚧 标题"）
  let stripped = true;
  while (stripped && remaining.length > 0) {
    stripped = false;
    for (const candidate of candidates) {
      if (remaining === candidate.prefix) {
        if (firstMatched === null) firstMatched = candidate;
        remaining = "";
        stripped = true;
        break;
      }
      if (remaining.startsWith(`${candidate.prefix} `)) {
        if (firstMatched === null) firstMatched = candidate;
        remaining = remaining.slice(candidate.prefix.length).trimStart();
        stripped = true;
        break;
      }
    }
  }

  return {
    state: firstMatched,
    baseTitle: remaining,
    fullTitle,
  };
}

/**
 * 解析用户或模型输入的目标状态字符串。
 * @returns `{ kind: "clear" }` 或 `{ kind: "set", target: MatchedState }`。
 */
export function resolveTargetState(
  rawInput: string,
  settings: SettingsSnapshot,
): { readonly kind: "clear" } | { readonly kind: "set"; readonly target: MatchedState } {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `state must be a non-empty string (use one of: ${formatValidStates(settings)}, or "clear" / "none")`,
    );
  }
  if (isClearKeyword(trimmed)) {
    return { kind: "clear" };
  }
  const lower = trimmed.toLowerCase();
  const matched = settings.states.find(
    (item) =>
      item.key.toLowerCase() === lower ||
      item.label.toLowerCase() === lower ||
      item.prefix === trimmed,
  );
  if (matched !== undefined) {
    return {
      kind: "set",
      target: { key: matched.key, prefix: matched.prefix, label: matched.label },
    };
  }
  if (settings.allowCustomPrefix) {
    const customPrefix = sanitizePrefix(trimmed);
    if (customPrefix.length > 0) {
      return {
        kind: "set",
        target: { key: "custom", prefix: customPrefix, label: customPrefix },
      };
    }
  }
  throw new Error(
    `unknown session state "${trimmed}" — valid states are: ${formatValidStates(settings)}, or "clear" / "none" to remove the state prefix`,
  );
}

/** 格式化当前合法的状态列表供报错或提示使用。 */
export function formatValidStates(settings: SettingsSnapshot): string {
  return settings.states.map((item) => `${item.key} (${item.prefix} ${item.label})`).join(", ");
}

/**
 * 从会话事件流提取首条合格人类消息的 fallback 标题（当 `titles.get(session)` 尚为 `undefined` 时兜底）。
 */
function fallbackTitleFromEvents(session: { snapshotEvents?: () => readonly unknown[] }): string {
  if (typeof session.snapshotEvents !== "function") return "";
  const events = session.snapshotEvents();
  for (const raw of events) {
    const event = raw as {
      type?: string;
      data?: { source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] };
    };
    if (event.type !== "user/message" || event.data?.source?.kind !== "user") continue;
    const blocks = Array.isArray(event.data.content) ? event.data.content : [];
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(" ")
      .replace(/[\u0000-\u001F\u007F-\u009F]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (text.length === 0) continue;
    const words = text.split(" ").filter(Boolean).slice(0, 7).join(" ");
    return truncateUtf8(words, 80).trimEnd();
  }
  return "";
}

/** 按 UTF-8 字节上限安全截断字符串，不切碎 Unicode 码点。 */
export function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let used = 0;
  let output = "";
  for (const ch of input) {
    const bytes = Buffer.byteLength(ch, "utf8");
    if (used + bytes > maxBytes) break;
    output += ch;
    used += bytes;
  }
  return output.trimEnd();
}

/**
 * 读取一个 live 会话当前的状态与标题信息。
 */
export function inspectSessionState(
  ctx: Context,
  sessionId: string,
  settings: SettingsSnapshot,
  tracker?: StateTracker,
): SessionStateInspection {
  const sessions = requireSessions(ctx);
  const titles = requireSessionTitles(ctx);
  const session = sessions.get(sessionId as SessionId);
  if (session === undefined) {
    throw new Error(
      `cannot inspect session "${sessionId}": it is not loaded in this process — only a live session can be inspected`,
    );
  }
  const currentTitle = titles.get(session)?.title ?? fallbackTitleFromEvents(session);
  const parsed = parseTitleState(currentTitle, settings, tracker);
  return {
    sessionId,
    state: parsed.state,
    fullTitle: parsed.fullTitle,
    baseTitle: parsed.baseTitle,
  };
}

/**
 * 设置、切换或清除一个 live 会话的状态前缀。
 */
export function applySessionState(
  ctx: Context,
  tracker: StateTracker,
  sessionId: string,
  rawState: string,
  settings: SettingsSnapshot,
): ApplyStateOutcome {
  const sessions = requireSessions(ctx);
  const titles = requireSessionTitles(ctx);
  const session = sessions.get(sessionId as SessionId);
  if (session === undefined) {
    throw new Error(
      `cannot update state of session "${sessionId}": it is not loaded in this process — only a live session ` +
        "(your own, or one currently open in the UI) can be updated",
    );
  }

  const resolution = resolveTargetState(rawState, settings);
  const existingSnapshot = titles.get(session);
  const rawCurrentTitle = existingSnapshot?.title ?? fallbackTitleFromEvents(session);
  const parsed = parseTitleState(rawCurrentTitle, settings, tracker);
  const previousState = parsed.state?.key ?? null;
  const baseTitle = parsed.baseTitle.length > 0 ? parsed.baseTitle : EMPTY_BASE_TITLE;

  let nextTitle: string;
  let nextStateKey: string | null;
  let nextPrefix: string | null;
  let nextLabel: string | null;

  if (resolution.kind === "clear") {
    tracker.cleared.add(sessionId);
    tracker.assigned.delete(sessionId);
    nextTitle = baseTitle;
    nextStateKey = null;
    nextPrefix = null;
    nextLabel = null;
  } else {
    const { target } = resolution;
    tracker.cleared.delete(sessionId);
    tracker.assigned.set(sessionId, target);
    tracker.knownPrefixes.add(target.prefix);
    nextTitle = `${target.prefix} ${baseTitle}`;
    nextStateKey = target.key;
    nextPrefix = target.prefix;
    nextLabel = target.label;
  }

  try {
    const accepted = titles.rename(session, nextTitle);
    const acceptedParsed = parseTitleState(accepted.title, settings, tracker);
    return {
      sessionId,
      state: nextStateKey,
      prefix: nextPrefix,
      label: nextLabel,
      title: accepted.title,
      baseTitle: acceptedParsed.baseTitle.length > 0 ? acceptedParsed.baseTitle : baseTitle,
      previousState,
      seq: accepted.eventSeq,
    };
  } catch (error) {
    if (isNamedError(error, "SessionTitleInvalidError")) {
      throw new Error(
        `cannot update state of session "${sessionId}": the resulting title is empty after normalization`,
      );
    }
    throw new Error(`cannot update state of session "${sessionId}": ${messageOf(error)}`);
  }
}

/**
 * 宿主自动生成标题时的钩子形状（最小切片，避免强耦合宿主内部类）。
 */
export interface AutoTitledSession {
  readonly id: string;
  readonly header?: {
    readonly parentSession?: string;
    readonly origin?: string;
  };
  append(
    type: "session/title",
    data: {
      readonly title: string;
      readonly messageSeqs: readonly number[];
      readonly source: { readonly kind: string; readonly [key: string]: unknown };
    },
  ): void;
}

export interface SessionTitleEventPayload {
  readonly title: string;
  readonly messageSeqs: readonly number[];
  readonly source: { readonly kind: string; readonly [key: string]: unknown };
}

/**
 * 监听 `session/title` 事件：
 * - 当宿主生成 `fallback`（首句摘要）或 `provider`（LLM 自动命名）标题时：
 *   1. 若会话是子代理会话，跳过；
 *   2. 若会话曾被显式 `clear`，跳过；
 *   3. 若当前标题已经带有状态前缀，跳过（防重入）；
 *   4. 取该会话已记录的状态，或（对新会话）取 `settings.defaultState`；
 *   5. 用相同的 `source` 追加带前缀的 `session/title` 事件——既立即展示默认状态前缀，
 *      又不触发 `user` source 的锁定，让后台正在运行的 LLM 标题生成继续完成并在落地后自动衔接前缀！
 */
export function handleAutoSessionTitleEvent(
  session: AutoTitledSession,
  data: SessionTitleEventPayload,
  tracker: StateTracker,
  settings: SettingsSnapshot,
): boolean {
  if (session.header?.parentSession !== undefined || session.header?.origin === "subagent") {
    return false;
  }
  const sourceKind = data?.source?.kind;
  if (sourceKind !== "fallback" && sourceKind !== "provider") {
    return false;
  }
  if (tracker.cleared.has(session.id)) {
    return false;
  }

  const parsed = parseTitleState(data.title, settings, tracker);
  if (parsed.state !== null) {
    // 标题已经带有已知状态前缀，同步记录即可，不再重复追加
    tracker.assigned.set(session.id, parsed.state);
    return false;
  }

  let target = tracker.assigned.get(session.id);
  if (target === undefined) {
    if (settings.defaultState === "none") return false;
    const preset = settings.states.find((item) => item.key === settings.defaultState);
    if (preset === undefined) return false;
    target = { key: preset.key, prefix: preset.prefix, label: preset.label };
    tracker.assigned.set(session.id, target);
  }

  const base = parsed.baseTitle.length > 0 ? parsed.baseTitle : data.title.trim();
  if (base.length === 0) return false;
  const prefixed = truncateUtf8(`${target.prefix} ${base}`, MAX_TITLE_UTF8_BYTES);
  if (prefixed === data.title) return false;

  session.append("session/title", {
    title: prefixed,
    messageSeqs: Array.isArray(data.messageSeqs) ? [...data.messageSeqs] : [],
    source: data.source,
  });
  return true;
}
