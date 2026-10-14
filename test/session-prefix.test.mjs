import assert from "node:assert/strict";
import test from "node:test";
import { apply, DEFAULT_STATES, extractTurnContext, runJevStateInference } from "../dist/index.js";
import { probeJevEndpoint } from "../dist/jev.js";
import { readSettings } from "../dist/config.js";
import { applySessionState, createStateTracker, parseTitleState } from "../dist/state.js";

/** 构造模拟的 Volatile 引用。 */
function volatileCell(initial) {
  let current = initial;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
}

/** 构造假宿主环境（sessions + sessionTitle + tools + commands + event bus）。 */
function createFakeHost(configOverrides = {}) {
  const sessions = new Map();
  const tools = new Map();
  const commands = new Map();
  const listeners = new Map();

  const emit = (eventName, ...args) => {
    const handlers = listeners.get(eventName) ?? [];
    for (const handler of [...handlers]) {
      handler(...args);
    }
  };

  const addLiveSession = (id, { initialTitle = null, events = [], header = {} } = {}) => {
    const log = [...events];
    let seq = log.length;
    let appending = false;
    if (initialTitle !== null) {
      seq += 1;
      log.push({
        seq,
        type: "session/title",
        data: {
          title: initialTitle,
          messageSeqs: [1],
          source: { kind: "fallback" },
        },
      });
    }
    const session = {
      id,
      header: { id, ...header },
      snapshotEvents: () => [...log],
      append(type, data) {
        // 模拟真实宿主 Session.append 的重入守卫：在事件发布过程中再 append 会被拒绝。
        if (appending) throw new Error("session append cannot reenter while another append is being published");
        appending = true;
        try {
          seq += 1;
          const event = { seq, type, data };
          log.push(event);
          emit("session/event", session, event);
          return event;
        } finally {
          appending = false;
        }
      },
    };
    sessions.set(id, session);
    return session;
  };

  const sessionTitle = {
    get(session) {
      const events = session.snapshotEvents();
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === "session/title") {
          return {
            title: events[i].data.title,
            messageSeqs: events[i].data.messageSeqs ?? [],
            source: events[i].data.source,
            eventSeq: events[i].seq,
            updatedAt: Date.now(),
          };
        }
      }
      return undefined;
    },
    rename(session, rawTitle) {
      if (sessions.get(session.id) !== session) {
        throw new Error(`session "${session.id}" is not live`);
      }
      const normalized = String(rawTitle).replace(/\s+/gu, " ").trim();
      if (normalized.length === 0) {
        const err = new Error("session title must contain visible characters");
        err.name = "SessionTitleInvalidError";
        throw err;
      }
      session.append("session/title", {
        title: normalized,
        messageSeqs: [],
        source: { kind: "user" },
      });
      return this.get(session);
    },
  };

  const routes = new Map();
  const effects = [];
  const ctx = {
    effect(fn) {
      const result = fn();
      const disposeEffect = typeof result === "function" ? result : () => {};
      effects.push(disposeEffect);
      return disposeEffect;
    },
    logger: {
      info() {},
      warn() {},
      debug() {},
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {
          if (tools.get(definition.name) === definition) {
            tools.delete(definition.name);
          }
        };
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
    inject(dependencies, callback) {
      callback(ctx);
    },
    get(serviceName) {
      if (serviceName === "sessions") return sessions;
      if (serviceName === "sessionTitle") return sessionTitle;
      if (serviceName === "commands") {
        return {
          register(def) {
            commands.set(def.name, def);
            return () => commands.delete(def.name);
          },
        };
      }
      return undefined;
    },
    on(eventName, handler) {
      const list = listeners.get(eventName) ?? [];
      list.push(handler);
      listeners.set(eventName, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
  };

  const config = {
    enabled: volatileCell(configOverrides.enabled ?? true),
    defaultState: volatileCell(configOverrides.defaultState ?? "wip"),
    instructions: volatileCell(configOverrides.instructions ?? ""),
    states: volatileCell(configOverrides.states ?? DEFAULT_STATES.map((item) => ({ ...item }))),
  };
  if (configOverrides.toolEnabled !== undefined) {
    config.toolEnabled = volatileCell(configOverrides.toolEnabled);
  }
  if (configOverrides.activeState !== undefined) {
    config.activeState = volatileCell(configOverrides.activeState);
  }
  if (configOverrides.skipPattern !== undefined) {
    config.skipPattern = volatileCell(configOverrides.skipPattern);
  }
  if (configOverrides.jevEnabled !== undefined) {
    config.jevEnabled = volatileCell(configOverrides.jevEnabled);
  }
  if (configOverrides.jevApiKey !== undefined) {
    config.jevApiKey = volatileCell(configOverrides.jevApiKey);
  }

  const dispose = apply(ctx, config);
  const disposeAll = () => {
    for (const disposeEffect of effects) disposeEffect();
    effects.length = 0;
    if (typeof dispose === "function") return dispose();
    return undefined;
  };
  return {
    ctx,
    config,
    sessions,
    sessionTitle,
    tools,
    commands,
    routes,
    emit,
    addLiveSession,
    dispose: disposeAll,
  };
}

test("parseTitleState strips single and stacked prefixes cleanly", () => {
  const settings = readSettings(undefined);

  const p1 = parseTitleState("🚧 修复登录超时", settings);
  assert.equal(p1.state?.key, "wip");
  assert.equal(p1.baseTitle, "修复登录超时");

  // 连续叠罗汉前缀应一次性剥离干净，并以最外层状态作为当前状态
  const p2 = parseTitleState("✅ 🚧 👀 修复登录超时", settings);
  assert.equal(p2.state?.key, "done");
  assert.equal(p2.baseTitle, "修复登录超时");

  const p3 = parseTitleState("普通无状态标题", settings);
  assert.equal(p3.state, null);
  assert.equal(p3.baseTitle, "普通无状态标题");
});

test("session_prefix tool sets, replaces (without stacking), and clears state prefixes by key", async () => {
  const host = createFakeHost();
  const session = host.addLiveSession("s-1", { initialTitle: "重构认证模块" });
  const tool = host.tools.get("session_prefix");
  assert.ok(tool, "session_prefix tool should be registered");
  assert.match(tool.description, /"wip" \(🚧 进行中\)/);
  // 没有自定义指令时，默认描述本身就要把「自主维护」写成明确预期
  assert.match(tool.description, /Maintain it on your own initiative/);
  assert.match(tool.description, /New sessions already start in state "wip"/);

  const exec = { agent: { session } };

  // 1. 设置 wip
  const res1 = await tool.execute({ state: "wip" }, exec);
  assert.equal(res1.state, "wip");
  assert.equal(res1.prefix, "🚧");
  assert.equal(res1.title, "🚧 重构认证模块");
  assert.equal(res1.baseTitle, "重构认证模块");

  // 2. 按 key 切换为 review（验证不叠罗汉）
  const res2 = await tool.execute({ state: "review" }, exec);
  assert.equal(res2.state, "review");
  assert.equal(res2.previousState, "wip");
  assert.equal(res2.title, "👀 重构认证模块");

  // 3. 再切换为 done
  const res3 = await tool.execute({ state: "done" }, exec);
  assert.equal(res3.state, "done");
  assert.equal(res3.previousState, "review");
  assert.equal(res3.title, "✅ 重构认证模块");

  // 4. 不是 key 的输入（名称 / emoji）应被拒绝
  await assert.rejects(() => tool.execute({ state: "待验收" }, exec), /unknown session state "待验收"/);
  await assert.rejects(() => tool.execute({ state: "✅" }, exec), /unknown session state "✅"/);

  // 5. none 清除状态前缀
  const res4 = await tool.execute({ state: "none" }, exec);
  assert.equal(res4.state, undefined);
  assert.equal(res4.previousState, "done");
  assert.equal(res4.title, "重构认证模块");
  assert.equal(host.sessionTitle.get(session)?.title, "重构认证模块");

  host.dispose();
});

test("derives base title from first user message when session/title has not landed yet", () => {
  const host = createFakeHost({ defaultState: "none" });
  const session = host.addLiveSession("s-no-title", {
    initialTitle: null,
    events: [
      {
        seq: 1,
        type: "user/message",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "帮我排查一下数据库连接池泄漏的问题" }],
        },
      },
    ],
  });

  const tracker = createStateTracker();
  const outcome = applySessionState(host.ctx, tracker, "s-no-title", "bug", readSettings(host.config));
  assert.equal(outcome.state, "bug");
  assert.equal(outcome.title, "🐛 帮我排查一下数据库连接池泄漏的问题");

  host.dispose();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("defaultState automatically prefixes new session fallback and provider titles without interrupting provider", async () => {
  const host = createFakeHost({ defaultState: "wip" });
  const session = host.addLiveSession("s-new");

  // 1. 宿主产生首句 fallback 标题
  session.append("session/title", {
    title: "第一句话临时标题",
    messageSeqs: [1],
    source: { kind: "fallback" },
  });
  await tick();
  const afterFallback = host.sessionTitle.get(session);
  assert.equal(afterFallback?.title, "🚧 第一句话临时标题");
  assert.equal(afterFallback?.source.kind, "fallback");

  // 2. 稍后后台 LLM Title Provider 完成，追加不带前缀的精准标题
  session.append("session/title", {
    title: "实现会话状态标记插件",
    messageSeqs: [1],
    source: { kind: "provider", provider: "llm-title" },
  });
  await tick();
  const afterProvider = host.sessionTitle.get(session);
  assert.equal(afterProvider?.title, "🚧 实现会话状态标记插件");
  assert.equal(afterProvider?.source.kind, "provider");

  // 3. 子代理会话不应被自动添加默认状态前缀
  const subSession = host.addLiveSession("s-sub", { header: { parentSession: "s-new", origin: "subagent" } });
  subSession.append("session/title", {
    title: "子代理任务",
    messageSeqs: [1],
    source: { kind: "fallback" },
  });
  await tick();
  assert.equal(host.sessionTitle.get(subSession)?.title, "子代理任务");

  host.dispose();
});

test("defaultState=none skips automatic prefixing on new sessions", async () => {
  const host = createFakeHost({ defaultState: "none" });
  const session = host.addLiveSession("s-plain");

  session.append("session/title", {
    title: "无默认状态的新会话",
    messageSeqs: [1],
    source: { kind: "fallback" },
  });
  await tick();
  assert.equal(host.sessionTitle.get(session)?.title, "无默认状态的新会话");

  host.dispose();
});

test("skipPattern keeps titles that carry their own leading label out of every automatic path", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: { state: { type: "choice", choice: "bug", confidence: 0.95 } } }),
    };
  };
  try {
    const host = createFakeHost({ defaultState: "wip", jevEnabled: true, jevApiKey: "mock-key" });
    const session = host.addLiveSession("s-im", { initialTitle: "Telegram · 隧道不稳定" });

    // 1. 新会话默认状态不挂：fallback 与 provider 两次自动标题都保持原样
    session.append("session/title", {
      title: "Telegram · 隧道不稳定",
      messageSeqs: [1],
      source: { kind: "fallback" },
    });
    await tick();
    assert.equal(host.sessionTitle.get(session).title, "Telegram · 隧道不稳定");

    session.append("session/title", {
      title: "Telegram · 隧道频繁断连",
      messageSeqs: [1],
      source: { kind: "provider" },
    });
    await tick();
    assert.equal(host.sessionTitle.get(session).title, "Telegram · 隧道频繁断连");

    // 2. 回合开始不回落，人类指令落库后也不发起 Jev 决策请求
    host.emit("session/event", session, { type: "turn/start" });
    await flushTurnWork();
    session.append("user/message", {
      content: [{ type: "text", text: "帮我看下隧道为什么断" }],
      source: { kind: "user" },
    });
    await flushTurnWork();
    assert.equal(calls, 0, "skip 规则命中的标题不应发起 Jev 决策请求");
    assert.equal(host.sessionTitle.get(session).title, "Telegram · 隧道频繁断连");

    // 3. 显式工具调用不受规则限制
    const tool = host.tools.get("session_prefix");
    const applied = await tool.execute({ state: "bug" }, { agent: { session } });
    assert.equal(applied.title, "🐛 Telegram · 隧道频繁断连");

    // 4. 显式打标之后，自动回落依然对这类标题停手
    host.emit("session/event", session, { type: "turn/start" });
    await flushTurnWork();
    assert.equal(host.sessionTitle.get(session).title, "🐛 Telegram · 隧道频繁断连");

    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skipPattern is configurable: empty turns the rule off, custom and invalid patterns behave predictably", async () => {
  // 默认规则就是「行首标签 · 内容」
  assert.equal(readSettings(undefined).skipPattern, "^\\S+ · ");

  // 留空 = 关闭规则，自动前缀照旧
  const offHost = createFakeHost({ defaultState: "wip", skipPattern: "" });
  const offSession = offHost.addLiveSession("s-rule-off");
  offSession.append("session/title", {
    title: "Telegram · 隧道不稳定",
    messageSeqs: [1],
    source: { kind: "fallback" },
  });
  await tick();
  assert.equal(offHost.sessionTitle.get(offSession).title, "🚧 Telegram · 隧道不稳定");
  offHost.dispose();

  // 自定义规则：只认方括号标签
  const customHost = createFakeHost({ defaultState: "wip", skipPattern: "^\\[IM\\]" });
  const bracketed = customHost.addLiveSession("s-bracket");
  bracketed.append("session/title", {
    title: "[IM] 隧道不稳定",
    messageSeqs: [1],
    source: { kind: "fallback" },
  });
  await tick();
  assert.equal(customHost.sessionTitle.get(bracketed).title, "[IM] 隧道不稳定");

  const dotted = customHost.addLiveSession("s-dotted");
  dotted.append("session/title", {
    title: "Telegram · 隧道不稳定",
    messageSeqs: [1],
    source: { kind: "fallback" },
  });
  await tick();
  assert.equal(customHost.sessionTitle.get(dotted).title, "🚧 Telegram · 隧道不稳定");
  customHost.dispose();

  // 非法正则视为关闭，绝不让设置错误打断自动状态
  const badHost = createFakeHost({ defaultState: "wip", skipPattern: "(" });
  const badSession = badHost.addLiveSession("s-bad-rule");
  badSession.append("session/title", {
    title: "Telegram · 隧道不稳定",
    messageSeqs: [1],
    source: { kind: "fallback" },
  });
  await tick();
  assert.equal(badHost.sessionTitle.get(badSession).title, "🚧 Telegram · 隧道不稳定");
  badHost.dispose();
});

