/**
 * Jev 自动状态推断客户端与调度器：
 * - 在本回合首条人类消息（`user/message`，`source.kind === "user"`）与 `turn/end` 事件节点调用 TypeSafe Jev 决策模型；
 * - 从插件设置（jevApiKey/jevBaseUrl/jevModel）或环境变量（JEV_API_KEY/JEV_BASE_URL/JEV_MODEL）解析凭据；
 * - 将配置的状态表动态映射为 Jev 的 Choice Criteria，获取置信度与分类选择；
 * - 当置信度达标且状态改变时，异步回写会话标题前缀（保留 provider/fallback source，不打断后台 LLM 起名）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { DEFAULT_STATES, type SettingsSnapshot, type StatePreset } from "./config.js";
import {
  applyInferredSessionState,
  latestSessionTitleOf,
  parseTitleState,
  type AutoTitledSession,
  type StateTracker,
} from "./state.js";

/** Jev 决策判定的默认置信度阈值。 */
export const JEV_CONFIDENCE_THRESHOLD = 0.7;

/** 默认的 Jev Decisions API 终端节点。 */
export const DEFAULT_JEV_BASE_URL = "https://openrouter.ai/api/alpha/decisions";

/** 默认使用的 Jev 模型。 */
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

/** 默认的 Jev 判定问题文案。 */
export const DEFAULT_JEV_INSTRUCTIONS =
  "What is the current project/task state or phase for this conversation based on the context?";

/** 默认的 none（无适用状态）选项说明。 */
export const DEFAULT_JEV_NONE_CRITERIA =
  "No specific project state applies, or task is neutral/cleared";

/** Jev 请求超时时间（毫秒）。 */
const JEV_REQUEST_TIMEOUT_MS = 6000;

export interface JevCredentials {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface JevDecisionOutcome {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

/** 解析 Jev API 凭据（优先级：插件设置 → 环境变量 JEV_API_KEY/JEV_BASE_URL/JEV_MODEL）。 */
export function resolveJevCredentials(settings?: SettingsSnapshot): JevCredentials | null {
  const explicitKey = settings?.jevApiKey?.trim();
  const envKey = process.env.JEV_API_KEY?.trim();
  const apiKey =
    explicitKey && explicitKey.length > 0
      ? explicitKey
      : envKey && envKey.length > 0
        ? envKey
        : null;

  if (!apiKey) return null;

  const explicitUrl = settings?.jevBaseUrl?.trim();
  const envUrl = process.env.JEV_BASE_URL?.trim();
  const baseUrl =
    explicitUrl && explicitUrl.length > 0
      ? explicitUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : DEFAULT_JEV_BASE_URL;

  const explicitModel = settings?.jevModel?.trim();
  const envModel = process.env.JEV_MODEL?.trim();
  const model =
    explicitModel && explicitModel.length > 0
      ? explicitModel
      : envModel && envModel.length > 0
        ? envModel
        : DEFAULT_JEV_MODEL;

  return { apiKey, baseUrl, model };
}

export interface JevProbeResult {
  readonly ok: boolean;
  readonly status: number;
  readonly latencyMs: number;
  readonly message: string;
}

/**
 * 用一次最小决策请求探测 Jev 端点，返回耗时与结果。
 *
 * 凭据与端点解析走 {@link resolveJevCredentials}，与回合自动推断完全同源，
 * 因此无论 Key 来自插件设置还是环境变量，测速结果都一致。
 */
export async function probeJevEndpoint(
  overrides: { baseUrl?: string; model?: string } = {},
  settings?: SettingsSnapshot
): Promise<JevProbeResult> {
  const credentials = resolveJevCredentials({
    ...settings,
    ...(overrides.baseUrl?.trim() ? { jevBaseUrl: overrides.baseUrl.trim() } : {}),
    ...(overrides.model?.trim() ? { jevModel: overrides.model.trim() } : {})
  } as SettingsSnapshot);
  if (!credentials) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      message: "未配置 Jev API Key：请在设置页填写，或设置环境变量 JEV_API_KEY",
    };
  }

