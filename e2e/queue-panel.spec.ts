import { test, expect, type Page } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api";
import syncStatusActive from "./fixtures/sync-status-active.json" with { type: "json" };

// ─── Mock data for live draft with queue ──────────────────────────────────────

const DRAFT_ID = "test-draft-queue";
const SEAT_TOKEN = "test-seat-token-abc";

const liveDraftResponse = {
  phase: "drafting",
  numSeats: 4,
  picksPerPlayer: 45,
  latestPickN: 3,
  nextSeat: 4,
  recentPicks: [],
  seatNames: { "1": "Alice", "2": "Bob", "3": "Carol", "4": "Dave" },
  matchCount: 0,
  totalMatches: 6,
  picks: [
    { pickN: 1, seat: 1, cardName: "Lightning Bolt" },
    { pickN: 2, seat: 2, cardName: "Counterspell" },
    { pickN: 3, seat: 3, cardName: "Dark Ritual" },
  ],
  bannedCards: [],
};

const queueData = {
  queue: [
    { mode: "pause", cards: [{ id: 10, name: "Swords to Plowshares" }] },
    {
      mode: "flow-through",
      cards: [
        { id: 20, name: "Mana Drain" },
        { id: 30, name: "Force of Will" },
        { id: 40, name: "Arcane Denial" },
      ],
    },
    { mode: "pause", cards: [{ id: 50, name: "Demonic Tutor" }] },
  ],
};

async function setupLiveDraftMocks(page: Page) {
  // Set seat token before navigation
  await page.addInitScript(
    (args) => {
      localStorage.setItem(`seatToken:${args.draftId}`, args.token);
      localStorage.setItem("activeDraft", args.draftId);
      localStorage.setItem("selectedSeat", "1");
    },
    { draftId: DRAFT_ID, token: SEAT_TOKEN },
  );

  await mockApiRoutes(page, {
    syncStatus: {
      ...syncStatusActive,
      activeDrafts: [
        {
          draftId: DRAFT_ID,
          draftName: "Queue Test Draft",
          phase: "drafting",
        },
      ],
    },
  });

  // Mock live draft endpoint
  await page.route(`**/api/drafts/${DRAFT_ID}/live*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(liveDraftResponse),
    });
  });

  // Mock /me endpoint
  await page.route(`**/api/drafts/${DRAFT_ID}/me*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        seat: 1,
        autoPick: true,
        displayName: "Alice",
      }),
    });
  });

  // Mock queue endpoint
  await page.route(`**/api/drafts/${DRAFT_ID}/queue*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(queueData),
    });
  });

  // Mock float endpoint
  await page.route(`**/api/drafts/${DRAFT_ID}/float*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cards: [] }),
    });
  });

  // Mock seat-settings endpoint
  await page.route(
    `**/api/drafts/${DRAFT_ID}/seat-settings*`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          seat: 1,
          autoPick: true,
          displayName: "Alice",
        }),
      });
    },
  );

  // Mock deck-state endpoint
  await page.route(
    `**/api/drafts/${DRAFT_ID}/deck-state*`,
    async (route) => {
      await route.fulfill({ status: 404 });
    },
  );
}

test("queue panel renders entries and groups in draft board", async ({
  page,
}) => {
  await setupLiveDraftMocks(page);
  await page.goto("/");

  // Open the draft board via the Pod View button
  const podViewButton = page.getByRole("button", { name: /Pod View/i });
  await expect(podViewButton).toBeVisible({ timeout: 10000 });
  await podViewButton.click();

  // Queue panel should appear with the "Pick Queue" header
  const queuePanel = page.locator("text=Pick Queue").locator("..");
  await expect(page.getByText("Pick Queue")).toBeVisible({ timeout: 10000 });

  // Scope assertions to the queue's ordered list
  const queueList = queuePanel.locator("ol");

  // Verify single-card entries
  await expect(queueList.getByText("Swords to Plowshares")).toBeVisible();
  await expect(queueList.getByText("Demonic Tutor")).toBeVisible();

  // Verify grouped entry — shows "Group (3)" header and all cards
  await expect(queuePanel.getByText("Group (3)")).toBeVisible();
  await expect(queueList.getByText("Mana Drain")).toBeVisible();
  await expect(queueList.getByText("Force of Will")).toBeVisible();
  await expect(queueList.getByText("Arcane Denial")).toBeVisible();

  // Auto-pick checkbox should be visible and checked
  const checkbox = queuePanel.getByRole("checkbox");
  await expect(checkbox).toBeChecked();
});

test("mode toggle buttons appear on each entry", async ({ page }) => {
  await setupLiveDraftMocks(page);
  await page.goto("/");

  const podViewButton = page.getByRole("button", { name: /Pod View/i });
  await expect(podViewButton).toBeVisible({ timeout: 10000 });
  await podViewButton.click();

  await expect(page.getByText("Pick Queue")).toBeVisible({ timeout: 10000 });

  // Should have mode toggle buttons (⏸ for pause, ⏩ for flow-through)
  const modeButtons = page.getByRole("button", { name: /Mode:/ });
  const count = await modeButtons.count();
  // 3 entries (single, group, single) = 3 mode toggles
  expect(count).toBe(3);
});
