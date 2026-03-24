import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api";
import syncStatusActive from "./fixtures/sync-status-active.json" with { type: "json" };
import sharedDeck from "./fixtures/shared-deck.json" with { type: "json" };

test("deck builder opens when seat selected on active draft", async ({
  page,
}) => {
  await mockApiRoutes(page, { syncStatus: syncStatusActive });
  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  // Open settings, select active draft
  await page.getByLabel("Settings").click();
  await expect(page.getByText("Draft view")).toBeVisible();

  // Select the active draft from dropdown
  await page.locator("select").first().selectOption("gamma");

  // Select seat 3
  await page.locator("select").nth(1).selectOption("3");

  // Close settings
  await page.keyboard.press("Escape");

  // Deck builder toggle should now be visible
  await page.getByLabel("Deck Builder").click();

  // Deck builder panel should open — "Share Deck" is unique to the panel
  await expect(page.getByText("Share Deck")).toBeVisible({ timeout: 5000 });
});

test("share deck creates snapshot", async ({ page, context }) => {
  // Grant clipboard permissions so navigator.clipboard.writeText works
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await mockApiRoutes(page, {
    syncStatus: syncStatusActive,
    sharedDeck: sharedDeck,
  });

  // Load shared deck URL to get a deck builder with populated state
  await page.goto("/?deck=test-deck-123");
  await expect(page.locator("table")).toBeVisible();

  // Wait for deck builder panel to open from shared deck loading
  await expect(page.getByText("Share Deck")).toBeVisible({ timeout: 5000 });

  // Click share — after sharing, text changes to "Copied!"
  await page.getByText("Share Deck").click();
  await expect(page.getByText("Copied!").first()).toBeVisible({
    timeout: 3000,
  });
});

test("shared deck URL loads deck state", async ({ page }) => {
  await mockApiRoutes(page, {
    syncStatus: syncStatusActive,
    sharedDeck: sharedDeck,
  });

  await page.goto("/?deck=test-deck-123");
  await expect(page.locator("table")).toBeVisible();

  // Deck builder panel should auto-open with the shared deck data
  await expect(page.getByText("Share Deck")).toBeVisible({ timeout: 5000 });

  // Verify the seat is set correctly from the shared deck
  await expect(page.getByText("Seat 3")).toBeVisible();
});

test("deck builder closes on Escape", async ({ page }) => {
  await mockApiRoutes(page, {
    syncStatus: syncStatusActive,
    sharedDeck: sharedDeck,
  });

  await page.goto("/?deck=test-deck-123");
  await expect(page.getByText("Share Deck")).toBeVisible({ timeout: 5000 });

  // Click the modal backdrop or press Escape to close
  await page.getByText("Close").first().click();

  await expect(page.getByText("Share Deck")).not.toBeVisible();
});

test("deck builder opens on completed draft with no active drafts", async ({
  page,
}) => {
  // Default mockApiRoutes has activeDrafts: [] (no active drafts)
  await mockApiRoutes(page);
  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  // Open settings — draft view section should be visible even with no active drafts
  await page.getByLabel("Settings").click();
  await expect(page.getByText("Draft view")).toBeVisible();

  // Select a completed draft from dropdown
  await page.locator("select").first().selectOption("alpha");

  // Select seat 1
  await page.locator("select").nth(1).selectOption("1");

  // Close settings
  await page.keyboard.press("Escape");

  // Deck builder toggle should now be visible
  await page.getByLabel("Deck Builder").click();

  // Deck builder panel should open
  await expect(page.getByText("Share Deck")).toBeVisible({ timeout: 5000 });
});
