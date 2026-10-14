/**
 * 会话状态领域逻辑：
 * - 以会话标题（`session/title`）的前缀作为唯一事实来源；
 * - 状态只按 `key` 选择（外加 `none` / `clear` 清除），名称与前缀仅用于展示；
 * - 切换状态时先剥离已有前缀再拼接新前缀，杜绝多个前缀叠加；
 * - 监听宿主自动生成的 `fallback` / `provider` 标题事件，为新会话自动挂载 `defaultState` 前缀，
 *   并在异步 LLM 标题生成完成时保持状态前缀不丢失、且不打断后台自动起名。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { DEFAULT_STATES, isClearKeyword, type SettingsSnapshot, type StatePreset } from "./config.js";
import { isNamedError, messageOf } from "./errors.js";
import { requireSessions, requireSessionTitles } from "./services.js";

/** 空会话尚无任何消息或标题时的兜底基底标题。 */
const EMPTY_BASE_TITLE = "新会话";

/** 宿主标题默认最大 UTF-8 字节数（与 dsh-session-title 默认对齐）。 */
const MAX_TITLE_UTF8_BYTES = 200;

/** 一个可用的状态（key 是选择用的标识，prefix/label 只用于展示与拼接）。 */
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
  /** 更新后的状态 key；`null` 表示已清除状态前缀。 */
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
 * - `cleared`：记录用户/Agent 显式执行过 `clear`/`none` 的会话（不再对其自动套用 `defaultState`）。
 */
export interface StateTracker {
  readonly assigned: Map<string, MatchedState>;
  readonly cleared: Set<string>;
}

export function createStateTracker(): StateTracker {
  return {
    assigned: new Map(),
    cleared: new Set(),
  };
}

/** 当前配置下全部已知状态（按前缀长度降序，便于先匹配长前缀）。 */
export function collectKnownStates(settings: SettingsSnapshot): readonly MatchedState[] {
  const map = new Map<string, MatchedState>();
  for (const item of [...settings.states, ...DEFAULT_STATES]) {
    if (!map.has(item.prefix)) {
      map.set(item.prefix, { key: item.key, prefix: item.prefix, label: item.label });
    }
  }
  return [...map.values()].sort((a, b) => b.prefix.length - a.prefix.length);
}

/** 解析标题开头的状态前缀，并剥离所有连续的已知状态前缀。 */
export function parseTitleState(rawTitle: string, settings: SettingsSnapshot): ParsedTitleState {
  const fullTitle = rawTitle.trim();
  if (fullTitle.length === 0) {
    return { state: null, baseTitle: "", fullTitle: "" };
  }
  const candidates = collectKnownStates(settings);
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
 * 解析用户或模型输入的目标状态：只认状态 `key`（不区分大小写）与 `none` / `clear`。
 */
export function resolveTargetState(
  rawInput: string,
  settings: SettingsSnapshot,
): { readonly kind: "clear" } | { readonly kind: "set"; readonly target: MatchedState } {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    throw new Error(`state must be a non-empty string (use a state key: ${formatValidStates(settings)}, or "none")`);
  }
  if (isClearKeyword(trimmed)) {
    return { kind: "clear" };
  }
  const lower = trimmed.toLowerCase();
  const matched = settings.states.find((item) => item.key.toLowerCase() === lower);
  if (matched !== undefined) {
    return {
      kind: "set",
      target: { key: matched.key, prefix: matched.prefix, label: matched.label },
    };
  }
  throw new Error(
    `unknown session state "${trimmed}" — valid state keys are: ${formatValidStates(settings)}, or "none" / "clear" to remove the state prefix`,
  );
}

/** 列出合法状态 key（附带前缀与名称，仅作识别辅助）。 */
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

/** 读取一个 live 会话当前的状态与标题信息。 */
export function inspectSessionState(
  ctx: Context,
  sessionId: string,
  settings: SettingsSnapshot,
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
  const parsed = parseTitleState(currentTitle, settings);
  return {
    sessionId,
    state: parsed.state,
    fullTitle: parsed.fullTitle,
    baseTitle: parsed.baseTitle,
  };
}

/** 设置、切换或清除一个 live 会话的状态前缀。 */
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
  const rawCurrentTitle = titles.get(session)?.title ?? fallbackTitleFromEvents(session);
  const parsed = parseTitleState(rawCurrentTitle, settings);
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
    nextTitle = `${target.prefix} ${baseTitle}`;
    nextStateKey = target.key;
    nextPrefix = target.prefix;
    nextLabel = target.label;
  }

  try {
    const accepted = titles.rename(session, nextTitle);
    const acceptedParsed = parseTitleState(accepted.title, settings);
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
  snapshotEvents?: () => readonly unknown[];
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

/** 会话日志里最新一条 `session/title`，或 undefined。 */
export function latestSessionTitleOf(session: AutoTitledSession): SessionTitleEventPayload | undefined {
  if (typeof session.snapshotEvents !== "function") return undefined;
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string; data?: SessionTitleEventPayload } | undefined;
    if (event?.type === "session/title" && event.data !== undefined) return event.data;
  }
  return undefined;
}

