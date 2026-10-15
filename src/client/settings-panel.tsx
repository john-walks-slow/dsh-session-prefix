/**
 * 「会话前缀」插件设置面板：
 * 1. 新会话默认状态下拉选择（默认 `wip`，可选 `none` 或任意已配置状态）；
 * 2. 回合进行中状态下拉选择（`activeState`，默认 `wip`）；
 * 3. 标题跳过规则（`skipPattern`）：命中该正则的标题不再自动加/改状态前缀；
 * 4. Jev 自动状态推断开关（`jevEnabled`，本回合首条人类指令落库后与回合结束自动判定）；
 * 5. 模型工具 `session_prefix` 启用开关（`toolEnabled`）+ 自定义指令；
 * 6. 状态预设表（`states`）可视化增、删、改与一键恢复默认。
 */
import * as React from "react";
import { installStyles } from "./styles.js";

export interface ClientStatePreset {
  key: string;
  prefix: string;
  label: string;
  description: string;
}

export interface SessionStateSettings {
  enabled: boolean;
  toolEnabled: boolean;
  jevEnabled: boolean;
  jevApiKey?: string;
  jevBaseUrl?: string;
  jevModel?: string;
  jevInstructions?: string;
  jevNoneCriteria?: string;
  defaultState: string;
  activeState: string;
  skipPattern: string;
  instructions: string;
  states: ClientStatePreset[];
}

export interface SettingsScopeSnapshot<T> {
  status: "loading" | "ready" | "unavailable";
  value?: T;
  base?: T;
  user?: Partial<T>;
  revision?: number;
  writable: boolean;
  mode: "host" | "memory";
}

export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>;
  subscribe(listener: () => void): () => void;
  set<K extends keyof T>(field: K, value: T[K]): Promise<boolean>;
  unset<K extends keyof T>(field: K): Promise<boolean>;
}

export type SessionStateScope = SettingsScope<SessionStateSettings>;

/** 与 `config.ts` 的 `DEFAULT_SKIP_PATTERN` 对齐：设置项未被显式覆盖时，输入框展示这条内置默认规则。 */
const DEFAULT_SKIP_PATTERN = "^\\S+ · ";

const FALLBACK_STATES: ClientStatePreset[] = [
  { key: "wip", prefix: "🚧", label: "进行中", description: "正在编码、实施或执行任务" },
  { key: "blocked", prefix: "⏸️", label: "等待/阻塞", description: "等待用户确认、审批、外部输入或遇到阻塞" },
  { key: "review", prefix: "👀", label: "待验收", description: "实施或计划已完成，等待用户检视或验收" },
  { key: "done", prefix: "✅", label: "已完成", description: "当前会话任务已全部交付完成" },
  { key: "plan", prefix: "💡", label: "规划/调研", description: "正在进行需求调研、方案设计或讨论" },
  { key: "bug", prefix: "🐛", label: "排障/修复", description: "正在定位问题、排查故障或修复缺陷" },
];

