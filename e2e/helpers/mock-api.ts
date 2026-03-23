import { Page } from "@playwright/test";
import cardsFixture from "../fixtures/cards.json" with { type: "json" };
import draftStatsFixture from "../fixtures/draft-stats.json" with { type: "json" };

const defaultSyncStatus = {
  lastSyncedAt: "0",
  syncInProgress: false,
  activeDrafts: [],
};

type MockOverrides = {
  cards?: object;
  draftStats?: object;
  syncStatus?: object;
  syncResponse?: object;
  sharedDeck?: object | null;
};

export async function mockApiRoutes(
  page: Page,
  overrides: MockOverrides = {},
) {
  await page.route("**/api/cards*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.cards ?? cardsFixture),
    });
  });

  await page.route("**/api/draft-stats*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.draftStats ?? draftStatsFixture),
    });
  });

  await page.route("**/api/sync-status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.syncStatus ?? defaultSyncStatus),
    });
  });

  await page.route("**/api/sync", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          overrides.syncResponse ?? { status: "no_change", picksInserted: 0 },
        ),
      });
    } else {
      await route.continue();
    }
  });

  await page.route("**/api/deck/*", async (route) => {
    if (overrides.sharedDeck === null) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"Deck not found"}',
      });
    } else if (overrides.sharedDeck) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.sharedDeck),
      });
    } else {
      await route.fulfill({ status: 404 });
    }
  });

  // POST /api/deck — create shared deck snapshot
  await page.route("**/api/deck", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deckId: "test-deck-123" }),
      });
    } else {
      await route.continue();
    }
  });

  // Block external images to prevent flaky tests
  await page.route("**/cards.scryfall.io/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.alloc(0),
    });
  });

  // Block Vercel Analytics
  await page.route("**/_vercel/insights/**", async (route) => {
    await route.fulfill({ status: 200, body: "" });
  });
}