test("volatile settings hot-reload the tool on turn/start", async () => {
  const host = createFakeHost();
  const session = host.addLiveSession("s-custom", { initialTitle: "部署验证" });
  const exec = { agent: { session } };

  // 修改状态列表 + 指令 + 默认状态
  host.config.defaultState.set("coding");
  host.config.instructions.set("完成任务后务必改为 done");
  host.config.states.set([
    { key: "coding", prefix: "⚡", label: "编码中", description: "高速编码" },
    { key: "done", prefix: "✅", label: "完成", description: "已交付" },
  ]);

  // 触发 turn/start 让 assembly 对齐最新工具描述
  host.emit("session/event", session, { type: "turn/start" });
  const updatedTool = host.tools.get("session_prefix");
  assert.match(updatedTool.description, /"coding" \(⚡ 编码中\)/);
  assert.match(updatedTool.description, /New sessions already start in state "coding"/);
  assert.match(updatedTool.description, /Operator instructions for this tool:\n完成任务后务必改为 done/);

  // 新配置生效后，旧 key 不再可用
  await assert.rejects(() => updatedTool.execute({ state: "wip" }, exec), /unknown session state "wip"/);

  // 使用新 key 切换，并验证旧前缀被干净剥离
  const resCoding = await updatedTool.execute({ state: "coding" }, exec);
  assert.equal(resCoding.title, "⚡ 部署验证");
  const resDone = await updatedTool.execute({ state: "done" }, exec);
  assert.equal(resDone.title, "✅ 部署验证");

  // 关闭工具开关并在 turn/start 同步，工具应被注销
  host.config.enabled.set(false);
  host.emit("session/event", session, { type: "turn/start" });
  assert.equal(host.tools.get("session_prefix"), undefined);

  host.dispose();
});

