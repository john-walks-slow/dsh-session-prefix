/**
 * dsh-session-state e2e — full behavioral test through the GUI with a real model.
 *
 * Flow: open the e2e GUI → new session → one ordinary turn (the host's automatic
 * fallback/provider title must come out prefixed with the default state 🚧) →
 * `/state done` (a user command must swap the prefix to ✅ without stacking) →
 * `/state none` (must strip the prefix) → one model turn told to call
 * `session_state` with state="review" (the tool must write the 👀 prefix).
 *
 * Assertions read durable evidence: the session log's `session/title` events and
 * `tool/call` arguments, plus the sidebar's rendered row titles.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";

// The browser used to drive the GUI is host-specific; both knobs exist so this script
// stays runnable outside the machine it was written on.
const PLAYWRIGHT = process.env.DSH_E2E_PLAYWRIGHT || "/root/projects/camoufox-mcp/node_modules/playwright-core/index.js";
const FIREFOX_BIN = process.env.DSH_E2E_FIREFOX_BIN || "/root/.cache/camoufox/camoufox-bin";
const { default: pw } = await import(PLAYWRIGHT);
import { dismissStartupOverlays } from "./lib/overlays.mjs";

const execFileP = promisify(execFile);
const HOME = process.env.DSH_E2E_HOME || "/root/.dsh-e2e";
const SESSIONS_ROOT = `${HOME}/sessions`;
const RUN = Date.now();
const MARKER = `session-state-${RUN}`;

const ARTIFACTS = new URL("../docs/features/261013-session-state/e2e/261013-session-state/", import.meta.url).pathname;
mkdirSync(ARTIFACTS, { recursive: true });
console.log(`home=${HOME}\nartifacts=${ARTIFACTS}`);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionFiles() {
  if (!existsSync(SESSIONS_ROOT)) return [];
  return readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((project) => {
      const dir = `${SESSIONS_ROOT}/${project.name}`;
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
        .map((entry) => `${dir}/${entry.name}/session.v4.jsonl.zstd`);
    })
    .filter(existsSync);
}

async function readLog(file) {
  try {
    const { stdout } = await execFileP("zstd", ["-dc", file], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null; // partial frame while the turn is still writing
  }
}

function parseEvents(log) {
  return (log ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The session file whose log contains `marker`, newest first. */
async function findByMarker(marker) {
  const matches = [];
  for (const file of sessionFiles()) {
    const log = await readLog(file);
    if (log && log.includes(marker)) matches.push(file);
  }
  matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return matches[0] ?? null;
}

