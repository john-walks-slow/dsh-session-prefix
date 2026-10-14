/**
 * Autonomy probe — does the model maintain the state badge on its own?
 *
 * No operator instructions are configured. A brand-new session starts in the default
 * state (🚧 wip). The prompt is an ordinary one-shot task that clearly begins and ends
 * in a single turn. We then read the session log and report whether the model moved
 * the badge by itself (and to which state) — this is an observation, not a pass/fail gate.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";

const PLAYWRIGHT = process.env.DSH_E2E_PLAYWRIGHT || "/root/projects/camoufox-mcp/node_modules/playwright-core/index.js";
const FIREFOX_BIN = process.env.DSH_E2E_FIREFOX_BIN || "/root/.cache/camoufox/camoufox-bin";
const { default: pw } = await import(PLAYWRIGHT);
import { dismissStartupOverlays } from "./lib/overlays.mjs";

const execFileP = promisify(execFile);
const HOME = process.env.DSH_E2E_HOME || "/root/.dsh-e2e";
const SESSIONS_ROOT = `${HOME}/sessions`;
const RUN = Date.now();
const MARKER = `autonomy-probe-${RUN}`;
const ARTIFACTS = new URL("../docs/features/261013-session-prefix/e2e/261013-session-prefix/", import.meta.url).pathname;
mkdirSync(ARTIFACTS, { recursive: true });

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
    return null;
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

const E2E_PORT = process.env.DSH_E2E_PORT;
if (!E2E_PORT) {
  console.log("no e2e port (DSH_E2E_PORT unset)");
  process.exit(1);
}
const url = `http://127.0.0.1:${E2E_PORT}/?token=${process.env.DSH_E2E_TOKEN || "e2etest"}`;

const browser = await pw.firefox.launch({ executablePath: FIREFOX_BIN, headless: true });
const page = await browser.newPage();
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  await dismissStartupOverlays(page);

  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 20000 });

  await page.locator('button[aria-label="New session"]').first().click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  await composer.fill(
    `[${MARKER}] 一次性小任务：告诉我本仓库 package.json 里的 name 字段值，然后这个任务就结束了。不需要等我确认。`,
  );
  await page.locator('button[aria-label="Send message"]').first().click();

  const file = await waitFor(() => findByMarker(MARKER), { what: "session log" });
  await waitFor(
    async () => parseEvents(await readLog(file)).filter((e) => e.type === "turn/end").length >= 1,
    { what: "turn to end" },
  );
  // give the post-turn writeback a moment to settle
  await page.waitForTimeout(3000);

  const events = parseEvents(await readLog(file));
  const calls = events.filter((event) => event.type === "tool/call").map((event) => event.data);
  const titles = events.filter((event) => event.type === "session/title").map((event) => event.data);
  const reply = events
    .filter((event) => event.type === "assistant/message")
    .flatMap((event) => event.data.content ?? [])
    .map((block) => block.text ?? "")
    .join(" ")
    .slice(0, 200);

  console.log(`\n[autonomy probe] session=${parseEvents(await readLog(file)).find((e) => e.type === "session")?.id}`);
  console.log(`tool calls: ${calls.map((call) => call.name).join(" → ") || "(none)"}`);
  console.log(`title events: ${JSON.stringify(titles.map((t) => `${t.source.kind}:${t.title}`))}`);
  console.log(`assistant reply: ${reply}`);

  const stateCalls = calls.filter((call) => call.name === "session_prefix");
  const finalTitle = titles.at(-1)?.title ?? "";
  const badge = /^(🚧|⏸️|👀|✅|💡|🐛)\s/u.exec(finalTitle)?.[1] ?? "(none)";
  console.log(`\nVERDICT: called session_prefix on its own = ${stateCalls.length > 0}; final badge = ${badge}`);

  await page.screenshot({ path: `${ARTIFACTS}04-autonomy-probe.png`, fullPage: true });
} catch (error) {
  console.log(`probe aborted: ${error instanceof Error ? error.message : String(error)}`);
  await page.screenshot({ path: `${ARTIFACTS}99-autonomy-failure.png`, fullPage: true }).catch(() => undefined);
} finally {
  await browser.close();
}
