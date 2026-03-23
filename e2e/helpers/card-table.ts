import { Page, expect } from "@playwright/test";

export async function getVisibleCardNames(page: Page): Promise<string[]> {
  const cells = page.locator("table tbody tr td:first-child");
  return cells.allTextContents();
}

export async function expectCardVisible(page: Page, cardName: string) {
  await expect(
    page.locator("table tbody").getByText(cardName, { exact: false }),
  ).toBeVisible();
}

export async function expectCardNotVisible(page: Page, cardName: string) {
  await expect(
    page.locator("table tbody").getByText(cardName, { exact: false }),
  ).not.toBeVisible();
}

export async function clickColumnHeader(page: Page, headerText: string) {
  await page.locator("table thead th").filter({ hasText: headerText }).click();
}
