import { Page } from "@playwright/test";

/**
 * Scrolls the card table's virtual scroll container to the specified pixel
 * offset so that the virtualizer renders rows that would otherwise be outside
 * the initial viewport.  Call this before asserting on cards that sort late
 * in the list (e.g. row 26+ out of 40 when hideTaken=false).
 */
export async function scrollCardTable(page: Page, scrollTop: number): Promise<void> {
  await page.evaluate((top) => {
    const el = document.querySelector<HTMLElement>('div[style*="overflow-y: auto"]');
    if (el) el.scrollTop = top;
  }, scrollTop);
  // Brief pause for the virtualizer to re-render after scroll
  await page.waitForTimeout(150);
}

/**
 * Reads the card names currently rendered by the virtualizer.
 *
 * The row set is captured in a single snapshot rather than by indexing into
 * the live locator. Rows are measured dynamically (`measureElement`) against a
 * 48px `estimateSize`, so once real heights land the virtualizer re-renders a
 * smaller window — on a 375px viewport the rendered count drops from 20 to 18.
 * Reading `count()` first and then awaiting each `nth(i)` separately can ask
 * for a row that has since been unmounted, which never resolves.
 */
export async function getVisibleCardNames(page: Page): Promise<string[]> {
  const rows = page.locator("tbody tr");
  await rows.first().waitFor();
  const names = await rows.evaluateAll((elements) =>
    elements.map((row) => row.querySelector("td")?.textContent ?? ""),
  );
  return names.map((name) => name.trim()).filter((name) => name.length > 0);
}

export async function expectCardVisible(page: Page, cardName: string) {
  const rows = page.locator("tbody tr");
  await rows.filter({ hasText: cardName }).first().waitFor({ state: "visible" });
}

export async function expectCardNotVisible(page: Page, cardName: string) {
  const rows = page.locator("tbody tr").filter({ hasText: cardName });
  await rows.waitFor({ state: "hidden" }).catch(() => {
    // Card may not exist at all, which is fine
  });
}

export async function clickColumnHeader(page: Page, headerText: string) {
  await page.locator("thead th").filter({ hasText: headerText }).click();
}