  const start = Date.now();
  try {
    const response = await fetch(credentials.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "session-prefix",
      },
      body: JSON.stringify({
        model: credentials.model,
        state: "probe",
        questions: {
          ping: { type: "choice", instructions: "ping", criteria: { ok: "ok" } },
        },
      }),
      signal: AbortSignal.timeout(JEV_REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    const text = await response.text().catch(() => "");

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        message: `HTTP ${response.status}：${text.slice(0, 200) || response.statusText}`,
      };
    }

    let choice: unknown;
    try {
      choice = (JSON.parse(text) as { answers?: { ping?: { choice?: unknown } } }).answers?.ping?.choice;
    } catch {
      choice = undefined;
    }
    return {
      ok: true,
      status: response.status,
      latencyMs,
      message:
        typeof choice === "string"
          ? `${credentials.model} · ${latencyMs}ms`
          : `已连通 · ${latencyMs}ms（响应结构异常）`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 从 ContentBlock 数组或字符串中提取纯文本。 */
function extractTextFromBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && (block.type === "text" || typeof block.text === "string"))
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

/** 上下文总长度截断上限（字符数）。 */
export const MAX_TURN_CONTEXT_CHARS = 2000;

/** 人类指令在上下文中的保留上限（保头部）；其余预算留给上轮回复/本轮产出（保尾部）。 */
const MAX_INSTRUCTION_CHARS = 800;

/** 非指令那一侧的保底预算，避免被超长指令挤没。 */
const MIN_COUNTERPART_CHARS = 400;

/** 上下文中标签与分隔符占用的预算。 */
const CONTEXT_LABEL_OVERHEAD = 80;

/** 保留文本头部（截断处省略）。 */
function truncateHead(text: string, maxChars: number): string {
  const points = [...text];
  return points.length <= maxChars ? text : `${points.slice(0, maxChars).join("")}…`;
}

/** 保留文本尾部（截断处省略）。 */
function truncateTail(text: string, maxChars: number): string {
  const points = [...text];
  return points.length <= maxChars ? text : `…${points.slice(-maxChars).join("")}`;
}

/**
 * 从会话快照中提取供 Jev 决策使用的最近上下文。
 *
 * 指令一侧只认人类消息（`source.kind === "user"`）：宿主的注入消息（runtime-context / mnemon /
 * 消息时间 / tool-jobs / 指令快照等）紧跟在人类消息之后落库，若不排除，倒序扫描会先命中它们，
 * 真正的指令反而被挤出预算。
 *
 * 两段各自保号：指令保头部（决定「在做什么」），上轮回复/本轮产出保尾部（结尾通常是结论或提问）。
 */
export function extractTurnContext(session: AutoTitledSession, phase: "start" | "end"): string {
  if (typeof session.snapshotEvents !== "function") return "";
  const events = session.snapshotEvents();
  if (!Array.isArray(events) || events.length === 0) return "";

  let latestUserText = "";
  let latestAssistantText = "";

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as {
      type?: string;
      data?: {
        content?: unknown;
        message?: { content?: unknown };
        source?: { kind?: string };
      };
    } | undefined;
    if (!ev || !ev.type) continue;

    if (!latestAssistantText && ev.type === "assistant/message") {
      const content = ev.data?.message?.content ?? ev.data?.content;
      latestAssistantText = extractTextFromBlocks(content);
    }

    if (!latestUserText && ev.type === "user/message" && ev.data?.source?.kind === "user") {
      const content = ev.data?.content ?? ev.data?.message?.content;
      latestUserText = extractTextFromBlocks(content);
    }

    if (latestUserText && latestAssistantText) {
      break;
    }
  }

  if (!latestUserText && !latestAssistantText) return "";

  const instruction = truncateHead(latestUserText, MAX_INSTRUCTION_CHARS);
  const counterpartBudget = Math.max(
    MIN_COUNTERPART_CHARS,
    MAX_TURN_CONTEXT_CHARS - [...instruction].length - CONTEXT_LABEL_OVERHEAD,
  );
  const counterpart = truncateTail(latestAssistantText, counterpartBudget);

  if (phase === "start") {
    // 回合开始：上轮模型输出（保尾部，结尾通常是它交给用户的提问）+ 本轮人类指令
    return counterpart
      ? `Previous assistant response:\n${counterpart}\n\nCurrent user instruction:\n${instruction}`
      : `Current user instruction:\n${instruction}`;
  }
  // 回合结束：本轮人类指令 + 本轮助手交付成果
  return instruction
    ? `User instruction:\n${instruction}\n\nAssistant outcome:\n${counterpart}`
    : `Assistant outcome:\n${counterpart}`;
}