test("/state command supports viewing, switching, and clearing state by key", async () => {
  const host = createFakeHost({ defaultState: "wip" });
  const session = host.addLiveSession("s-cmd", { initialTitle: "编写文档" });
  const cmd = host.commands.get("state");
  assert.ok(cmd, "/state command should be registered");

  const invoke = (rawInput) =>
    cmd.handler({
      rawInput,
      agent: { session, ctx: host.ctx },
    });

  // 1. /state 无参查看
  const resView = await invoke("");
  assert.equal(resView.kind, "success");
  assert.match(resView.text, /Current state: none/);
  assert.match(resView.text, /Default for new sessions: wip \(🚧 进行中\)/);

  // 2. /state review 切换状态
  const resSet = await invoke("review");
  assert.equal(resSet.kind, "success");
  assert.match(resSet.text, /Updated session state to 👀 待验收 \("👀 编写文档"\)/);

  // 3. 非 key 输入报错
  const resBad = await invoke("待验收");
  assert.equal(resBad.kind, "error");
  assert.match(resBad.text, /unknown session state "待验收"/);

  // 4. /state none 清除状态
  const resClear = await invoke("none");
  assert.equal(resClear.kind, "success");
  assert.match(resClear.text, /Cleared session state prefix; title is now "编写文档"/);

  host.dispose();
});

