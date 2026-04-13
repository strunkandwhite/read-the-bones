import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { authenticateAs } from "../helpers/auth";
import { openDraftBoard } from "../helpers/assertions";
import liveBoardFixture from "../fixtures/live-board.json" with { type: "json" };

const standingsWithMatches = {
  standings: [
    { seat: 1, matchWins: 2, matchLosses: 1, gameWins: 5, gameLosses: 3, omwPct: 0.5, ogwPct: 0.45 },
    { seat: 3, matchWins: 1, matchLosses: 1, gameWins: 3, gameLosses: 3, omwPct: 0.6, ogwPct: 0.5 },
    { seat: 2, matchWins: 0, matchLosses: 1, gameWins: 1, gameLosses: 2, omwPct: 0.333, ogwPct: 0.333 },
    ...Array.from({ length: 7 }, (_, i) => ({
      seat: i + 4,
      matchWins: 0,
      matchLosses: 0,
      gameWins: 0,
      gameLosses: 0,
      omwPct: null,
      ogwPct: null,
    })),
  ],
  matches: [
    { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 1 }, // Bob beat Alice 2-1
    { seat1: 1, seat2: 2, seat1Wins: 0, seat2Wins: 2 }, // Carol beat Bob 2-0
    { seat1: 2, seat2: 3, seat1Wins: 1, seat2Wins: 2 }, // Alice beat Carol 2-1
  ],
};

const playingBoard = {
  ...liveBoardFixture,
  phase: "playing",
  matchCount: 3,
};

test.describe("Match matrix and standings", () => {
  test.beforeEach(async ({ page }) => {
    await authenticateAs(page, { draftId: "gamma" });

    await createMockContext(page, "live-draft", {
      liveBoard: playingBoard,
    });

    // Override standings route AFTER createMockContext — unroute the default, then add ours
    await page.unroute("**/api/drafts/*/standings*");
    await page.route("**/api/drafts/*/standings*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(standingsWithMatches),
      }),
    );

    // Mock match POST endpoint
    await page.route("**/api/drafts/*/match*", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.fulfill({ status: 404 });
    });
  });

  test("matrix renders in playing phase", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    const matrix = page.locator('[data-testid="match-matrix"]');
    await expect(matrix).toBeVisible();

    // 10 seats = 10 body rows
    const rows = matrix.locator("tbody tr");
    await expect(rows).toHaveCount(10);
  });

  test("match results display with correct colors", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Bob (seat 1) beat Alice (seat 3) 2-1
    // From Bob's row: cell 1-3 should show "2-1" in green (win)
    const bobVsAlice = page.locator('[data-testid="match-cell-1-3"]');
    await expect(bobVsAlice).toContainText("2-1");
    await expect(bobVsAlice).toHaveClass(/text-emerald-400/);

    // From Alice's row: cell 3-1 should show "1-2" in red (loss)
    const aliceVsBob = page.locator('[data-testid="match-cell-3-1"]');
    await expect(aliceVsBob).toContainText("1-2");
    await expect(aliceVsBob).toHaveClass(/text-red-400/);
  });

  test("own row is highlighted", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Alice is seat 3, so the 3rd row should have the blue highlight
    const matrix = page.locator('[data-testid="match-matrix"]');
    const rows = matrix.locator("tbody tr");
    // Seat 3 = index 2 (0-based)
    const aliceRow = rows.nth(2);
    await expect(aliceRow).toHaveClass(/bg-blue-500\/10/);
  });

  test("unplayed cells in own row show editable affordance", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Alice (seat 3) vs Dave (seat 4) — no match played, should have dashed border
    const cell = page.locator('[data-testid="match-cell-3-4"]');
    const dashedSpan = cell.locator("span");
    await expect(dashedSpan).toHaveClass(/border-dashed/);
  });

  test("inline editing flow", async ({ page }) => {
    let matchBody: unknown = null;
    // Override match route to capture the POST body
    await page.unroute("**/api/drafts/*/match*");
    await page.route("**/api/drafts/*/match*", async (route) => {
      if (route.request().method() === "POST") {
        matchBody = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fulfill({ status: 404 });
      }
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Click an unplayed cell in Alice's row (seat 3 vs seat 4)
    const cell = page.locator('[data-testid="match-cell-3-4"]');
    await cell.click();

    // Input should appear
    const input = page.locator('[data-testid="match-input"]');
    await expect(input).toBeVisible();

    // Type a valid result and submit
    await input.fill("2-1");
    await input.press("Enter");

    // Verify the match POST was made with correct data
    await expect(async () => {
      expect(matchBody).toEqual({
        opponent_seat: 4,
        wins: 2,
        losses: 1,
      });
    }).toPass({ timeout: 3000 });
  });

  test("invalid input rejected", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Click an unplayed cell in Alice's row (seat 3 vs seat 5)
    const cell = page.locator('[data-testid="match-cell-3-5"]');
    await cell.click();

    const input = page.locator('[data-testid="match-input"]');
    await expect(input).toBeVisible();

    // Type an invalid result (1-0 — neither side reached 2 wins)
    await input.fill("1-0");
    await input.press("Enter");

    // Error message should appear
    await expect(page.getByText("one side must be 2")).toBeVisible();
  });

  test("escape cancels editing", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Click an unplayed cell in Alice's row
    const cell = page.locator('[data-testid="match-cell-3-6"]');
    await cell.click();

    const input = page.locator('[data-testid="match-input"]');
    await expect(input).toBeVisible();

    // Type something then press Escape
    await input.fill("2-0");
    await input.press("Escape");

    // Input should disappear
    await expect(input).not.toBeVisible();
  });

  test("OMW% and OGW% columns visible in standings", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Standings table headers should include OMW% and OGW%
    await expect(page.locator("th").filter({ hasText: "OMW%" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "OGW%" })).toBeVisible();

    // Verify actual values render — Bob has omwPct=0.5 → "50.0%"
    await expect(page.getByText("50.0%").first()).toBeVisible();
    // Alice has omwPct=0.6 → "60.0%"
    await expect(page.getByText("60.0%").first()).toBeVisible();
  });
});