async function waitFor(predicate, { timeoutMs = 240000, intervalMs = 2500, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

const holdsFor = async (predicate, timeoutMs = 25000) =>
  waitFor(predicate, { timeoutMs, intervalMs: 1000, what: "condition" })
    .then((value) => value)
    .catch(() => false);

async function turnCount(sessionFile) {
  const log = await readLog(sessionFile);
  return parseEvents(log).filter((event) => event.type === "turn/end").length;
}

const titleEvents = async (file) =>
  parseEvents(await readLog(file))
    .filter((event) => event.type === "session/title")
    .map((event) => event.data);

const E2E_PORT = process.env.DSH_E2E_PORT;
if (!E2E_PORT) {
  console.log("FAIL  no e2e port (DSH_E2E_PORT unset)");
  process.exit(1);
}
const url = `http://127.0.0.1:${E2E_PORT}/?token=${process.env.DSH_E2E_TOKEN || "e2etest"}`;

const browser = await pw.firefox.launch({ executablePath: FIREFOX_BIN, headless: true });
const page = await browser.newPage();
let exitCode = 0;
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  await dismissStartupOverlays(page);

  const sendPrompt = async (prompt) => {
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.waitFor({ state: "visible", timeout: 20000 });
    await composer.fill(prompt);
    await page.locator('button[aria-label="Send message"]').first().click();
  };
  const newSession = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.locator('button[aria-label="New session"]').first().click({ timeout: 15000 });
      await page.waitForTimeout(2500);
      if ((await page.locator('[contenteditable="true"]').count()) > 0) return;
      for (const name of ["Configure later", "Continue", "Choose workspace"]) {
        const button = page.getByRole("button", { name, exact: true });
        if ((await button.count()) > 0) await button.first().click({ timeout: 5000 }).catch(() => undefined);
      }
      await page.waitForTimeout(1500);
    }
  };

  /** Every rendered sidebar session row title (scope: the session list only). */
  const sidebarRowTitles = async () => {
    const sessionList = page.locator('[aria-label="Sessions"]');
    if ((await sessionList.count()) === 0) return [];
    return sessionList.locator('[data-row-key^="session:"]').evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? "").trim()),
    );
  };

  // --- turn 1: a new session must receive the default state prefix -----------
  await newSession();
  await sendPrompt(`[${MARKER}] Reply with exactly: ok`);
  const file = await waitFor(() => findByMarker(MARKER), { what: "session log" });
  await waitFor(async () => (await turnCount(file)) >= 1, { what: "turn 1 to end" });
  const sessionId = parseEvents(await readLog(file)).find((event) => event.type === "session")?.id;
  console.log(`session = ${sessionId}`);

  const afterTurn1 = await titleEvents(file);
  const autoTitles = afterTurn1.filter((entry) => entry.source.kind !== "user");
  const rawAuto = autoTitles.filter((entry) => !entry.title.startsWith("🚧 "));
  const prefixedAuto = autoTitles.filter((entry) => entry.title.startsWith("🚧 "));
  check(
    "the host produced at least one automatic default title",
    autoTitles.length >= 1,
    JSON.stringify(afterTurn1.map((entry) => `${entry.source.kind}:${entry.title}`)),
  );
  // 宿主先写不带前缀的 fallback/provider 标题，插件紧接着补一条同 source 的带前缀标题；
  // 两者数量相等即证明每条自动标题都被补上了默认状态，且后台 provider 没有被中断。
  check(
    "every automatic title (fallback and provider) was re-emitted with the default wip prefix",
    rawAuto.length >= 1 && prefixedAuto.length === rawAuto.length,
    `raw=${rawAuto.length} prefixed=${prefixedAuto.length} — ${JSON.stringify(autoTitles.map((entry) => entry.title))}`,
  );
  check(
    "the final title after turn 1 is the default wip state",
    (afterTurn1.at(-1)?.title ?? "").startsWith("🚧 "),
    afterTurn1.at(-1)?.title ?? "(none)",
  );
  const rows1 = await sidebarRowTitles();
  check(
    "the sidebar renders the default-state title",
    rows1.some((row) => row.startsWith("🚧 ")),
    JSON.stringify(rows1),
  );
  await page.screenshot({ path: `${ARTIFACTS}01-default-state.png`, fullPage: true });

  // --- user command: /state done must swap the prefix, never stack -----------
  await sendPrompt("/state done");
  const swapped = await holdsFor(async () => {
    const titles = await titleEvents(file);
    return titles.at(-1)?.title?.startsWith("✅ ") === true;
  });
  check("`/state done` swapped the prefix to done", swapped === true, (await titleEvents(file)).at(-1)?.title ?? "(none)");
  const rows2 = await sidebarRowTitles();
  check(
    "the sidebar shows the swapped title with no stacked prefixes",
    rows2.some((row) => row.startsWith("✅ ")) && !rows2.some((row) => row.includes("🚧 ✅") || row.includes("✅ 🚧")),
    JSON.stringify(rows2),
  );
  await page.screenshot({ path: `${ARTIFACTS}02-state-done.png`, fullPage: true });

  // --- user command: /state none must strip the prefix -----------------------
  await sendPrompt("/state none");
  const cleared = await holdsFor(async () => {
    const titles = await titleEvents(file);
    const last = titles.at(-1)?.title ?? "";
    return last.length > 0 && !last.startsWith("✅ ") && !last.startsWith("🚧 ");
  });
  check("`/state none` stripped the prefix", cleared === true, (await titleEvents(file)).at(-1)?.title ?? "(none)");

  // --- model turn: the session_state tool must set review --------------------
  const turnsBeforeTool = await turnCount(file);
  await sendPrompt(
    `[${MARKER}] Automated e2e test. Call the session_state tool exactly once with state="review" ` +
      "(no session_id), then reply with one short line. Use no other tools.",
  );
  await waitFor(async () => (await turnCount(file)) > turnsBeforeTool, { what: "tool turn to end" });
  const events = parseEvents(await readLog(file));
  const calls = events.filter((event) => event.type === "tool/call").map((event) => event.data);
  const stateCall = calls.find((call) => call.name === "session_state");
  const callArgs = (call) => {
    try {
      return JSON.parse(call.arguments);
    } catch {
      return {};
    }
  };
  console.log(`calls: ${calls.map((call) => call.name).join(" → ") || "(none)"}`);
  check("session_state is exposed to the model", stateCall !== undefined, stateCall ? JSON.stringify(callArgs(stateCall)) : "no call");
  check(
    "the model asked for state=review",
    stateCall !== undefined && callArgs(stateCall).state === "review",
    stateCall ? JSON.stringify(callArgs(stateCall)) : "no call",
  );
  check(
    "the tool wrote the review prefix to the log",
    await holdsFor(async () => ((await titleEvents(file)).at(-1)?.title ?? "").startsWith("👀 ")),
    (await titleEvents(file)).at(-1)?.title ?? "(none)",
  );
  check(
    "the sidebar renders the tool-applied state",
    (await sidebarRowTitles()).some((row) => row.startsWith("👀 ")),
    JSON.stringify(await sidebarRowTitles()),
  );
  await page.screenshot({ path: `${ARTIFACTS}03-tool-review.png`, fullPage: true });

  // --- no stacked prefixes anywhere in the durable log ----------------------
  const allTitles = (await titleEvents(file)).map((entry) => entry.title);
  check(
    "no title ever stacked two state prefixes",
    !allTitles.some((title) => /^(?:🚧|⏸️|👀|✅|💡|🐛) (?:🚧|⏸️|👀|✅|💡|🐛) /u.test(title)),
    JSON.stringify(allTitles),
  );
} catch (error) {
  exitCode = 1;
  console.log(`FAIL  e2e aborted: ${error instanceof Error ? error.message : String(error)}`);
  await page.screenshot({ path: `${ARTIFACTS}99-failure.png`, fullPage: true }).catch(() => undefined);
} finally {
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${failed.length === 0 && exitCode === 0 ? "ALL PASS" : "FAILURES"} — ${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
}
process.exit(exitCode === 0 && results.every((entry) => entry.ok) ? 0 : 1);