test("toolEnabled and jevEnabled switches operate independently", async () => {
  // 1. 关闭工具开关，保留 Jev 开关
  const host = createFakeHost({ toolEnabled: false, jevEnabled: true });
  assert.equal(host.tools.get("session_prefix"), undefined, "session_prefix should not be registered");

  // 2. 动态打开工具开关
  host.config.toolEnabled.set(true);
  const session = host.addLiveSession("s-switches", { initialTitle: "测试工程" });
  host.emit("session/event", session, { type: "turn/start" });
  assert.ok(host.tools.get("session_prefix"), "session_prefix should now be registered");

  // 3. 关闭 Jev 开关，保持工具开启
  host.config.jevEnabled.set(false);
  const snapshot = readSettings(host.config);
  assert.equal(snapshot.toolEnabled, true);
  assert.equal(snapshot.jevEnabled, false);
  assert.ok(host.tools.get("session_prefix"));

  host.dispose();
});

test("extractTurnContext keeps the human instruction and ignores harness injections", () => {
  const longOutcome = `故障已定位并修复。${"补充说明。".repeat(400)}最终结论：工作已完成，等你确认。`;
  const events = [
    {
      seq: 1,
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "请修复登录页面表单提交白屏的问题" }],
      },
    },
    {
      seq: 2,
      type: "user/message",
      data: {
        source: { kind: "runtime-context" },
        content: [{ type: "text", text: "注入的快照内容，不应被当成用户指令" }],
      },
    },
    {
      seq: 3,
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: longOutcome }] } },
    },
  ];

  const fakeSession = { id: "s-ctx", snapshotEvents: () => events };

  const startCtx = extractTurnContext(fakeSession, "start");
  assert.match(startCtx, /Current user instruction:\n请修复登录页面表单提交白屏的问题/);
  assert.doesNotMatch(startCtx, /注入的快照内容/);

  const endCtx = extractTurnContext(fakeSession, "end");
  assert.match(endCtx, /User instruction:\n请修复登录页面表单提交白屏的问题/);
  assert.match(endCtx, /Assistant outcome:/);
  // 超长产出被尾部截断，但人类指令必须完整保留
  assert.match(endCtx, /请修复登录页面表单提交白屏的问题/);
  assert.match(endCtx, /最终结论：工作已完成，等你确认。/);
  assert.ok(endCtx.length <= 2100, `context should stay within budget, got ${endCtx.length}`);
});

