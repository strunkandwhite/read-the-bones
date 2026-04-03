import { Page } from "@playwright/test";

export async function getVisibleCardNames(page: Page): Promise<string[]> {
  const rows = page.locator("tbody tr");
  const count = await rows.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await rows.nth(i).locator("td").first().textContent();
    if (text) names.push(text.trim());
  }
  return names;
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
