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
import { expectCardVisible, scrollCardTable } from "../helpers/card-table";

test.describe("Spectator (unauthenticated)", () => {
  test.beforeEach(async ({ page }) => {
    // hideTaken defaults to true, which hides all taken cards from the card table.
    // The branch now derives taken-card state from board.picks (populated by the
    // first live poll) instead of from the slower /api/cards response, so taken
    // cards are hidden sooner. Spectator tests need to see taken cards with "Picked"
    // icons, so explicitly disable hide-taken for these tests.
    await page.addInitScript(() => {
      localStorage.setItem("hideTaken", "false");
    });
    await createMockContext(page, "spectator");
  });

  test("seat picks are highlighted in the card table", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Select draft "gamma" and seat 1
    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    // Seat 1 picked Sol Ring (row 1 of 40), Mother of Runes (row 12), Elspeth (row 33).
    // With hideTaken=false the table shows all 40 cards; the virtualizer only renders
    // ~22 rows from the current scroll position (visible + overscan:10). Elspeth at
    // row 33 is beyond that initial range, so we verify early-row cards first while
    // the table is at the top, then scroll to bring Elspeth into the rendered window.

    // Wait for board data to arrive and check Sol Ring + Mother of Runes (top of list)
    await expect(async () => {
      await expectCardVisible(page, "Sol Ring");
      await expectCardVisible(page, "Mother of Runes");
    }).toPass({ timeout: 5000 });

    const solRingRow = page.locator("tbody tr").filter({ hasText: "Sol Ring" }).first();
    await expect(solRingRow.locator('[title="Picked"]')).toBeVisible();
    const momRow = page.locator("tbody tr").filter({ hasText: "Mother of Runes" }).first();
    await expect(momRow.locator('[title="Picked"]')).toBeVisible();

    // Scroll near the bottom of the table to bring Elspeth (row 33/40) into the
    // virtualizer's rendered window, then verify its Picked icon.
    await scrollCardTable(page, 9999);
    await expectCardVisible(page, "Elspeth, Knight-Errant");
    const elspethRow = page.locator("tbody tr").filter({ hasText: "Elspeth, Knight-Errant" }).first();
    await expect(elspethRow.locator('[title="Picked"]')).toBeVisible();
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

    // The deck builder rebuilds from picks — seat 1 has Sol Ring, Elspeth, Mother of Runes.
    // Cards with imageUris render as <img alt="name"> inside a role="button" wrapper,
    // so getByRole("button") is the correct selector (getByText won't match alt attrs).
    await expect(async () => {
      await expect(page.getByRole("button", { name: "Sol Ring" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Mother of Runes" }).first()).toBeVisible();
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

    // Verify picks are shown in the matrix.
    // hideTaken=false means the card table behind the modal also shows these cards,
    // so use .first() to avoid strict-mode violations from duplicate text matches.
    await expect(page.getByText("Sol Ring").first()).toBeVisible();
    await expect(page.getByText("Mana Crypt").first()).toBeVisible();
    await expect(page.getByText("Brainstorm").first()).toBeVisible();
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

    // Seat 5 picked Scalding Tarn (row 8/40) and Liliana of the Veil (row 26/40).
    // Scalding Tarn is within the initial rendered window; Liliana is beyond it.
    // Check Tarn and verify Sol Ring is no longer "Picked" before scrolling away.
    await expect(async () => {
      const tarnRow = page
        .locator("tbody tr")
        .filter({ hasText: "Scalding Tarn" })
        .first();
      await expect(tarnRow.locator('[title="Picked"]')).toBeVisible();
    }).toPass({ timeout: 5000 });

    // Sol Ring (row 1) is still in the rendered window at this point — verify it
    // no longer shows as "Picked" for seat 5 before scrolling down to Liliana.
    const solRingRow = page
      .locator("tbody tr")
      .filter({ hasText: "Sol Ring" })
      .first();
    await expect(solRingRow.locator('[title="Picked"]')).toHaveCount(0);

    // Scroll to bring Liliana (row 26/40) into the virtualizer's rendered window.
    // Use a value past the midpoint to ensure Liliana is above the viewport center.
    await scrollCardTable(page, 9999);
    const lilianaRow = page
      .locator("tbody tr")
      .filter({ hasText: "Liliana of the Veil" })
      .first();
    await expect(lilianaRow.locator('[title="Picked"]')).toBeVisible();
  });
});