/** 判定请求中可覆盖的两段文案；省略时用内置默认。 */
export interface JevDecisionTexts {
  /** 判定问题的说明文字。 */
  instructions?: string;
  /** none（无适用状态）选项的判定说明。 */
  noneCriteria?: string;
}

export interface JevDecisionOptions extends JevDecisionTexts {
  signal?: AbortSignal;
}

/** 调用 OpenRouter Decisions API 执行 Jev 状态判定。 */
export async function queryJevState(
  contextText: string,
  states: readonly StatePreset[],
  credentials: JevCredentials,
  options: JevDecisionOptions = {},
): Promise<JevDecisionOutcome | null> {
  const signal = options.signal;
  const criteria: Record<string, string> = {};
  const effectiveStates = states.length > 0 ? states : DEFAULT_STATES;

  for (const s of effectiveStates) {
    criteria[s.key] = s.description || s.label || s.key;
  }
  criteria["none"] = options.noneCriteria?.trim() || DEFAULT_JEV_NONE_CRITERIA;

  const instructions = options.instructions?.trim() || DEFAULT_JEV_INSTRUCTIONS;

  const payload = {
    model: credentials.model,
    state: contextText,
    questions: {
      state: {
        type: "choice",
        instructions,
        criteria,
      },
    },
  };

  const response = await fetch(credentials.baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/john-walks-slow/session-prefix",
      "X-Title": "session-prefix",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Jev API error ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const result = (await response.json()) as {
    answers?: {
      state?: {
        type?: string;
        choice?: string;
        confidence?: number;
        probabilities?: Record<string, number>;
      };
    };
  };

  const answer = result.answers?.state;
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    return null;
  }

  // 必须是 0 到 1 之间的有限数字，拒绝 NaN、Infinity、-Infinity 与负数
  if (
    typeof answer.confidence !== "number" ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  ) {
    return null;
  }

  const choiceKey = answer.choice.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(criteria, choiceKey)) {
    return null;
  }

  const probabilities: Record<string, number> = {};
  if (answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities)) {
    for (const [k, v] of Object.entries(answer.probabilities)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        probabilities[k] = v;
      }
    }
  }

  return {
    choice: choiceKey,
    confidence: answer.confidence,
    probabilities,
  };
}

/** 记录每个会话的推断序号（generation）与请求控制器。 */
interface InFlightRecord {
  generation: number;
  controller: AbortController;
}

export class JevInferenceManager {
  private readonly inFlightMap = new Map<string, InFlightRecord>();
  private readonly sessionGenerations = new Map<string, number>();

  /** 使指定会话当前进行中的推断请求彻底失效并取消。 */
  abortSession(sessionId: string): void {
    const nextGen = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, nextGen);
    const inFlight = this.inFlightMap.get(sessionId);
    if (inFlight) {
      inFlight.controller.abort();
      this.inFlightMap.delete(sessionId);
    }
  }

  /** 取消全部正在运行的推断任务并清空状态。 */
  abortAll(): void {
    for (const record of this.inFlightMap.values()) {
      record.controller.abort();
    }
    this.inFlightMap.clear();
    this.sessionGenerations.clear();
  }

  getGeneration(sessionId: string): number {
    return this.sessionGenerations.get(sessionId) ?? 0;
  }

  nextGeneration(sessionId: string): { generation: number; controller: AbortController } {
    const nextGen = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, nextGen);

    const prev = this.inFlightMap.get(sessionId);
    if (prev) {
      prev.controller.abort();
    }

    const controller = new AbortController();
    this.inFlightMap.set(sessionId, { generation: nextGen, controller });
    return { generation: nextGen, controller };
  }

  cleanupInFlight(sessionId: string, generation: number): void {
    const current = this.inFlightMap.get(sessionId);
    if (current?.generation === generation) {
      this.inFlightMap.delete(sessionId);
    }
  }
}

/** 默认单例管理器。 */
export const defaultJevManager = new JevInferenceManager();

/** 取消全部正在运行的 Jev 推断任务（兼容旧导出）。 */
export function abortAllJevInferences(): void {
  defaultJevManager.abortAll();
}

