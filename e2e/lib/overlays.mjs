/**
 * Dismiss the startup overlays (Preview Notice, API-key notice, workspace picker) that
 * otherwise swallow the clicks a script is about to make.
 *
 * The overlay can appear *after* the first check, so this keeps probing for a while
 * instead of bailing out as soon as the page looks clean.
 */
const DISMISS_LABELS = ["Configure later", "Continue", "Got it", "Skip", "Choose workspace", "Start"];

export async function dismissStartupOverlays(page, { rounds = 12 } = {}) {
  for (let round = 0; round < rounds; round += 1) {
    let clicked = false;
    for (const name of DISMISS_LABELS) {
      const button = page.getByRole("button", { name, exact: true });
      if ((await button.count()) > 0 && (await button.first().isVisible().catch(() => false))) {
        await button.first().click({ timeout: 5000 }).catch(() => undefined);
        clicked = true;
      }
    }
    await page.waitForTimeout(clicked ? 1200 : 700);
    if (round >= 4 && (await page.locator('[class*="_mask_"]').count()) === 0) return;
  }
}
