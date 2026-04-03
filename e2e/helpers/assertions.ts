import { Page, expect } from "@playwright/test";

export async function expectCardTableToShow(
  page: Page,
  expectedCardNames: string[],
) {
  for (const name of expectedCardNames) {
    await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  }
}

export async function expectCardTableCount(page: Page, count: number) {
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(count);
}

export async function expectCardNotInTable(page: Page, cardName: string) {
  await expect(
    page.getByRole("row").filter({ hasText: cardName }),
  ).toHaveCount(0);
}

export async function expectPhase(page: Page, phase: string) {
  await expect(page.getByText(phase, { exact: false })).toBeVisible();
}

export async function expectQueueContains(page: Page, cardName: string) {
  const queuePanel = page.locator("text=Pick Queue").locator("..");
  await expect(queuePanel.getByText(cardName)).toBeVisible();
}

export async function expectQueueDoesNotContain(page: Page, cardName: string) {
  const queuePanel = page.locator("text=Pick Queue").locator("..");
  await expect(queuePanel.getByText(cardName)).toHaveCount(0);
}

export async function openSettings(page: Page) {
  await page.getByLabel("Settings").click();
  await expect(page.getByText("Settings").first()).toBeVisible();
}

export async function selectActiveDraft(page: Page, draftId: string) {
  await openSettings(page);
  await page.locator("select").first().selectOption(draftId);
}

export async function selectSeat(page: Page, seatNumber: number) {
  await page.locator("select").nth(1).selectOption(String(seatNumber));
}

export async function closeSettings(page: Page) {
  await page.getByLabel("Close").click();
}

export async function openDraftBoard(page: Page) {
  const button = page.getByLabel(/Pod View|Your Pick/);
  await button.click();
}

export async function openDeckBuilder(page: Page) {
  await page.getByLabel("Deck Builder").click();
}

export async function openCardStatsModal(page: Page, cardName: string) {
  await page.getByRole("row").filter({ hasText: cardName }).click();
  await expect(page.getByLabel("Close")).toBeVisible();
}
