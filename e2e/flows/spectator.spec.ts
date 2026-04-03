import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import {
  selectActiveDraft,
  selectSeat,
  closeSettings,
  openSettings,
  openDraftBoard,
  openDeckBuilder,
} from "../helpers/assertions";
import { expectCardVisible } from "../helpers/card-table";

test.describe("Spectator (unauthenticated)", () => {
  test.beforeEach(async ({ page }) => {
    await createMockContext(page, "spectator");
  });

  test("seat picks are highlighted in the card table", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Select draft "gamma" and seat 1
    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    // Seat 1 picked Sol Ring (#1), Elspeth Knight-Errant (#20), Mother of Runes (#21)
    // These should show the "Picked" status icon (emerald check)
    await expect(async () => {
      await expectCardVisible(page, "Sol Ring");
      await expectCardVisible(page, "Elspeth, Knight-Errant");
      await expectCardVisible(page, "Mother of Runes");
    }).toPass({ timeout: 5000 });

    // Verify picked status icons are present (title="Picked")
    for (const cardName of [
      "Sol Ring",
      "Elspeth, Knight-Errant",
      "Mother of Runes",
    ]) {
      const row = page
        .locator("tbody tr")
        .filter({ hasText: cardName })
        .first();
      await expect(row.locator('[title="Picked"]')).toBeVisible();
    }
  });

  test("seat deck in deck builder shows picked cards", async ({ page }) => {
    // Mock deck-state to return empty (spectator has no saved deck state)
    await page.route("**/api/drafts/*/deck-state*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          draftId: "gamma",
          seat: 1,
          zones: { deck: {}, sideboard: { sb: [] } },
          basicLands: {
            Plains: 0,
            Island: 0,
            Swamp: 0,
            Mountain: 0,
            Forest: 0,
          },
        }),
      }),
    );

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Select draft "gamma" and seat 1
    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    // Open the deck builder
    await openDeckBuilder(page);

    // The deck builder rebuilds from picks — seat 1 has Sol Ring, Elspeth, Mother of Runes
    await expect(async () => {
      await expect(page.getByText("Sol Ring")).toBeVisible();
      await expect(page.getByText("Mother of Runes")).toBeVisible();
    }).toPass({ timeout: 5000 });
  });

  test("pod view shows full draft snapshot", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Select draft "gamma"
    await selectActiveDraft(page, "gamma");
    await closeSettings(page);

    // Open draft board (Pod View)
    await openDraftBoard(page);

    // Verify draft name is visible in the modal header
    await expect(page.getByText("gamma")).toBeVisible();

    // Verify seat names from the fixture (use .first() to avoid strict mode
    // violations when a name appears in both the matrix header and a cell)
    await expect(page.getByText("Bob").first()).toBeVisible();
    await expect(page.getByText("Alice").first()).toBeVisible();
    await expect(page.getByText("Carol").first()).toBeVisible();

    // Verify picks are shown in the matrix
    await expect(page.getByText("Sol Ring")).toBeVisible();
    await expect(page.getByText("Mana Crypt")).toBeVisible();
    await expect(page.getByText("Brainstorm")).toBeVisible();
  });

  test("switching seats updates the card table", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Select draft "gamma" and seat 1
    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    // Verify seat 1's picks are marked as picked
    await expect(async () => {
      const solRingRow = page
        .locator("tbody tr")
        .filter({ hasText: "Sol Ring" })
        .first();
      await expect(solRingRow.locator('[title="Picked"]')).toBeVisible();
    }).toPass({ timeout: 5000 });

    // Switch to seat 5
    await openSettings(page);
    await selectSeat(page, 5);
    await closeSettings(page);

    // Seat 5 picked Scalding Tarn (#5) and Liliana of the Veil (#16)
    await expect(async () => {
      const tarnRow = page
        .locator("tbody tr")
        .filter({ hasText: "Scalding Tarn" })
        .first();
      await expect(tarnRow.locator('[title="Picked"]')).toBeVisible();

      const lilianaRow = page
        .locator("tbody tr")
        .filter({ hasText: "Liliana of the Veil" })
        .first();
      await expect(lilianaRow.locator('[title="Picked"]')).toBeVisible();
    }).toPass({ timeout: 5000 });

    // Seat 1's picks should no longer show as "Picked" for this seat
    const solRingRow = page
      .locator("tbody tr")
      .filter({ hasText: "Sol Ring" })
      .first();
    await expect(solRingRow.locator('[title="Picked"]')).toHaveCount(0);
  });
});
