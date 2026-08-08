import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { authenticateAs } from "../helpers/auth";
import { openCardStatsModal } from "../helpers/assertions";
import { scrollCardTable, getVisibleCardNames } from "../helpers/card-table";

// Minimal card stats response for the stats modal
const cardStatsResponse = {
  pick: {
    drafts_in_pool: 3,
    times_picked: 2,
    avg_pick: 10,
    median_pick: 9,
    geomean_pick: 8.5,
  },
  pick_history: [
    {
      draftId: "alpha",
      draftName: "Alpha Draft",
      draftDate: "2026-01-01",
      pickPosition: 8,
      picked: true,
      numSeats: 10,
    },
  ],
  pick_distribution: [0, 1, 0, 1, 0],
  times_banned: 0,
  color_pair_breakdown: [],
};

// The reported failures were on a 375x667 iPhone SE. Headless Chrome has no
// browser chrome, so vh and dvh are identical here and this suite cannot see
// the clipping bug — it covers the priority flow's reachability only.
test.describe("Mobile priority flow", () => {
  test.beforeEach(async ({ page }) => {
    await authenticateAs(page, { draftId: "gamma" });
    await createMockContext(page, "live-draft");
    await page.route("**/api/cards/stats*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(cardStatsResponse),
      }),
    );
  });

  test("card table renders and scrolls", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    const before = await getVisibleCardNames(page);
    expect(before.length).toBeGreaterThan(0);

    await scrollCardTable(page, 400);

    const after = await getVisibleCardNames(page);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });

  test("the card modal fits the viewport and its close button is reachable", async ({ page }) => {
    await page.goto("/");
    await openCardStatsModal(page, "Sylvan Library");

    const close = page.getByLabel("Close");
    await expect(close).toBeVisible();

    const box = await close.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  });

  test("the hold-to-pick button is reachable and tappable", async ({ page }) => {
    await page.goto("/");
    await openCardStatsModal(page, "Sylvan Library");

    const pick = page.getByLabel("Hold to pick this card");
    await expect(pick).toBeVisible();

    // Actionability includes a hit-target test: fails if
    // anything overlays the button at its tap point.
    await pick.click({ trial: true });
  });
});
