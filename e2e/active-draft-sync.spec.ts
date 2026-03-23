import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api";
import syncStatusActive from "./fixtures/sync-status-active.json" with { type: "json" };
import cardsFixture from "./fixtures/cards.json" with { type: "json" };

test("active draft shows sync indicator", async ({ page }) => {
  await mockApiRoutes(page, { syncStatus: syncStatusActive });
  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  // Open settings and select the active draft
  await page.getByLabel("Settings").click();
  await page.locator("select").first().selectOption("gamma");
  await page.keyboard.press("Escape");

  // Sync indicator should be visible with the Sync button
  await expect(page.getByText("Sync")).toBeVisible();
});

test("sync now button triggers manual sync", async ({ page }) => {
  let syncRequested = false;

  await mockApiRoutes(page, {
    syncStatus: syncStatusActive,
  });

  // Override POST /api/sync to track calls — registered AFTER mockApiRoutes so it takes priority
  await page.route("**/api/sync", async (route) => {
    if (route.request().method() === "POST") {
      syncRequested = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "completed",
          lastSyncedAt: "1711100060",
          picksInserted: 2,
        }),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  // Select active draft
  await page.getByLabel("Settings").click();
  await page.locator("select").first().selectOption("gamma");
  await page.keyboard.press("Escape");

  // Click sync button
  await page.getByText("Sync").click();

  await expect(async () => {
    expect(syncRequested).toBe(true);
  }).toPass({ timeout: 2000 });
});

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
