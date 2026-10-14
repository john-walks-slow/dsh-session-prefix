/**
 * Market screenshots: build a sidebar with several sessions in different states
 * (renamed to readable titles and badged via /state), then capture the sidebar and
 * the "会话状态" settings page into assets/.
 *
 * Runs against the isolated e2e instance only. Sessions are created with a tiny prompt
 * (a title-only session still counts as blank and stays out of the sidebar), then
 * decorated with host commands.
 */
import { mkdirSync } from "node:fs";
import { dismissStartupOverlays } from "./lib/overlays.mjs";

const PLAYWRIGHT = process.env.DSH_E2E_PLAYWRIGHT || "/root/projects/camoufox-mcp/node_modules/playwright-core/index.js";
const FIREFOX_BIN = process.env.DSH_E2E_FIREFOX_BIN || "/root/.cache/camoufox/camoufox-bin";
const { default: pw } = await import(PLAYWRIGHT);

const OUT = new URL("../assets/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const E2E_PORT = process.env.DSH_E2E_PORT;
if (!E2E_PORT) {
  console.log("no e2e port (DSH_E2E_PORT unset)");
  process.exit(1);
}
const url = `http://127.0.0.1:${E2E_PORT}/?token=${process.env.DSH_E2E_TOKEN || "e2etest"}`;

/** Sidebar rows to decorate: title to install, state key to set. */
const DECOR = [
  { title: "实现会话状态插件", state: "wip" },
  { title: "调研插件市场机制", state: "plan" },
  { title: "等待确认部署方案", state: "blocked" },
  { title: "重构认证模块", state: "review" },
  { title: "标记项目状态（已交付）", state: "done" },
];

const browser = await pw.firefox.launch({ executablePath: FIREFOX_BIN, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  await dismissStartupOverlays(page);

  const sessionList = page.locator('[aria-label="Sessions"]');
  await sessionList.waitFor({ state: "visible", timeout: 20000 });
  const rowIds = async () =>
    sessionList.locator('[data-row-key^="session:"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-row-key")?.replace(/^session:/, "") ?? "").filter(Boolean),
    );
  const composerReady = async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if ((await page.locator('[contenteditable="true"]:visible').count()) > 0) return true;
      await page.waitForTimeout(500);
    }
    return false;
  };

  // Phase 1 — a session only enters the sidebar once it holds a real user message
  // (a title-only session still counts as blank), so create them with a tiny prompt.
  for (let index = 0; index < DECOR.length; index += 1) {
    await page.locator('button[aria-label="New session"]').first().click({ timeout: 15000 });
    await page.waitForTimeout(2200);
    if (!(await composerReady())) {
      console.log(`composer missing while creating session #${index + 1}`);
      continue;
    }
    const composer = page.locator('[contenteditable="true"]:visible').first();
    await composer.fill("ok");
    await page.locator('button[aria-label="Send message"]').first().click({ timeout: 10000 });
    await page.waitForTimeout(4000);
  }

  // Wait for every created session to surface (their summaries land asynchronously).
  const deadline = Date.now() + 90000;
  while ((await rowIds()).length < DECOR.length && Date.now() < deadline) await page.waitForTimeout(1500);
  const ids = await rowIds();
  console.log(`sessions visible: ${ids.length}`);

  // Phase 2 — decorate by clicking the exact row, so title and badge always land together.
  for (const [index, item] of DECOR.entries()) {
    const id = ids[index];
    if (id === undefined) break;
    await sessionList
      .locator(`[data-row-key="session:${id}"]`)
      .click({ position: { x: 40, y: 16 }, timeout: 10000 })
      .catch(() => undefined);
    await page.waitForTimeout(1200);
    if (!(await composerReady())) continue;
    const composer = page.locator('[contenteditable="true"]:visible').first();
    await composer.fill(`/rename ${item.title}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    if (item.state !== undefined) {
      await composer.fill(`/state ${item.state}`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1200);
    }
    console.log(`decorated ${id} → ${item.state} ${item.title}`);
  }

  // Give the blank slot up so the list shows only real sessions.
  const firstReal = sessionList.locator('[data-row-key^="session:"]').first();
  if ((await firstReal.count()) > 0) {
    await firstReal.click({ position: { x: 40, y: 16 }, timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
  }
  const rendered = await sessionList.locator('[data-row-key^="session:"]').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()),
  );
  console.log("sidebar rows:", JSON.stringify(rendered));
  // Crop the tall sidebar element down to the rows it actually holds.
  const listBox = await sessionList.boundingBox();
  const lastBox = await sessionList.locator('[data-row-key^="session:"]').last().boundingBox();
  const shot = `${OUT}screenshot-1-session-prefixes.png`;
  if (listBox && lastBox) {
    await page.screenshot({
      path: shot,
      clip: {
        x: Math.round(listBox.x),
        y: Math.round(listBox.y),
        width: Math.round(listBox.width),
        height: Math.round(lastBox.y - listBox.y + lastBox.height + 16),
      },
    });
  } else {
    await sessionList.screenshot({ path: shot });
  }
  console.log(`wrote ${shot}`);

  // Settings page: sidebar footer entry → "会话状态" section.
  const settingsButton = page.locator('[aria-label="Settings"], button:has-text("Settings")').first();
  if ((await settingsButton.count()) > 0) {
    await settingsButton.click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const entry = page.getByText("会话状态", { exact: true }).first();
    if ((await entry.count()) > 0) {
      await entry.click({ timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(2000);
    }
    await page.screenshot({ path: `${OUT}screenshot-2-settings.png` });
    console.log(`wrote ${OUT}screenshot-2-settings.png`);
  } else {
    console.log("settings entry not found; skipped the settings screenshot");
  }
} catch (error) {
  console.log(`screenshots aborted: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
}
