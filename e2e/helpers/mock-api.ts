import { Page, Route, Request } from "@playwright/test";
import cardsFixture from "../fixtures/cards-40.json" with { type: "json" };
import draftStatsFixture from "../fixtures/draft-stats.json" with { type: "json" };
import syncStatusFixture from "../fixtures/sync-status-active.json" with { type: "json" };
import liveBoardFixture from "../fixtures/live-board.json" with { type: "json" };
import liveMeFixture from "../fixtures/live-me.json" with { type: "json" };
import liveQueueFixture from "../fixtures/live-queue.json" with { type: "json" };
import liveFloatsFixture from "../fixtures/live-floats.json" with { type: "json" };
import liveAvailableFixture from "../fixtures/live-available.json" with { type: "json" };
import deckStateFixture from "../fixtures/deck-state.json" with { type: "json" };
import sharedDeckFixture from "../fixtures/shared-deck.json" with { type: "json" };

export type Scenario =
  | "browse"
  | "live-draft"
  | "deck-builder"
  | "spectator"
  | "shared-deck";

export type MockOverrides = {
  cards?: (route: Route, request: Request) => Promise<void> | void;
  draftStats?: object;
  syncStatus?: object;
  liveBoard?: object;
  liveMe?: object;
  liveQueue?: object;
  liveFloats?: object;
  liveAvailable?: object;
  deckState?: object;
  sharedDeck?: object;
  pickResponse?: object;
  queuePutResponse?: object;
  floatPutResponse?: object;
  floatDeleteResponse?: object;
  deckStatePutResponse?: object;
  deckPostResponse?: object;
};

export async function createMockContext(
  page: Page,
  scenario: Scenario,
  overrides: MockOverrides = {},
) {
  // Block external images and analytics
  await page.route("**/cards.scryfall.io/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.alloc(0),
    }),
  );
  await page.route("**/_vercel/insights/**", (route) =>
    route.fulfill({ status: 200, body: "" }),
  );

  // Build takenCards from board picks for scenarios with a live board
  const hasLiveBoard = ["live-draft", "deck-builder", "spectator"].includes(
    scenario,
  );
  const boardData = (overrides.liveBoard ?? liveBoardFixture) as {
    picks: { cardName: string; seat: number }[];
  };
  const cardsWithTaken = hasLiveBoard
    ? {
        ...cardsFixture,
        takenCards: boardData.picks.map((p) => ({
          name: p.cardName,
          seat: p.seat,
        })),
      }
    : null;

  // Base routes (all scenarios)
  if (overrides.cards) {
    await page.route("**/api/cards*", (route) =>
      overrides.cards!(route, route.request()),
    );
  } else {
    await page.route("**/api/cards*", (route) => {
      const url = new URL(route.request().url());
      const body =
        cardsWithTaken && url.searchParams.has("activeDraft")
          ? cardsWithTaken
          : cardsFixture;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
  }

  await page.route("**/api/draft-stats*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.draftStats ?? draftStatsFixture),
    }),
  );

  await page.route("**/api/sync-status*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.syncStatus ?? syncStatusFixture),
    }),
  );

  await page.route("**/api/sync", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "no_change", picksInserted: 0 }),
    }),
  );

  // Live draft routes
  if (["live-draft", "deck-builder", "spectator"].includes(scenario)) {
    await page.route("**/api/drafts/*/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveBoard ?? liveBoardFixture),
      }),
    );
  }

  // Auth routes (only for authenticated scenarios)
  if (["live-draft", "deck-builder"].includes(scenario)) {
    await page.route("**/api/drafts/*/me*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveMe ?? liveMeFixture),
      }),
    );

    await page.route("**/api/drafts/*/queue*", (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overrides.queuePutResponse ?? { queue: [] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveQueue ?? liveQueueFixture),
      });
    });

    await page.route("**/api/drafts/*/float*", (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overrides.floatPutResponse ?? { ok: true }),
        });
      }
      if (route.request().method() === "DELETE") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overrides.floatDeleteResponse ?? { ok: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveFloats ?? liveFloatsFixture),
      });
    });

    await page.route("**/api/drafts/*/pick*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.pickResponse ?? { ok: true }),
      }),
    );

    await page.route("**/api/drafts/*/available*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveAvailable ?? liveAvailableFixture),
      }),
    );

    await page.route("**/api/drafts/*/seat-settings*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      }),
    );
  }

  // Deck state routes
  if (scenario === "deck-builder") {
    await page.route("**/api/drafts/*/deck-state*", (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overrides.deckStatePutResponse ?? { ok: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.deckState ?? deckStateFixture),
      });
    });
  }

  // Shared deck routes
  await page.route("**/api/deck/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.sharedDeck ?? sharedDeckFixture),
    }),
  );

  await page.route("**/api/deck", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          overrides.deckPostResponse ?? { deckId: "test-deck-123" },
        ),
      });
    }
    return route.fulfill({ status: 404 });
  });

  // Standings route
  await page.route("**/api/drafts/*/standings*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ standings: [] }),
    }),
  );
}