test("probeJevEndpoint resolves the environment credential and reports latency", async () => {
  const prevKey = process.env.JEV_API_KEY;
  const prevUrl = process.env.JEV_BASE_URL;
  delete process.env.JEV_BASE_URL;
  process.env.JEV_API_KEY = "env-key-for-probe";

  const originalFetch = globalThis.fetch;
  let seenAuth = "";
  try {
    globalThis.fetch = async (_url, init) => {
      seenAuth = String(init.headers.Authorization);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({ answers: { ping: { type: "choice", choice: "ok", confidence: 1 } } }),
      };
    };

    // 设置里没有 Key，只有环境变量：必须同样测通。
    const result = await probeJevEndpoint({}, readSettings(undefined));
    assert.equal(result.ok, true);
    assert.equal(seenAuth, "Bearer env-key-for-probe");
    assert.match(result.message, /typesafe\/jev-1\.13/);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevKey === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.JEV_BASE_URL;
    else process.env.JEV_BASE_URL = prevUrl;
  }
});

test("probeJevEndpoint reports a missing key without issuing a request", async () => {
  const prevKey = process.env.JEV_API_KEY;
  delete process.env.JEV_API_KEY;

  const originalFetch = globalThis.fetch;
  let called = false;
  try {
    globalThis.fetch = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const result = await probeJevEndpoint({}, readSettings(undefined));
    assert.equal(result.ok, false);
    assert.equal(called, false);
    assert.match(result.message, /JEV_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevKey === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = prevKey;
  }
});

test("apply registers the Jev probe route and serves a host-side probe result", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({ answers: { ping: { type: "choice", choice: "ok", confidence: 1 } } }),
    });

    const host = createFakeHost({ jevApiKey: "config-key" });
    const route = host.routes.get("/api/session-prefix/jev-probe");
    assert.ok(route, "the plugin must register the /api/session-prefix/jev-probe route");
    assert.deepEqual(route.methods, ["POST"]);
    assert.equal(route.requestBody, "buffered");

    // The client posts this exact path; the handler must accept a real Request.
    const request = new Request("http://127.0.0.1:4180/api/session-prefix/jev-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await route.fetch(request);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.match(body.message, /typesafe\/jev-1\.13/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** 等插件内部 queueMicrotask 与假 fetch 链落地。 */
const flushTurnWork = () => new Promise((resolve) => setTimeout(resolve, 10));

test("turn/start falls back to the running state whenever the host resumes the session", async () => {
  const host = createFakeHost({ defaultState: "none" });
  const session = host.addLiveSession("s-resume", { initialTitle: "⏸️ 部署验证" });

  host.emit("session/event", session, { type: "turn/start" });
  await flushTurnWork();
  assert.equal(host.sessionTitle.get(session).title, "🚧 部署验证");

  // 已是执行态：不再重复写入
  const writes = session.snapshotEvents().length;
  host.emit("session/event", session, { type: "turn/start" });
  await flushTurnWork();
  assert.equal(session.snapshotEvents().length, writes);

  // 从未打标的会话不会被强行加上前缀
  const plain = host.addLiveSession("s-plain", { initialTitle: "随手记一笔" });
  host.emit("session/event", plain, { type: "turn/start" });
  await flushTurnWork();
  assert.equal(host.sessionTitle.get(plain).title, "随手记一笔");

  host.dispose();

  // activeState=none：完全不回落
  const offHost = createFakeHost({ defaultState: "none", activeState: "none" });
  const offSession = offHost.addLiveSession("s-nofallback", { initialTitle: "⏸️ 部署验证" });
  offHost.emit("session/event", offSession, { type: "turn/start" });
  await flushTurnWork();
  assert.equal(offHost.sessionTitle.get(offSession).title, "⏸️ 部署验证");
  offHost.dispose();
});

test("only human user messages trigger the Jev start inference", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: { state: { type: "choice", choice: "bug", confidence: 0.93 } } }),
    };
  };
  try {
    const host = createFakeHost({ jevEnabled: true, jevApiKey: "mock-key", defaultState: "none" });
    const session = host.addLiveSession("s-human", { initialTitle: "网关排障" });

    session.append("user/message", {
      content: [{ type: "text", text: "实时快照，不该被当作指令" }],
      source: { kind: "runtime-context" },
    });
    await flushTurnWork();
    assert.equal(calls, 0, "harness injections must not trigger inference");
    assert.equal(host.sessionTitle.get(session).title, "网关排障");

    session.append("user/message", {
      content: [{ type: "text", text: "网关 500，帮我定位" }],
      source: { kind: "user" },
    });
    await flushTurnWork();
    assert.equal(calls, 1, "human input should trigger exactly one inference");
    assert.equal(host.sessionTitle.get(session).title, "🐛 网关排障");

    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Jev automatic state inference updates session titles at turn/start and turn/end", async () => {
  const originalFetch = globalThis.fetch;
  let simulatedChoice = "bug";
  let simulatedConfidence = 0.95;

  globalThis.fetch = async (_url, options) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          state: {
            type: "choice",
            choice: simulatedChoice,
            confidence: simulatedConfidence,
            probabilities: { [simulatedChoice]: simulatedConfidence },
          },
        },
      }),
    };
  };

  try {
    const host = createFakeHost({
      jevEnabled: true,
      jevApiKey: "mock-key",
      defaultState: "none",
    });
    const tracker = createStateTracker();
    const settings = readSettings(host.config);

    const session = host.addLiveSession("s-jev", { initialTitle: "用户中心服务" });
    session.append("user/message", {
      content: [{ type: "text", text: "系统报错 500，登录功能故障，请定位排查" }],
      source: { kind: "user" },
    });

    // 1. 回合开始：Jev 识别为 bug
    simulatedChoice = "bug";
    simulatedConfidence = 0.92;
    const updatedStart = await runJevStateInference(host.ctx, session, "start", tracker, settings);
    assert.equal(updatedStart, true);
    assert.equal(host.sessionTitle.get(session).title, "🐛 用户中心服务");

    // 2. 回合结束：完成修复，Jev 识别为 done
    session.append("assistant/message", {
      message: { content: [{ type: "text", text: "故障已彻底排查并修复，单元测试与 E2E 均通过，工作已全部完成。" }] },
    });
    simulatedChoice = "done";
    simulatedConfidence = 0.98;
    const updatedEnd = await runJevStateInference(host.ctx, session, "end", tracker, settings);
    assert.equal(updatedEnd, true);
    assert.equal(host.sessionTitle.get(session).title, "✅ 用户中心服务");

    // 3. 置信度过低时：不应触发更新
    simulatedChoice = "plan";
    simulatedConfidence = 0.45;
    const lowConfidenceResult = await runJevStateInference(host.ctx, session, "start", tracker, settings);
    assert.equal(lowConfidenceResult, false);
    assert.equal(host.sessionTitle.get(session).title, "✅ 用户中心服务"); // 依然保持原状态

    // 4. 重复状态：不触发额外更新
    simulatedChoice = "done";
    simulatedConfidence = 0.95;
    const sameStateResult = await runJevStateInference(host.ctx, session, "end", tracker, settings);
    assert.equal(sameStateResult, false);

    // 5. jevEnabled 为 false 时跳过
    host.config.jevEnabled.set(false);
    const disabledSettings = readSettings(host.config);
    simulatedChoice = "wip";
    const disabledResult = await runJevStateInference(host.ctx, session, "start", tracker, disabledSettings);
    assert.equal(disabledResult, false);

    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("B-01: Late Jev responses from earlier generation never overwrite newer state", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFirst;
  const firstPromise = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      // 第一次调用延迟等待
      await firstPromise;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            state: { type: "choice", choice: "bug", confidence: 0.99, probabilities: { bug: 0.99 } },
          },
        }),
      };
    }
    // 第二次调用立刻返回 done
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          state: { type: "choice", choice: "done", confidence: 0.99, probabilities: { done: 0.99 } },
        },
      }),
    };
  };

  try {
    const host = createFakeHost({ jevEnabled: true, jevApiKey: "mock-key", defaultState: "none" });
    const tracker = createStateTracker();
    const settings = readSettings(host.config);
    const session = host.addLiveSession("s-race", { initialTitle: "核心支付" });
    session.append("user/message", {
      content: [{ type: "text", text: "支付超时，请处理" }],
      source: { kind: "user" },
    });

    // 发起第 1 次推断（挂起）
    const p1 = runJevStateInference(host.ctx, session, "start", tracker, settings);

    // 发起第 2 次推断（立即完成为 done）
    const p2 = runJevStateInference(host.ctx, session, "end", tracker, settings);
    const res2 = await p2;
    assert.equal(res2, true);
    assert.equal(host.sessionTitle.get(session).title, "✅ 核心支付");

    // 释放第 1 次推断（晚返回）
    resolveFirst();
    const res1 = await p1;
    assert.equal(res1, false, "Late response should be rejected by generation check");
    assert.equal(host.sessionTitle.get(session).title, "✅ 核心支付", "Title should remain in newer state");

    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("B-02: Jev automatic inference preserves provider/fallback title source without supersede", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      answers: {
        state: { type: "choice", choice: "plan", confidence: 0.95, probabilities: { plan: 0.95 } },
      },
    }),
  });

  try {
    const host = createFakeHost({ jevEnabled: true, jevApiKey: "mock-key", defaultState: "none" });
    const tracker = createStateTracker();
    const settings = readSettings(host.config);

    // 初始标题由后台 provider 自动产生
    const session = host.addLiveSession("s-provider", {
      events: [
        {
          seq: 1,
          type: "session/title",
          data: { title: "需求技术方案调研", messageSeqs: [1], source: { kind: "provider" } },
        },
        {
          seq: 2,
          type: "user/message",
          data: { content: [{ type: "text", text: "我们来规划一下新架构" }], source: { kind: "user" } },
        },
      ],
    });

    const ok = await runJevStateInference(host.ctx, session, "start", tracker, settings);
    assert.equal(ok, true);

    const titleRecord = host.sessionTitle.get(session);
    assert.equal(titleRecord.title, "💡 需求技术方案调研");
    // 关键断言：source 依然保持原有的 provider，绝非 user（不会打断后续 LLM 起名）
    assert.equal(titleRecord.source.kind, "provider");

    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("B-03 & B-04: Single source of truth and strict Decisions response validation", async () => {
  const originalFetch = globalThis.fetch;
  let mockResponse = {};

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => mockResponse,
  });

  try {
    const host = createFakeHost({ jevEnabled: true, jevApiKey: "mock-key", defaultState: "none" });
    const tracker = createStateTracker();
    const settings = readSettings(host.config);
    const session = host.addLiveSession("s-guard", { initialTitle: "订单服务" });
    session.append("user/message", {
      content: [{ type: "text", text: "检查订单状态" }],
      source: { kind: "user" },
    });

    // 1. 非 choice 类型响应
    mockResponse = { answers: { state: { type: "text", text: "bug" } } };
    assert.equal(await runJevStateInference(host.ctx, session, "start", tracker, settings), false);

    // 2. 缺失 confidence 响应
    mockResponse = { answers: { state: { type: "choice", choice: "bug" } } };
    assert.equal(await runJevStateInference(host.ctx, session, "start", tracker, settings), false);

    // 3. 不在 criteria 内的非法 choice
    mockResponse = { answers: { state: { type: "choice", choice: "unknown-key", confidence: 1 } } };
    assert.equal(await runJevStateInference(host.ctx, session, "start", tracker, settings), false);

    // 4. B-03 验证：外部重命名将状态去掉后，哪怕 tracker 仍有记录，也以标题当前真实无状态为准进行更新
    tracker.assigned.set(session.id, { key: "bug", prefix: "🐛", label: "排障/修复" });
    // 此时标题是裸 "订单服务"（无前缀），Jev 给 bug，应能正常应用
    mockResponse = { answers: { state: { type: "choice", choice: "bug", confidence: 0.95 } } };
    assert.equal(await runJevStateInference(host.ctx, session, "start", tracker, settings), true);
    assert.equal(host.sessionTitle.get(session).title, "🐛 订单服务");

    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("B-08: Reject non-finite, negative, or greater-than-1 confidence values", async () => {
  const originalFetch = globalThis.fetch;
  let mockResponse = {};

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => mockResponse,
  });

  try {
    const host = createFakeHost({ jevEnabled: true, jevApiKey: "mock-key", defaultState: "none" });
    const tracker = createStateTracker();
    const settings = readSettings(host.config);
    const session = host.addLiveSession("s-finite", { initialTitle: "风控系统" });
    session.append("user/message", {
      content: [{ type: "text", text: "检查异常拦截" }],
      source: { kind: "user" },
    });

    // 1. confidence: Infinity
    mockResponse = { answers: { state: { type: "choice", choice: "bug", confidence: Infinity } } };
    assert.equal(await runJevStateInference(host.ctx, session, "start", tracker, settings), false);

    // 2. confidence: -Infinity
    mockResponse = { answers: { state: { type: "choice", choice: "bug", confidence: -Infinity } } };
    assert.equal(await runJevStateInference(host.ctx, session, "start", tracker, settings), false);

    // 3. confidence: -0.5 (负数)
    mockResponse = { answers: { state: { type: "choice", choice: "bug", confidence: -0.5 } } };
    assert.equal(await runJevStateInference(host.ctx, session, "start", tracker, settings), false);

    // 4. confidence: 1.5 (超界)
    mockResponse = { answers: { state: { type: "choice", choice: "bug", confidence: 1.5 } } };
    assert.equal(await runJevStateInference(host.ctx, session, "start", tracker, settings), false);

    // 5. 校验标题保持未变
    assert.equal(host.sessionTitle.get(session).title, "风控系统");

    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("B-07: In-flight request is rejected at commit time if jevEnabled becomes false without any subsequent events", async () => {
  const originalFetch = globalThis.fetch;
  let resolveInFlight;
  const inFlightPromise = new Promise((resolve) => {
    resolveInFlight = resolve;
  });

  globalThis.fetch = async () => {
    await inFlightPromise;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          state: { type: "choice", choice: "bug", confidence: 0.99 },
        },
      }),
    };
  };

  try {
    const host = createFakeHost({ jevEnabled: true, jevApiKey: "mock-key", defaultState: "none" });
    const tracker = createStateTracker();
    const session = host.addLiveSession("s-live-disable", { initialTitle: "消息网关" });
    session.append("user/message", {
      content: [{ type: "text", text: "网关排障" }],
      source: { kind: "user" },
    });

    // 1. 发起请求 A（使用动态配置 getter，挂起在飞行中）
    const p1 = runJevStateInference(host.ctx, session, "start", tracker, () => readSettings(host.config));

    // 2. 在没有任何新回合事件的情况下，用户将配置中 jevEnabled 设为 false
    host.config.jevEnabled.set(false);

    // 3. 释放请求 A 的网络返回
    resolveInFlight();
    const res1 = await p1;

    // 4. 提交前实时配置检查必须拒绝写回
    assert.equal(res1, false, "Commit check must detect live jevEnabled=false and reject write");
    assert.equal(host.sessionTitle.get(session).title, "消息网关");

    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("B-09: ToolEnabled priority and legacy enabled fallback with schema defaults", () => {
  // 1. 只有 enabled: false，无 toolEnabled（即 undefined），toolEnabled 回退到 false
  const cfg1 = {
    enabled: volatileCell(false),
  };
  const snap1 = readSettings(cfg1);
  assert.equal(snap1.toolEnabled, false);
  assert.equal(snap1.enabled, false);

  // 2. 显式 toolEnabled: true，即使 enabled: false，仍以 toolEnabled 为准
  const cfg2 = {
    enabled: volatileCell(false),
    toolEnabled: volatileCell(true),
  };
  const snap2 = readSettings(cfg2);
  assert.equal(snap2.toolEnabled, true);

  // 3. 显式 toolEnabled: false，即使 enabled: true，以 toolEnabled 为准
  const cfg3 = {
    enabled: volatileCell(true),
    toolEnabled: volatileCell(false),
  };
  const snap3 = readSettings(cfg3);
  assert.equal(snap3.toolEnabled, false);
});