export type SettingsProvider = SettingsSnapshot | (() => SettingsSnapshot);

function resolveSettings(provider: SettingsProvider): SettingsSnapshot {
  return typeof provider === "function" ? provider() : provider;
}

/**
 * 调度执行单次 Jev 状态自动推断：
 * - 验证会话是否合法（非子代理、Live 会话）；
 * - 若 Jev 禁用、缺少凭据或上下文为空，彻底取消并失效之前的旧请求；
 * - generation 递增守护，淘汰旧请求竞态；
 * - 提取最新上下文（`start` = 上轮产出 + 本回合人类指令，`end` = 本回合指令 + 本轮产出）并调用 Jev 决策；
 * - 提交前核验 generation 并实时重新读取最新配置确认 jevEnabled 依然有效；
 * - 以会话当前标题为唯一事实来源比较状态；
 * - 通过 applyInferredSessionState 更新标题（保持 fallback/provider source 不被打断）。
 */
export async function runJevStateInference(
  ctx: Context,
  session: AutoTitledSession,
  phase: "start" | "end",
  tracker: StateTracker,
  settingsProvider: SettingsProvider,
  manager: JevInferenceManager = defaultJevManager,
): Promise<boolean> {
  // 跳过子代理会话
  if (session.header?.parentSession !== undefined || session.header?.origin === "subagent") {
    return false;
  }

  const initialSettings = resolveSettings(settingsProvider);
  if (!initialSettings.jevEnabled) {
    manager.abortSession(session.id);
    return false;
  }

  const credentials = resolveJevCredentials(initialSettings);
  if (!credentials) {
    manager.abortSession(session.id);
    ctx.logger.debug("session-prefix: Jev credentials not available, skipping inference");
    return false;
  }

  const contextText = extractTurnContext(session, phase);
  if (!contextText || contextText.trim().length === 0) {
    manager.abortSession(session.id);
    return false;
  }

  // generation 递增守护，淘汰旧请求并开启新控制器
  const { generation: gen, controller } = manager.nextGeneration(session.id);
  const timeoutId = setTimeout(() => controller.abort(), JEV_REQUEST_TIMEOUT_MS);

  try {
    const decision = await queryJevState(contextText, initialSettings.states, credentials, {
      instructions: initialSettings.jevInstructions,
      noneCriteria: initialSettings.jevNoneCriteria,
      signal: controller.signal,
    });
    if (!decision) return false;

    // 提交前校验：若该会话已发起更新的推断或已被取消，则当前结果作废
    if (manager.getGeneration(session.id) !== gen) {
      return false;
    }

    // 提交前实时校验：重新读取最新配置，确认等待响应期间未被用户关闭 Jev
    const currentSettings = resolveSettings(settingsProvider);
    if (!currentSettings.jevEnabled) {
      return false;
    }

    if (decision.confidence < JEV_CONFIDENCE_THRESHOLD) {
      ctx.logger.debug(
        `session-prefix: Jev confidence ${decision.confidence} below threshold ${JEV_CONFIDENCE_THRESHOLD} for ${session.id}`,
      );
      return false;
    }

    const targetKey = decision.choice.trim().toLowerCase();

    // 检查当前会话真实标题（唯一事实来源，绝不以 tracker 替代）
    const latest = latestSessionTitleOf(session);
    const currentTitle = latest?.title ?? "";
    const parsed = parseTitleState(currentTitle, currentSettings);
    const currentKey = parsed.state?.key?.toLowerCase() ?? "none";

    if (currentKey === targetKey) {
      // 状态已相同，无需重复重命名
      return false;
    }

    // 执行状态变更（保持自动生成标题 source，不打断后台 LLM 起名）
    const applied = applyInferredSessionState(ctx, session, targetKey, tracker, currentSettings);
    if (applied) {
      ctx.logger.info(
        `session-prefix: [Jev ${phase}] updated session ${session.id} state: "${currentKey}" -> "${targetKey}" (confidence: ${decision.confidence})`,
      );
    }
    return applied;
  } catch (error) {
    if (controller.signal.aborted) {
      return false;
    }
    ctx.logger.warn(`session-prefix: Jev inference failed for ${session.id}: ${String(error)}`);
    return false;
  } finally {
    clearTimeout(timeoutId);
    manager.cleanupInFlight(session.id, gen);
  }
}
