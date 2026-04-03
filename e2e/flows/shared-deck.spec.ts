import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";

test.describe("Shared deck", () => {
  test.beforeEach(async ({ page }) => {
    await createMockContext(page, "shared-deck");

    // Mock card stats endpoint for stats modal test
    await page.route("**/api/cards/stats*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          pick: { drafts_in_pool: 1, times_picked: 1, avg_pick: 5, median_pick: 5, geomean_pick: 5 },
          pick_history: [],
          pick_distribution: [],
          times_banned: 0,
          color_pair_breakdown: [],
        }),
      }),
    );
  });

  test("loads shared deck from URL", async ({ page }) => {
    await page.goto("/?deck=test-deck-123");
    await expect(page.locator("table")).toBeVisible();

    // Deck builder should auto-open with cards from shared-deck.json.
    // Cards render as images in the deck builder (via DeckCard), so match by alt text.
    await expect(page.getByAltText("Sol Ring").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByAltText("Counterspell").first()).toBeVisible();
    await expect(page.getByAltText("Swords to Plowshares").first()).toBeVisible();
    await expect(page.getByAltText("Lightning Bolt").first()).toBeVisible();
    await expect(page.getByAltText("Brainstorm").first()).toBeVisible();

    // Verify both zones are rendered
    await expect(page.getByText("Sideboard", { exact: true })).toBeVisible();
    await expect(page.getByAltText("Snapcaster Mage").first()).toBeVisible();
  });

  test("shows source draft and seat info", async ({ page }) => {
    await page.goto("/?deck=test-deck-123");
    await expect(page.locator("table")).toBeVisible();

    // Wait for deck builder to load
    await expect(page.getByAltText("Sol Ring").first()).toBeVisible({ timeout: 10000 });

    // Header shows the source draft name from draftMetadata
    await expect(page.getByText("Delta Draft")).toBeVisible();

    // Header shows seat info (seat 5 from shared-deck.json)
    await expect(page.getByText("Seat 5")).toBeVisible();
  });

  test("card stats modal from shared deck", async ({ page }) => {
    await page.goto("/?deck=test-deck-123");
    await expect(page.locator("table")).toBeVisible();

    // Wait for the deck builder to load
    await expect(page.getByAltText("Sol Ring").first()).toBeVisible({ timeout: 10000 });

    // Close the deck builder modal so the card table is clickable
    await page.getByLabel("Close").click();

    // Click a card row in the card table to open the stats modal
    await page.getByRole("row").filter({ hasText: "Sol Ring" }).click();

    // Stats modal should open with Pick Score visible
    await expect(page.getByText("Pick Score")).toBeVisible({ timeout: 5000 });
  });
});
