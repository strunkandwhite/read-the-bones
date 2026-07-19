import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import {
  selectActiveDraft,
  selectSeat,
  closeSettings,
  openSettings,
  openDeckBuilder,
} from "../helpers/assertions";

test.describe("Sheet-draft deck builder (local mode)", () => {
  test.beforeEach(async ({ page }) => {
    // No authenticateAs — sheet drafts have no seat tokens.
    await page.addInitScript(() => {
      localStorage.setItem("hideTaken", "false");
    });
    await createMockContext(page, "sheet-draft");

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

  test("add a card, persist across reload, isolate per seat", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    // Open the card modal for an unpicked card and add it. The board (and its
    // isSheetDraft flag) only arrives after the first /live poll, so retry
    // until the "Add to Deck Builder" action is available.
    await expect(async () => {
      await page.locator("tbody tr").filter({ hasText: "Sylvan Library" }).first().click();
      await expect(page.getByRole("button", { name: "Add to Deck Builder" })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 10000 });

    const addButton = page.getByRole("button", { name: "Add to Deck Builder" });
    await addButton.click();
    // Button flips to the remove label once the local float lands.
    await expect(page.getByRole("button", { name: "Remove from Deck Builder" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Deck builder shows picks + the added card.
    await openDeckBuilder(page);
    await expect(page.getByRole("button", { name: "Sol Ring" }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Sylvan Library" }).first()).toBeVisible();

    // Wait for the local float to land in storage before reloading. (The full
    // deckState key is only written once an arrangement edit dirties the deck —
    // unit tests cover that path; this flow persists via localFloats.)
    await page.waitForFunction(() => localStorage.getItem("localFloats:gamma:1") !== null);

    // Reload — the added card must survive (localStorage persistence).
    // Active draft + selected seat persist via localStorage too, and so does
    // the deck builder modal's own open/closed state (useModalManagement
    // writes "deckBuilderOpen" and restores it once the store hydrates), so
    // it reopens automatically — no need to click "Deck Builder" again.
    await page.reload();
    await expect(page.locator("table")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sylvan Library" }).first()).toBeVisible({ timeout: 10000 });

    // Switch to seat 2 — its deck must NOT contain seat 1's added card.
    // Escape closes the still-open deck builder modal (useModalManagement
    // listens for it); Settings must be reopened to reach the seat selector.
    await page.keyboard.press("Escape");
    await openSettings(page);
    await selectSeat(page, 2);
    await closeSettings(page);
    await openDeckBuilder(page);
    await expect(page.getByRole("button", { name: "Sylvan Library" })).toHaveCount(0);
  });

  test("queue and pick buttons never appear in local mode", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    await expect(async () => {
      await page.locator("tbody tr").filter({ hasText: "Land Tax" }).first().click();
      await expect(page.getByRole("button", { name: "Add to Deck Builder" })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Queue", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hold to pick this card" })).toHaveCount(0);
  });
});