/** 校验跳过规则：合法或留空返回 `null`，否则返回给用户看的错误文案。 */
function skipPatternIssue(pattern: string): string | null {
  if (pattern.trim().length === 0) return null;
  try {
    new RegExp(pattern);
    return null;
  } catch (error) {
    return `正则无效：${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface SessionStatePanelProps {
  close?: () => void;
  scope: SessionStateScope;
}

export function SessionStatePanel(props: SessionStatePanelProps): React.ReactElement {
  installStyles();
  const { scope } = props;
  const [snapshot, setSnapshot] = React.useState<SettingsScopeSnapshot<SessionStateSettings>>(scope.getSnapshot());
  const [instructionDraft, setInstructionDraft] = React.useState<string | null>(null);
  const [skipPatternDraft, setSkipPatternDraft] = React.useState<string | null>(null);
  const [statesDraft, setStatesDraft] = React.useState<ClientStatePreset[] | null>(null);
  const [jevApiKeyDraft, setJevApiKeyDraft] = React.useState<string | null>(null);
  const [jevBaseUrlDraft, setJevBaseUrlDraft] = React.useState<string | null>(null);
  const [jevModelDraft, setJevModelDraft] = React.useState<string | null>(null);
  const [jevInstructionsDraft, setJevInstructionsDraft] = React.useState<string | null>(null);
  const [jevNoneCriteriaDraft, setJevNoneCriteriaDraft] = React.useState<string | null>(null);
  const [testingJev, setTestingJev] = React.useState(false);
  const [jevTestFeedback, setJevTestFeedback] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);

  React.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);

  if (snapshot.status === "loading") {
    return React.createElement("div", { className: "dss-note" }, "正在加载会话前缀设置…");
  }
  if (snapshot.status === "unavailable") {
    return React.createElement(
      "div",
      { className: "dss-note" },
      snapshot.mode === "memory"
        ? "设置暂不可用：当前页面不是通过本机地址访问，平台把设置降级为进程本地（memory）模式，这里只读。请用 127.0.0.1 打开后再编辑。"
        : "设置不可用：这个 profile 没有组合 settings 服务，或 session-prefix 这个 entry 没有配置节。当前显示的是插件默认值。",
    );
  }

  const value = snapshot.value ?? ({} as Partial<SessionStateSettings>);
  const writable = snapshot.writable;
  const overridden = (field: keyof SessionStateSettings): boolean =>
    snapshot.user !== undefined && field in snapshot.user;

  const savedStates = Array.isArray(value.states) && value.states.length > 0 ? value.states : FALLBACK_STATES;
  const currentStates = statesDraft ?? savedStates;
  const statesDirty = statesDraft !== null && JSON.stringify(statesDraft) !== JSON.stringify(savedStates);

  const savedInstructions = String(value.instructions ?? "");
  const currentInstructions = instructionDraft ?? savedInstructions;
  const instructionsDirty = currentInstructions !== savedInstructions;

  // 未被显式覆盖时快照可能不含默认值，此处按内置默认规则展示，避免让「规则生效中」看起来像关闭
  const savedSkipPattern = overridden("skipPattern")
    ? String(value.skipPattern ?? "")
    : DEFAULT_SKIP_PATTERN;
  const currentSkipPattern = skipPatternDraft ?? savedSkipPattern;
  const skipPatternDirty = currentSkipPattern !== savedSkipPattern;
  const skipPatternInvalid = skipPatternIssue(currentSkipPattern);

  const saveSkipPattern = async (): Promise<void> => {
    if (skipPatternInvalid !== null) {
      setFeedback({ kind: "err", text: skipPatternInvalid });
      return;
    }
    await saveField(
      "skipPattern",
      currentSkipPattern.trim(),
      "已保存：命中该规则的标题不再自动加状态前缀。",
    );
    setSkipPatternDraft(null);
  };

  const isToolEnabled =
    value.toolEnabled !== undefined ? value.toolEnabled !== false : value.enabled !== false;
  const isJevEnabled = value.jevEnabled !== undefined ? value.jevEnabled !== false : true;

  const savedJevApiKey = String(value.jevApiKey ?? "");
  const currentJevApiKey = jevApiKeyDraft ?? savedJevApiKey;
  const savedJevBaseUrl = String(value.jevBaseUrl ?? "");
  const currentJevBaseUrl = jevBaseUrlDraft ?? savedJevBaseUrl;
  const savedJevModel = String(value.jevModel ?? "");
  const currentJevModel = jevModelDraft ?? savedJevModel;
  const savedJevInstructions = String(value.jevInstructions ?? "");
  const currentJevInstructions = jevInstructionsDraft ?? savedJevInstructions;
  const savedJevNoneCriteria = String(value.jevNoneCriteria ?? "");
  const currentJevNoneCriteria = jevNoneCriteriaDraft ?? savedJevNoneCriteria;

  const jevConfigDirty =
    (jevApiKeyDraft !== null && jevApiKeyDraft !== savedJevApiKey) ||
    (jevBaseUrlDraft !== null && jevBaseUrlDraft !== savedJevBaseUrl) ||
    (jevModelDraft !== null && jevModelDraft !== savedJevModel) ||
    (jevInstructionsDraft !== null && jevInstructionsDraft !== savedJevInstructions) ||
    (jevNoneCriteriaDraft !== null && jevNoneCriteriaDraft !== savedJevNoneCriteria);

  const saveJevConfig = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      if (jevApiKeyDraft !== null) await scope.set("jevApiKey", jevApiKeyDraft.trim());
      if (jevBaseUrlDraft !== null) await scope.set("jevBaseUrl", jevBaseUrlDraft.trim());
      if (jevModelDraft !== null) await scope.set("jevModel", jevModelDraft.trim());
      if (jevInstructionsDraft !== null) await scope.set("jevInstructions", jevInstructionsDraft.trim());
      if (jevNoneCriteriaDraft !== null) await scope.set("jevNoneCriteria", jevNoneCriteriaDraft.trim());
      setJevApiKeyDraft(null);
      setJevBaseUrlDraft(null);
      setJevModelDraft(null);
      setJevInstructionsDraft(null);
      setJevNoneCriteriaDraft(null);
      setFeedback({ kind: "ok", text: "已保存 Jev 配置。" });
    } catch (error) {
      setFeedback({ kind: "err", text: `保存失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const testJevConnection = async () => {
    setTestingJev(true);
    setJevTestFeedback(null);
    try {
      const response = await fetch("api/session-prefix/jev-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: currentJevBaseUrl.trim() || undefined,
          model: currentJevModel.trim() || undefined,
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
      } | null;
      if (result?.ok) {
        setJevTestFeedback({ kind: "ok", text: `正常 · ${result.message ?? ""}`.trim() });
      } else {
        setJevTestFeedback({ kind: "err", text: result?.message ?? `HTTP ${response.status}` });
      }
    } catch (error) {
      setJevTestFeedback({
        kind: "err",
        text: `测速失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setTestingJev(false);
    }
  };

  const saveToolEnabled = async (checked: boolean) => {
    setBusy(true);
    setFeedback(null);
    try {
      await scope.set("toolEnabled", checked);
      await scope.set("enabled", checked);
      setFeedback({ kind: "ok", text: "已保存：对模型工具 session_prefix 在下一个回合生效。" });
    } catch (error) {
      setFeedback({ kind: "err", text: `保存失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const currentDefaultState = typeof value.defaultState === "string" && value.defaultState.length > 0
    ? value.defaultState
    : "wip";
  const currentActiveState = typeof value.activeState === "string" && value.activeState.length > 0
    ? value.activeState
    : "wip";

  const saveField = async <K extends keyof SessionStateSettings>(
    field: K,
    next: SessionStateSettings[K],
    okMessage = "已保存：对 /state 立即生效，对模型工具在下一个回合生效。",
  ): Promise<void> => {
    setBusy(true);
    setFeedback(null);
    try {
      const ok = await scope.set(field, next);
      setFeedback(
        ok
          ? { kind: "ok", text: okMessage }
          : { kind: "err", text: "保存被拒绝（可能被上层配置覆盖，或版本冲突）。" },
      );
    } catch (error) {
      setFeedback({ kind: "err", text: `保存失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const resetField = async (field: keyof SessionStateSettings): Promise<void> => {
    setBusy(true);
    setFeedback(null);
    try {
      await scope.unset(field);
      if (field === "instructions") setInstructionDraft(null);
      if (field === "skipPattern") setSkipPatternDraft(null);
      if (field === "states") setStatesDraft(null);
      setFeedback({ kind: "ok", text: "已恢复默认值。" });
    } catch (error) {
      setFeedback({ kind: "err", text: `恢复默认失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const updateStateRow = (index: number, patch: Partial<ClientStatePreset>): void => {
    const base = statesDraft ?? savedStates.map((item) => ({ ...item }));
    const next = base.map((item, idx) => (idx === index ? { ...item, ...patch } : item));
    setStatesDraft(next);
  };

  const removeStateRow = (index: number): void => {
    const base = statesDraft ?? savedStates.map((item) => ({ ...item }));
    if (base.length <= 1) {
      setFeedback({ kind: "err", text: "至少需要保留一个状态预设。" });
      return;
    }
    setStatesDraft(base.filter((_, idx) => idx !== index));
  };

  const addStateRow = (): void => {
    const base = statesDraft ?? savedStates.map((item) => ({ ...item }));
    setStatesDraft([
      ...base,
      { key: `state-${base.length + 1}`, prefix: "📌", label: "新状态", description: "" },
    ]);
  };

  const saveStates = async (): Promise<void> => {
    const cleaned = currentStates
      .map((item) => ({
        key: item.key.trim().toLowerCase(),
        prefix: item.prefix.trim(),
        label: item.label.trim() || item.key.trim(),
        description: item.description.trim(),
      }))
      .filter((item) => item.key.length > 0 && item.prefix.length > 0);
    if (cleaned.length === 0) {
      setFeedback({ kind: "err", text: "每个状态都需要填写非空的键值（key）和前缀（prefix）。" });
      return;
    }
    await saveField("states", cleaned);
    setStatesDraft(null);
  };

  return React.createElement(
    "div",
    { className: "dss-root" },
    React.createElement(
      "p",
      { className: "dss-note" },
      "用会话标题前缀标记项目状态（纯视觉区分，无其他行为副作用）。用户与 Agent 都只按状态 key 选择（如 /state wip）。在侧边栏搜索框输入任意状态 Emoji（如 🚧、✅）即可即时筛选对应状态的会话。",
    ),
    // 卡片 1：新会话默认状态 & 自由前缀
    React.createElement(
      "section",
      { className: "dss-card" },
      React.createElement(
        "div",
        { className: "dss-row" },
        React.createElement("span", { className: "dss-title" }, "新会话默认状态"),
        React.createElement(
          "div",
          { className: "dss-row" },
          React.createElement(
            "select",
            {
              className: "dss-select",
              value: currentDefaultState,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                void saveField("defaultState", event.target.value),
            },
            React.createElement("option", { value: "none" }, "none（不自动添加状态前缀）"),
            ...savedStates.map((item) =>
              React.createElement(
                "option",
                { key: item.key, value: item.key },
                `${item.prefix} ${item.label} (${item.key})`,
              ),
            ),
          ),
          overridden("defaultState")
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className: "dss-reset",
                  disabled: !writable || busy,
                  onClick: () => void resetField("defaultState"),
                },
                "恢复默认",
              )
            : null,
        ),
      ),
      React.createElement(
        "p",
        { className: "dss-hint" },
        "新会话首次自动生成标题时自动冠上该状态前缀（默认 wip 🚧），且不会打断后台 LLM 自动生成标题。",
      ),
      React.createElement(
        "div",
        { className: "dss-row" },
        React.createElement("span", { className: "dss-title" }, "回合进行中状态"),
        React.createElement(
          "div",
          { className: "dss-row" },
          React.createElement(
            "select",
            {
              className: "dss-select",
              value: currentActiveState,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                void saveField("activeState", event.target.value),
            },
            React.createElement("option", { value: "none" }, "none（不自动回落）"),
            ...savedStates.map((item) =>
              React.createElement(
                "option",
                { key: item.key, value: item.key },
                `${item.prefix} ${item.label} (${item.key})`,
              ),
            ),
          ),
          overridden("activeState")
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className: "dss-reset",
                  disabled: !writable || busy,
                  onClick: () => void resetField("activeState"),
                },
                "恢复默认",
              )
            : null,
        ),
      ),
      React.createElement(
        "p",
        { className: "dss-hint" },
        "宿主又开始驱动某个会话（你追问、或后台任务唤醒它继续跑）时，先把标题前缀回落到该状态（默认 wip 🚧），表示它已不在等你。",
      ),
      React.createElement(
        "div",
        { className: "dss-row" },
        React.createElement("span", { className: "dss-title" }, "标题跳过规则"),
        overridden("skipPattern")
          ? React.createElement(
              "button",
              {
                type: "button",
                className: "dss-reset",
                disabled: !writable || busy,
                onClick: () => void resetField("skipPattern"),
              },
              "恢复默认",
            )
          : null,
      ),
      React.createElement("input", {
        className: "dss-input",
        type: "text",
        placeholder: "正则，例如 ^\\S+ · （留空即关闭该规则）",
        value: currentSkipPattern,
        disabled: !writable || busy,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSkipPatternDraft(event.target.value),
      }),
      React.createElement(
        "p",
        { className: "dss-hint" },
        "标题剥离本插件的状态前缀后命中该正则时，本插件不再自动加/改状态前缀——给自带行首标签的标题让路，例如 IM 桥接写入的 Telegram · xxx（把标签顶开会诱发对方重复补标签）。留空即关闭。",
      ),
      skipPatternInvalid === null
        ? null
        : React.createElement("p", { className: "dss-error" }, skipPatternInvalid),
      React.createElement(
        "div",
        { className: "dss-row dss-actions" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dss-save",
            disabled: !writable || busy || !skipPatternDirty || skipPatternInvalid !== null,
            onClick: () => void saveSkipPattern(),
          },
          "保存规则",
        ),
      ),
    ),
    // 卡片 2：Jev 自动状态推断开关
    React.createElement(
      "section",
      { className: "dss-card" },
      React.createElement(
        "div",
        { className: "dss-row" },
        React.createElement(
          "label",
          { className: "dss-switch" },
          React.createElement("input", {
            type: "checkbox",
            checked: isJevEnabled,
            disabled: !writable || busy,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              void saveField(
                "jevEnabled",
                event.target.checked,
                "已保存：Jev 自动状态推断设置已更新。",
              ),
          }),
          React.createElement("span", { className: "dss-title" }, "启用 Jev 自动状态推断"),
        ),
        overridden("jevEnabled")
          ? React.createElement(
              "button",
              {
                type: "button",
                className: "dss-reset",
                disabled: !writable || busy,
                onClick: () => void resetField("jevEnabled"),
              },
              "恢复默认",
            )
          : null,
      ),
      React.createElement(
        "p",
        { className: "dss-hint" },
        "在本回合首条人类指令落库后（捕捉新意图）与回合结束（评估助手交付成果）两个节点，自动调用 TypeSafe Jev 快决策模型推断项目状态并平滑更新会话标题前缀。支持配置自定义端点与凭据，或通过 JEV_API_KEY 环境变量自动获取。",
      ),
      isJevEnabled
        ? React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 4 } },
            React.createElement("input", {
              type: "password",
              className: "dss-input",
              placeholder: "Jev API Key（留空则读取环境变量 JEV_API_KEY）",
              value: currentJevApiKey,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setJevApiKeyDraft(event.target.value),
            }),
            React.createElement("input", {
              type: "text",
              className: "dss-input",
              placeholder: "Jev Base URL（留空则使用 JEV_BASE_URL 或默认端点）",
              value: currentJevBaseUrl,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setJevBaseUrlDraft(event.target.value),
            }),
            React.createElement("input", {
              type: "text",
              className: "dss-input",
              placeholder: "Jev 模型名称（留空则使用 JEV_MODEL 或 typesafe/jev-1.13）",
              value: currentJevModel,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setJevModelDraft(event.target.value),
            }),
            React.createElement(
              "div",
              { className: "dss-row dss-actions" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dss-btn",
                  disabled: !writable || busy || testingJev,
                  onClick: () => void testJevConnection(),
                },
                testingJev ? "测速中…" : "测速",
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dss-save",
                  disabled: !writable || busy || !jevConfigDirty,
                  onClick: () => void saveJevConfig(),
                },
                "保存 Jev 配置",
              ),
              jevTestFeedback !== null
                ? React.createElement(
                    "span",
                    { className: jevTestFeedback.kind === "ok" ? "dss-ok" : "dss-error" },
                    jevTestFeedback.text,
                  )
                : null,
            ),
          )
        : null,
    ),
    // 卡片 3：模型工具开关与自定义指令
    React.createElement(
      "section",
      { className: "dss-card" },
      React.createElement(
        "div",
        { className: "dss-row" },
        React.createElement(
          "label",
          { className: "dss-switch" },
          React.createElement("input", {
            type: "checkbox",
            checked: isToolEnabled,
            disabled: !writable || busy,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              void saveToolEnabled(event.target.checked),
          }),
          React.createElement("span", { className: "dss-title" }, "启用模型工具 session_prefix"),
        ),
        overridden("toolEnabled") || overridden("enabled")
          ? React.createElement(
              "button",
              {
                type: "button",
                className: "dss-reset",
                disabled: !writable || busy,
                onClick: () => {
                  void (async () => {
                    await resetField("toolEnabled");
                    await resetField("enabled");
                  })();
                },
              },
              "恢复默认",
            )
          : null,
      ),
      React.createElement(
        "p",
        { className: "dss-hint" },
        "向 Agent 暴露 session_prefix 工具，供模型在任务推进过程中自主维护状态标记。若下方未填写自定义指令，模型也会根据各状态的说明自主切换；若填写指令，则仅用于补充额外偏好（例如「交付后必须等我说完成才设 done」）。",
      ),
      React.createElement("textarea", {
        className: "dss-textarea",
        rows: 3,
        placeholder:
          "可选。默认已能自主切换，这里只写额外偏好。例如：部署类任务一律先标 plan；没有我的确认不要设 done。",
        value: currentInstructions,
        disabled: !writable || busy,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setInstructionDraft(event.target.value),
      }),
      React.createElement(
        "div",
        { className: "dss-row dss-actions" },
        React.createElement("span", { className: "dss-count" }, `${[...currentInstructions].length}/2000`),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dss-save",
            disabled: !writable || busy || !instructionsDirty,
            onClick: () =>
              void saveField("instructions", currentInstructions).then(() => setInstructionDraft(null)),
          },
          "保存指令",
        ),
        overridden("instructions")
          ? React.createElement(
              "button",
              {
                type: "button",
                className: "dss-reset",
                disabled: !writable || busy,
                onClick: () => void resetField("instructions"),
              },
              "清除",
            )
          : null,
      ),
    ),
    // 卡片 4：自定义状态预设表
    React.createElement(
      "section",
      { className: "dss-card" },
      React.createElement(
        "div",
        { className: "dss-row" },
        React.createElement("span", { className: "dss-title" }, "状态预设列表（前缀 / Key / 名称 / 说明）"),
        overridden("states")
          ? React.createElement(
              "button",
              {
                type: "button",
                className: "dss-reset",
                disabled: !writable || busy,
                onClick: () => void resetField("states"),
              },
              "恢复默认状态集",
            )
          : null,
      ),
      React.createElement(
        "div",
        { className: "dss-state-list" },
        ...currentStates.map((item, idx) =>
          React.createElement(
            "div",
            { key: idx, className: "dss-state-row" },
            React.createElement("input", {
              className: "dss-input",
              type: "text",
              placeholder: "前缀 (🚧)",
              value: item.prefix,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                updateStateRow(idx, { prefix: event.target.value }),
            }),
            React.createElement("input", {
              className: "dss-input",
              type: "text",
              placeholder: "key (wip)",
              value: item.key,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                updateStateRow(idx, { key: event.target.value }),
            }),
            React.createElement("input", {
              className: "dss-input",
              type: "text",
              placeholder: "名称 (进行中)",
              value: item.label,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                updateStateRow(idx, { label: event.target.value }),
            }),
            React.createElement("input", {
              className: "dss-input",
              type: "text",
              placeholder: "适用场景说明（可选）",
              value: item.description,
              disabled: !writable || busy,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                updateStateRow(idx, { description: event.target.value }),
            }),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dss-btn",
                disabled: !writable || busy || currentStates.length <= 1,
                onClick: () => removeStateRow(idx),
              },
              "删除",
            ),
          ),
        ),
      ),
      React.createElement(
        "div",
        { className: "dss-row dss-actions" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dss-btn",
            disabled: !writable || busy,
            onClick: addStateRow,
          },
          "+ 添加状态",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dss-save",
            disabled: !writable || busy || !statesDirty,
            onClick: () => void saveStates(),
          },
          "保存状态列表",
        ),
      ),
    ),
    feedback === null
      ? null
      : React.createElement(
          "p",
          { className: feedback.kind === "ok" ? "dss-ok" : "dss-error" },
          feedback.text,
        ),
  );
}