/**
 * 自动推断（如 Jev）应用状态到会话标题：
 * - 若会话最新标题来源是自动生成（fallback 或 provider），则保持其 source 原样 append，
 *   绝不触发 `user` rename 的 supersede，保护后台 Title Provider 正常运作；
 * - 若已是用户命名，或尚无标题事件，则通过正常 `sessionTitle.rename` 更新；
 * - 同时维护 tracker.assigned。
 */
export function applyInferredSessionState(
  ctx: Context,
  session: AutoTitledSession,
  rawState: string,
  tracker: StateTracker,
  settings: SettingsSnapshot,
): boolean {
  const resolution = resolveTargetState(rawState, settings);
  const latest = latestSessionTitleOf(session);
  const rawCurrentTitle = latest?.title ?? fallbackTitleFromEvents(session);
  const parsed = parseTitleState(rawCurrentTitle, settings);
  const baseTitle = parsed.baseTitle.length > 0 ? parsed.baseTitle : (rawCurrentTitle.trim() || EMPTY_BASE_TITLE);

  let nextTitle: string;
  let targetState: MatchedState | null = null;

  if (resolution.kind === "clear") {
    nextTitle = baseTitle;
  } else {
    targetState = resolution.target;
    nextTitle = `${targetState.prefix} ${baseTitle}`;
  }

  const prefixed = truncateUtf8(nextTitle, MAX_TITLE_UTF8_BYTES);
  if (prefixed === rawCurrentTitle) {
    return false;
  }

  const recordTrackerSuccess = () => {
    if (targetState !== null) {
      tracker.cleared.delete(session.id);
      tracker.assigned.set(session.id, targetState);
    } else {
      tracker.cleared.add(session.id);
      tracker.assigned.delete(session.id);
    }
  };

  const sourceKind = latest?.source?.kind;
  if (latest !== undefined && (sourceKind === "fallback" || sourceKind === "provider") && typeof session.append === "function") {
    // 保持原 source 追加，绝不打断后台 LLM Title Provider
    session.append("session/title", {
      title: prefixed,
      messageSeqs: Array.isArray(latest.messageSeqs) ? [...latest.messageSeqs] : [],
      source: latest.source,
    });
    recordTrackerSuccess();
    return true;
  }

  // 否则调用常规 sessionTitle.rename
  const sessions = requireSessions(ctx);
  const titles = requireSessionTitles(ctx);
  const liveSession = sessions.get(session.id as SessionId);
  if (liveSession) {
    titles.rename(liveSession, prefixed);
    recordTrackerSuccess();
    return true;
  }
  return false;
}

/**
 * 宿主自动生成标题后的写回钩子。
 *
 * **必须在 `session/event` 回调之外（microtask）调用**：宿主 `Session.append` 在发布事件期间带
 * reentrancy 守卫（`session append cannot reenter while another append is being published`），
 * 同步回调里再 append 会被拒绝。
 *
 * 判断依据以「会话当前最新的一条 `session/title`」为准，而不是传进来的那条事件——延迟到 microtask 后，
 * 期间可能已经有更新的标题（例如更快的 provider 结果）落地，用旧的会把它覆盖回去。
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
  const latest = latestSessionTitleOf(session) ?? data;
  const sourceKind = latest?.source?.kind;
  if (sourceKind !== "fallback" && sourceKind !== "provider") {
    return false;
  }
  if (tracker.cleared.has(session.id)) {
    return false;
  }

  const parsed = parseTitleState(latest.title, settings);
  if (parsed.state !== null) {
    // 标题已经带有已知状态前缀，同步记录即可，不再重复追加
    tracker.assigned.set(session.id, parsed.state);
    return false;
  }

  let target = tracker.assigned.get(session.id);
  if (target === undefined) {
    if (settings.defaultState === "none") return false;
    const preset: StatePreset | undefined = settings.states.find((item) => item.key === settings.defaultState);
    if (preset === undefined) return false;
    target = { key: preset.key, prefix: preset.prefix, label: preset.label };
    tracker.assigned.set(session.id, target);
  }

  const base = parsed.baseTitle.length > 0 ? parsed.baseTitle : latest.title.trim();
  if (base.length === 0) return false;
  const prefixed = truncateUtf8(`${target.prefix} ${base}`, MAX_TITLE_UTF8_BYTES);
  if (prefixed === latest.title) return false;

  session.append("session/title", {
    title: prefixed,
    messageSeqs: Array.isArray(latest.messageSeqs) ? [...latest.messageSeqs] : [],
    source: latest.source,
  });
  return true;
}
