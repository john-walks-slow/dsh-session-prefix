import assert from "node:assert/strict";
import test from "node:test";
import { apply, DEFAULT_STATES } from "../dist/index.js";
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

  const ctx = {
    logger: {
      info() {},
      warn() {},
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

  const dispose = apply(ctx, config);
  return { ctx, config, sessions, sessionTitle, tools, commands, emit, addLiveSession, dispose };
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

test("session_state tool sets, replaces (without stacking), and clears state prefixes by key", async () => {
  const host = createFakeHost();
  const session = host.addLiveSession("s-1", { initialTitle: "重构认证模块" });
  const tool = host.tools.get("session_state");
  assert.ok(tool, "session_state tool should be registered");
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
  const updatedTool = host.tools.get("session_state");
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
  assert.equal(host.tools.get("session_state"), undefined);

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
