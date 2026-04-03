import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { authenticateAs } from "../helpers/auth";
import {
  openSettings,
  openDraftBoard,
  openCardStatsModal,
} from "../helpers/assertions";
import { expectCardVisible } from "../helpers/card-table";
import liveBoardFixture from "../fixtures/live-board.json" with { type: "json" };
import liveQueueFixture from "../fixtures/live-queue.json" with { type: "json" };
import liveFloatsFixture from "../fixtures/live-floats.json" with { type: "json" };

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

test.describe("Live draft", () => {
  test.beforeEach(async ({ page }) => {
    await authenticateAs(page, { draftId: "gamma" });
    await createMockContext(page, "live-draft");

    // Mock card stats endpoint for stats modal tests
    await page.route("**/api/cards/stats*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(cardStatsResponse),
      }),
    );
  });

  test("auth and turn detection", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Pod View button should pulse and show "Your Pick!" since nextSeat=3 and we are seat 3
    const podViewBtn = page.getByLabel("Your Pick!");
    await expect(podViewBtn).toBeVisible();
    await expect(podViewBtn).toHaveClass(/animate-pulse/);

    // Settings should show logged-in state
    await openSettings(page);
    await expect(
      page.getByText(/Logged in to.*Gamma Draft.*as Alice/),
    ).toBeVisible();
  });

  test("draft board opens and closes", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDraftBoard(page);

    // Phase badge shows "drafting"
    await expect(page.getByText("drafting")).toBeVisible();

    // Seat names visible
    await expect(page.getByText("Alice").first()).toBeVisible();
    await expect(page.getByText("Bob").first()).toBeVisible();

    // Pick matrix shows existing picks
    await expect(page.getByText("Sol Ring").first()).toBeVisible();
    await expect(page.getByText("Brainstorm").first()).toBeVisible();

    // Close button works
    await page.getByLabel("Close draft board").click();
    await expect(page.getByText("drafting")).not.toBeVisible();
  });

  test("pick via autocomplete", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Capture pick requests
    let pickBody: unknown = null;
    await page.route("**/api/drafts/*/pick*", async (route) => {
      if (route.request().method() === "POST") {
        pickBody = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fulfill({ status: 200, body: "{}" });
      }
    });

    await openDraftBoard(page);

    // Find the active cell (dashed border, seat 3's editable cell) and click it
    // The active cell for seat 3 at pick 23 should be empty and clickable
    const editableCell = page.locator('td[style*="dashed"]');
    await editableCell.click();

    // Autocomplete input should appear
    const combobox = page.locator('input[role="combobox"]');
    await expect(combobox).toBeVisible();

    // Type a card name and select from dropdown
    await combobox.fill("Sylvan");
    const option = page.locator('[role="option"]').filter({ hasText: "Sylvan Library" });
    await expect(option).toBeVisible();
    await option.click();

    // Verify the pick POST was made
    await expect(async () => {
      expect(pickBody).toEqual({ card_name: "Sylvan Library" });
    }).toPass({ timeout: 3000 });
  });

  test("pick via card stats modal hold-to-confirm", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Capture pick requests
    let pickFired = false;
    await page.route("**/api/drafts/*/pick*", async (route) => {
      if (route.request().method() === "POST") {
        pickFired = true;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // Click a card to open stats modal — use an unpicked, untaken card
    await expectCardVisible(page, "Sylvan Library");
    await openCardStatsModal(page, "Sylvan Library");

    // Hold-to-pick button should be visible (it's our turn)
    const holdBtn = page.getByLabel("Hold to pick this card");
    await expect(holdBtn).toBeVisible();

    // Hold for 1500ms+ to trigger pick
    const box = await holdBtn.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1700);
    await page.mouse.up();

    // Verify pick POST fired
    await expect(async () => {
      expect(pickFired).toBe(true);
    }).toPass({ timeout: 3000 });
  });

  test("board updates on poll", async ({ page }) => {
    let callCount = 0;
    const updatedBoard = {
      ...liveBoardFixture,
      latestPickN: 23,
      nextSeat: 4,
      picks: [
        ...liveBoardFixture.picks,
        {
          pickN: 23,
          seat: 3,
          cardName: "Sylvan Library",
          oracleId: "sylvan-library-id",
          colorIdentity: ["G"],
          manaCost: "{1}{G}",
        },
      ],
      recentPicks: [
        {
          pickN: 23,
          seat: 3,
          cardName: "Sylvan Library",
          oracleId: "sylvan-library-id",
          colorIdentity: ["G"],
          manaCost: "{1}{G}",
        },
        ...liveBoardFixture.recentPicks,
      ],
    };

    // Override live route to return updated board on 2nd+ call
    await page.unroute("**/api/drafts/*/live*");
    await page.route("**/api/drafts/*/live*", (route) => {
      callCount++;
      const body = callCount >= 2 ? updatedBoard : liveBoardFixture;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDraftBoard(page);

    // Wait for the new pick to appear in the board (poll cycle ~10s)
    await expect(page.getByText("Sylvan Library")).toBeVisible({
      timeout: 15000,
    });
  });

  test("queue from stats modal", async ({ page }) => {
    let queuePutFired = false;
    await page.unroute("**/api/drafts/*/queue*");
    await page.route("**/api/drafts/*/queue*", (route) => {
      if (route.request().method() === "PUT") {
        queuePutFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            queue: [
              ...liveQueueFixture.queue,
              {
                mode: "pause",
                cards: [{ id: 99, name: "Misty Rainforest" }],
              },
            ],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(liveQueueFixture),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Open stats modal for an unpicked, unqueued card
    await expectCardVisible(page, "Misty Rainforest");
    await openCardStatsModal(page, "Misty Rainforest");

    // Click the Queue button (exact match to avoid "Unqueue")
    const queueBtn = page.getByRole("button", { name: /^Queue$/i });
    await expect(queueBtn).toBeVisible();
    await queueBtn.click();

    await expect(async () => {
      expect(queuePutFired).toBe(true);
    }).toPass({ timeout: 3000 });
  });

  test("unqueue from stats modal", async ({ page }) => {
    let queuePutFired = false;
    await page.unroute("**/api/drafts/*/queue*");
    await page.route("**/api/drafts/*/queue*", (route) => {
      if (route.request().method() === "PUT") {
        queuePutFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ queue: [] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(liveQueueFixture),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Doom Blade is in the queue fixture — open its stats modal
    await expectCardVisible(page, "Doom Blade");
    await openCardStatsModal(page, "Doom Blade");

    // Unqueue button should be visible
    const unqueueBtn = page.getByRole("button", { name: /Unqueue/ });
    await expect(unqueueBtn).toBeVisible();
    await unqueueBtn.click();

    await expect(async () => {
      expect(queuePutFired).toBe(true);
    }).toPass({ timeout: 3000 });
  });

  test("float from stats modal", async ({ page }) => {
    let floatPutFired = false;
    await page.unroute("**/api/drafts/*/float*");
    await page.route("**/api/drafts/*/float*", (route) => {
      if (route.request().method() === "PUT") {
        floatPutFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      // GET returns current floats (without this card so it shows Float button)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(liveFloatsFixture),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Open stats modal for a card that is NOT floated (Sylvan Library is not taken, queued, or floated)
    await expectCardVisible(page, "Sylvan Library");
    await openCardStatsModal(page, "Sylvan Library");

    // Click "Float" button (exact match to avoid "Unfloat")
    const floatBtn = page.getByRole("button", { name: /^Float$/i });
    await expect(floatBtn).toBeVisible();
    await floatBtn.click();

    await expect(async () => {
      expect(floatPutFired).toBe(true);
    }).toPass({ timeout: 3000 });
  });

  test("unfloat from stats modal", async ({ page }) => {
    let floatDeleteFired = false;
    await page.unroute("**/api/drafts/*/float*");
    await page.route("**/api/drafts/*/float*", (route) => {
      if (route.request().method() === "DELETE") {
        floatDeleteFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(liveFloatsFixture),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Phyrexian Arena is in the floats fixture — should show "Unfloat"
    await expectCardVisible(page, "Phyrexian Arena");
    await openCardStatsModal(page, "Phyrexian Arena");

    const unfloatBtn = page.getByRole("button", { name: /Unfloat/ });
    await expect(unfloatBtn).toBeVisible();
    await unfloatBtn.click();

    await expect(async () => {
      expect(floatDeleteFired).toBe(true);
    }).toPass({ timeout: 3000 });
  });

  test("multi-copy queue: full availability", async ({ page }) => {
    // Lightning Bolt has maxCopiesInDraft=2, neither publicly taken
    // (it's picked by seat 10 but only 1 copy — 1 remaining)
    // Actually Lightning Bolt IS taken by seat 10 in the board. So 1 copy remains.
    // Use a queue mock that tracks state to allow queuing the remaining copy.

    let queueState = [...liveQueueFixture.queue];
    let queuePutCount = 0;

    await page.unroute("**/api/drafts/*/queue*");
    await page.route("**/api/drafts/*/queue*", (route) => {
      if (route.request().method() === "PUT") {
        queuePutCount++;
        // Add Lightning Bolt to the queue on each PUT
        queueState = [
          ...queueState,
          {
            mode: "pause" as const,
            cards: [{ id: 100 + queuePutCount, name: "Lightning Bolt" }],
          },
        ];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ queue: queueState }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ queue: queueState }),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Open stats modal for Lightning Bolt (multi-copy, maxCopiesInDraft=2, 1 taken by seat 10)
    await expectCardVisible(page, "Lightning Bolt");
    await openCardStatsModal(page, "Lightning Bolt");

    // Queue button should be available for the remaining copy
    const queueBtn = page.getByRole("button", { name: /^Queue$/i });
    await expect(queueBtn).toBeVisible();
    await queueBtn.click();

    // After queuing 1 copy (of 1 remaining), Queue button should disappear
    // The card has 2 total copies, 1 taken publicly, 1 remaining. After queuing 1, 0 remain.
    await expect(async () => {
      expect(queuePutCount).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 3000 });

    // Re-open modal to check state after queue update
    await page.keyboard.press("Escape");
    await openCardStatsModal(page, "Lightning Bolt");

    // After queuing 1 of 1 remaining copies, should show Unqueue but no Queue
    await expect(page.getByRole("button", { name: /Unqueue/ })).toBeVisible({
      timeout: 5000,
    });
  });

  test("multi-copy queue: one publicly taken", async ({ page }) => {
    // Scalding Tarn has maxCopiesInDraft=2, 1 picked by seat 5 in board
    // So 1 copy remains available

    let queuePutFired = false;
    await page.unroute("**/api/drafts/*/queue*");
    await page.route("**/api/drafts/*/queue*", (route) => {
      if (route.request().method() === "PUT") {
        queuePutFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            queue: [
              ...liveQueueFixture.queue,
              {
                mode: "pause",
                cards: [{ id: 200, name: "Scalding Tarn" }],
              },
            ],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(liveQueueFixture),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await expectCardVisible(page, "Scalding Tarn");
    await openCardStatsModal(page, "Scalding Tarn");

    // Should show Queue button (1 copy remaining)
    const queueBtn = page.getByRole("button", { name: /^Queue$/i });
    await expect(queueBtn).toBeVisible();
    await queueBtn.click();

    await expect(async () => {
      expect(queuePutFired).toBe(true);
    }).toPass({ timeout: 3000 });
  });

  test("phase transition hides queue panel", async ({ page }) => {
    const playingBoard = {
      ...liveBoardFixture,
      phase: "playing",
    };

    await page.unroute("**/api/drafts/*/live*");
    await page.route("**/api/drafts/*/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(playingBoard),
      }),
    );

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDraftBoard(page);

    // Phase badge should show "playing"
    await expect(page.getByText("playing")).toBeVisible();

    // Queue panel should not be visible
    await expect(page.getByText("Pick Queue")).not.toBeVisible();
  });
});
