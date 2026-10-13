/**
 * 插件设置：工具开关、新会话默认状态、自定义指令、以及状态预设表。
 *
 * 所有顶层字段均标记 `.volatile()`，以便 Web 设置页（`dsh-settings`）投影并即时写回运行中的配置引用。
 * 工具表描述在每个 `turn/start` 前按最新设置快照对齐（见 `assembly.ts`）。
 *
 * 输入面刻意只有状态 `key` 一种形态：用户命令与模型工具都只接受 key（外加 `none` / `clear`），
 * 名称与前缀只用于展示，避免同一件事有多种写法。
 */
import z from "@deepseek-ai/schemastery";

/** 一段自定义指令的长度上限（码点）。 */
export const INSTRUCTION_LIMIT = 2000;

/** 状态前缀 / key / 名称 / 说明的长度上限（码点）。 */
export const PREFIX_LIMIT = 16;
export const KEY_LIMIT = 32;
export const LABEL_LIMIT = 40;
export const DESCRIPTION_LIMIT = 160;

/** 一条状态预设。 */
export interface StatePreset {
  /** 稳定标识（小写字母/数字/连字符/下划线），用户与模型都用它选状态，如 `"wip"`、`"done"`。 */
  readonly key: string;
  /** 标题前缀（emoji 或短文本），如 `"🚧"`、`"[WIP]"`。 */
  readonly prefix: string;
  /** 人类可读名称，如 `"进行中"`。 */
  readonly label: string;
  /** 简短说明，展示在命令列表与模型工具描述中。 */
  readonly description: string;
}

/** 开箱即用的默认状态预设。 */
export const DEFAULT_STATES: readonly StatePreset[] = [
  {
    key: "wip",
    prefix: "🚧",
    label: "进行中",
    description: "正在编码、实施或执行任务",
  },
  {
    key: "blocked",
    prefix: "⏸️",
    label: "等待/阻塞",
    description: "等待用户确认、审批、外部输入或遇到阻塞",
  },
  {
    key: "review",
    prefix: "👀",
    label: "待验收",
    description: "实施或计划已完成，等待用户检视或验收",
  },
  {
    key: "done",
    prefix: "✅",
    label: "已完成",
    description: "当前会话任务已全部交付完成",
  },
  {
    key: "plan",
    prefix: "💡",
    label: "规划/调研",
    description: "正在进行需求调研、方案设计或讨论",
  },
  {
    key: "bug",
    prefix: "🐛",
    label: "排障/修复",
    description: "正在定位问题、排查故障或修复缺陷",
  },
] as const;

/** 表示“不自动设置默认状态 / 清除状态”的保留关键字。 */
export const CLEAR_KEYWORDS = ["none", "clear", "off", "无", "清除"] as const;

const StatePresetSchema = z.object({
  key: z.string().required(),
  prefix: z.string().required(),
  label: z.string().default(""),
  description: z.string().default(""),
});

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  defaultState: z.string().default("wip").volatile(),
  instructions: z.string().default("").volatile(),
  states: z
    .array(StatePresetSchema)
    .default(DEFAULT_STATES.map((item) => ({ ...item })))
    .volatile(),
});

/** 运行时归一化后的设置快照。 */
export interface SettingsSnapshot {
  readonly enabled: boolean;
  /** 新会话默认状态 key；`"none"` 表示不自动添加状态前缀。 */
  readonly defaultState: string;
  readonly instructions: string;
  readonly states: readonly StatePreset[];
}

/** 配置引用（`Volatile<T>`）的最小切片。 */
interface VolatileLike<T> {
  get(): T;
}

export interface SettingsConfig {
  readonly enabled?: VolatileLike<boolean>;
  readonly defaultState?: VolatileLike<string>;
  readonly instructions?: VolatileLike<string>;
  readonly states?: VolatileLike<readonly StatePreset[]>;
}

/** 从运行中的配置引用读一份归一化快照。 */
export function readSettings(config: SettingsConfig | undefined): SettingsSnapshot {
  const states = sanitizeStates(config?.states?.get());
  return {
    enabled: config?.enabled?.get() !== false,
    defaultState: sanitizeDefaultState(config?.defaultState?.get(), states),
    instructions: sanitizeInstruction(config?.instructions?.get()),
    states,
  };
}

/**
 * 校验并归一化状态预设列表；若用户清空或输入全部非法，回退到 `DEFAULT_STATES`。
 */
export function sanitizeStates(raw: unknown): readonly StatePreset[] {
  if (!Array.isArray(raw)) return DEFAULT_STATES;
  const result: StatePreset[] = [];
  const seenKeys = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const key = sanitizeKey(candidate.key);
    const prefix = sanitizePrefix(candidate.prefix);
    if (key.length === 0 || prefix.length === 0) continue;
    if (isClearKeyword(key) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const label = sanitizeSingleLine(candidate.label, LABEL_LIMIT) || key;
    const description = sanitizeSingleLine(candidate.description, DESCRIPTION_LIMIT);
    result.push({ key, prefix, label, description });
  }
  return result.length > 0 ? result : DEFAULT_STATES;
}

/**
 * 归一化新会话默认状态：只认状态 key（不区分大小写）或 `"none"`；
 * 无法识别时回落到 `"wip"`（若存在），否则 `"none"`。
 */
export function sanitizeDefaultState(raw: unknown, states: readonly StatePreset[]): string {
  const fallback = states.some((item) => item.key === "wip") ? "wip" : "none";
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isClearKeyword(trimmed)) return "none";
  const lower = trimmed.toLowerCase();
  const matched = states.find((item) => item.key.toLowerCase() === lower);
  return matched ? matched.key : fallback;
}

/** 判断输入是否为清除/无状态关键字。 */
export function isClearKeyword(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return (CLEAR_KEYWORDS as readonly string[]).includes(normalized);
}

/** 状态 key 整形：去空白、转小写、截断。 */
export function sanitizeKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\s]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return [...cleaned].slice(0, KEY_LIMIT).join("");
}

/** 状态前缀整形：去控制符与首尾空白，合并内部空白，截断。 */
export function sanitizePrefix(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return [...cleaned].slice(0, PREFIX_LIMIT).join("");
}

/** 单行短文本整形。 */
export function sanitizeSingleLine(raw: unknown, limit: number): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...cleaned].slice(0, limit).join("");
}

/** 指令文本整形：折叠控制符/空行、去首尾空白、按码点截断。 */
export function sanitizeInstruction(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const flat = raw
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const points = [...flat];
  return points.length <= INSTRUCTION_LIMIT ? flat : `${points.slice(0, INSTRUCTION_LIMIT).join("")}…`;
}
