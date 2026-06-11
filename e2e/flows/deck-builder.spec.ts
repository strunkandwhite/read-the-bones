import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { authenticateAs } from "../helpers/auth";
import { openDeckBuilder } from "../helpers/assertions";
import liveQueueFixture from "../fixtures/live-queue.json" with { type: "json" };

test.describe("Deck builder", () => {
  test.beforeEach(async ({ page }) => {
    await authenticateAs(page, { draftId: "gamma" });
    await createMockContext(page, "deck-builder");

    // Mock card stats endpoint
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

  test("opens on active draft with header", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDeckBuilder(page);

    // Header shows draft name (Gamma Draft from draftMetadata)
    await expect(page.getByText("Gamma Draft")).toBeVisible();

    // Header shows seat info — Alice (seat 3's display name)
    await expect(page.getByText("Alice")).toBeVisible();
  });

  test("loads saved state", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDeckBuilder(page);

    // Wait for the deck builder panel to render with cards.
    // Picked cards: Brainstorm, Cryptic Command (seat 3's picks from board)
    // Floated cards: Phyrexian Arena, Growth Spiral (from live-floats fixture)
    // Cards render as <img alt="name"> inside a role="button" wrapper when imageUri
    // is present; getByRole("button") is the correct selector here.
    await expect(page.getByRole("button", { name: "Brainstorm" }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Cryptic Command" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Phyrexian Arena" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Growth Spiral" }).first()).toBeVisible();
  });

  test("move card between zones", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDeckBuilder(page);

    // Wait for deck to load — Brainstorm should appear in the deck builder as a button
    const brainstormBtn = page.getByRole("button", { name: "Brainstorm", exact: true });
    await expect(brainstormBtn).toBeVisible({ timeout: 10000 });

    // Track deck-state PUT to verify the move was persisted
    let deckStatePutFired = false;
    await page.unroute("**/api/drafts/*/deck-state*");
    await page.route("**/api/drafts/*/deck-state*", (route) => {
      if (route.request().method() === "PUT") {
        deckStatePutFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          draftId: "gamma",
          seat: 3,
          zones: {
            deck: { "mv-0-1": [], "mv-2": ["Growth Spiral"], "mv-3": ["Phyrexian Arena"], "mv-4": ["Cryptic Command"], "mv-5": [], "mv-6+": [], lands: [] },
            sideboard: { "mv-0-1": ["Brainstorm"], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
          },
          basicLands: { Plains: 0, Island: 8, Swamp: 0, Mountain: 0, Forest: 0 },
        }),
      });
    });

    // Drag Brainstorm from deck to the sideboard zone using pointer events.
    // dnd-kit uses PointerSensor with activationConstraint distance: 5.
    // The sideboard zone appears first in the DOM (above the deck zone).
    // Locate the first droppable area within the sideboard section.
    const sideboardLabel = page.getByText("Sideboard", { exact: true });
    await expect(sideboardLabel).toBeVisible();

    const brainstormBox = await brainstormBtn.boundingBox();
    const sideboardBox = await sideboardLabel.boundingBox();
    expect(brainstormBox).not.toBeNull();
    expect(sideboardBox).not.toBeNull();

    // Perform the drag with pointer events
    await page.mouse.move(
      brainstormBox!.x + brainstormBox!.width / 2,
      brainstormBox!.y + brainstormBox!.height / 2,
    );
    await page.mouse.down();
    // Move enough pixels to activate dnd-kit's distance constraint
    await page.mouse.move(
      brainstormBox!.x + brainstormBox!.width / 2,
      brainstormBox!.y + brainstormBox!.height / 2 - 10,
      { steps: 3 },
    );
    // Move to the sideboard area
    await page.mouse.move(
      sideboardBox!.x + sideboardBox!.width / 2,
      sideboardBox!.y + sideboardBox!.height + 20,
      { steps: 15 },
    );
    await page.mouse.up();

    // Verify the deck state save was triggered (meaning the move happened)
    await expect(async () => {
      expect(deckStatePutFired).toBe(true);
    }).toPass({ timeout: 8000 });
  });

  test("promote floated card to queued", async ({ page }) => {
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
              { mode: "pause", cards: [{ id: 99, name: "Phyrexian Arena" }] },
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

    await openDeckBuilder(page);

    // Phyrexian Arena is floated — its button accessible name includes sub-button text.
    // Scope the "Add to queue" lookup to the Phyrexian Arena card button.
    const arenaCard = page.getByRole("button", { name: /Phyrexian Arena.*Add to queue/ });
    await expect(arenaCard).toBeVisible({ timeout: 10000 });

    // Hover to reveal action buttons (they use opacity-0 -> group-hover:opacity-100)
    await arenaCard.hover();

    // Click the scoped "Add to queue" button within this card
    const addQueueBtn = arenaCard.getByLabel("Add to queue");
    await expect(addQueueBtn).toBeVisible({ timeout: 3000 });
    await addQueueBtn.click();

    await expect(async () => {
      expect(queuePutFired).toBe(true);
    }).toPass({ timeout: 3000 });
  });

  test("queued card shows as queued in deck builder", async ({ page }) => {
    // Override queue mock so Phyrexian Arena is in the queue
    await page.unroute("**/api/drafts/*/queue*");
    await page.route("**/api/drafts/*/queue*", (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(liveQueueFixture),
        });
      }
      // GET returns queue with Phyrexian Arena added
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          queue: [
            ...liveQueueFixture.queue,
            { mode: "pause", cards: [{ id: 99, name: "Phyrexian Arena" }] },
          ],
        }),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDeckBuilder(page);

    // When Phyrexian Arena is queued (not just floated), it renders as a plain
    // button without action sub-buttons (queue takes priority over float state).
    const arenaCard = page.getByRole("button", { name: "Phyrexian Arena", exact: true });
    await expect(arenaCard).toBeVisible({ timeout: 10000 });

    // The deck zone should show the queued count reflecting all queued cards.
    // Original queue has Doom Blade, Teferi, Kolaghan's, Vindicate, Faithless Looting = 5
    // Plus Phyrexian Arena = 6 queued total
    await expect(page.getByText("6 queued")).toBeVisible({ timeout: 5000 });

    // Growth Spiral is still floated (not in queue), so floated count should be 1
    await expect(page.getByText("1 floated")).toBeVisible();
  });

  test("add basic lands", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDeckBuilder(page);

    // Wait for deck to load (cards render as role="button" wrappers around card images)
    await expect(page.getByRole("button", { name: "Brainstorm" }).first()).toBeVisible({ timeout: 10000 });

    // Click "Add Basic Lands" button
    await page.getByRole("button", { name: "Add Basic Lands" }).click();

    // Dialog should appear
    await expect(page.getByRole("heading", { name: "Add Basic Lands" })).toBeVisible();

    // Click + next to Plains twice
    const plainsRow = page.locator("text=Plains").locator("..");
    const plusBtn = plainsRow.locator("button", { hasText: "+" });
    await plusBtn.click();
    await plusBtn.click();

    // Plains count should show 2
    await expect(plainsRow.locator("text=2")).toBeVisible();

    // Click Save
    await page.getByRole("button", { name: "Save" }).click();

    // Dialog should close
    await expect(page.getByRole("heading", { name: "Add Basic Lands" })).not.toBeVisible();
  });

  test("clear deck", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDeckBuilder(page);

    // Wait for cards to load (cards render as role="button" wrappers around card images)
    await expect(page.getByRole("button", { name: "Brainstorm" }).first()).toBeVisible({ timeout: 10000 });

    // Click "Clear Deck" button
    await page.getByRole("button", { name: "Clear Deck" }).click();

    // After clearing, deck count should show 0
    // The "Deck" zone label should show 0 total
    await expect(page.locator("text=/^Deck$/").locator("..").getByText("0").first()).toBeVisible({ timeout: 5000 });
  });

  test("share deck", async ({ page }) => {
    let deckPostFired = false;

    // Grant clipboard permission
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.unroute("**/api/deck");
    await page.route("**/api/deck", (route) => {
      if (route.request().method() === "POST") {
        deckPostFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ deckId: "test-deck-123" }),
        });
      }
      return route.fulfill({ status: 404 });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDeckBuilder(page);
    // Wait for deck to load (cards render as role="button" wrappers around card images)
    await expect(page.getByRole("button", { name: "Brainstorm" }).first()).toBeVisible({ timeout: 10000 });

    // Click "Share Deck" button
    const shareBtn = page.getByRole("button", { name: "Share Deck" });
    await expect(shareBtn).toBeVisible();
    await shareBtn.click();

    // Verify POST to /api/deck was made
    await expect(async () => {
      expect(deckPostFired).toBe(true);
    }).toPass({ timeout: 3000 });

    // Button should show "Copied!" after successful share
    await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible({ timeout: 3000 });
  });

  test("save persistence", async ({ page }) => {
    let deckStatePutFired = false;
    await page.unroute("**/api/drafts/*/deck-state*");
    await page.route("**/api/drafts/*/deck-state*", (route) => {
      if (route.request().method() === "PUT") {
        deckStatePutFired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          draftId: "gamma",
          seat: 3,
          zones: {
            deck: { "mv-0-1": ["Brainstorm"], "mv-2": ["Growth Spiral"], "mv-3": ["Phyrexian Arena"], "mv-4": ["Cryptic Command"], "mv-5": [], "mv-6+": [], lands: [] },
            sideboard: { "mv-0-1": [], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
          },
          basicLands: { Plains: 0, Island: 8, Swamp: 0, Mountain: 0, Forest: 0 },
        }),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openDeckBuilder(page);
    // Wait for deck to load (cards render as role="button" wrappers around card images)
    await expect(page.getByRole("button", { name: "Brainstorm" }).first()).toBeVisible({ timeout: 10000 });

    // Modify the deck — clear it to trigger a save
    await page.getByRole("button", { name: "Clear Deck" }).click();

    // Verify PUT to deck-state fires
    await expect(async () => {
      expect(deckStatePutFired).toBe(true);
    }).toPass({ timeout: 8000 });
  });
});
