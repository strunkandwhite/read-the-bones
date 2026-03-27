import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api";
import syncStatusActive from "./fixtures/sync-status-active.json" with { type: "json" };
import cardsFixture from "./fixtures/cards.json" with { type: "json" };

test("sync polling updates data when lastSyncedAt changes", async ({
  page,
}) => {
  let pollCount = 0;
  let cardsFetched = 0;

  // Set up default mocks FIRST
  await mockApiRoutes(page, { syncStatus: syncStatusActive });

  // Then override specific routes — these take priority (LIFO order in Playwright)
  await page.route("**/api/sync-status*", async (route) => {
    pollCount++;
    const response =
      pollCount <= 2
        ? syncStatusActive
        : { ...syncStatusActive, lastSyncedAt: "1711100999" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });

  await page.route("**/api/cards*", async (route) => {
    cardsFetched++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(cardsFixture),
    });
  });

  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  // Select active draft to start polling
  await page.getByLabel("Settings").click();
  await page.locator("select").first().selectOption("gamma");
  await page.keyboard.press("Escape");

  const initialFetchCount = cardsFetched;

  // Wait for the polling to detect the timestamp change and trigger a refetch
  await expect(async () => {
    expect(cardsFetched).toBeGreaterThan(initialFetchCount);
  }).toPass({ timeout: 30_000 });
});
