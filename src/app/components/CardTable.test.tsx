// @vitest-environment jsdom
/**
 * Tests that CardTable's card-status subscriptions update reactively from
 * queue/float store changes without requiring a parent re-render.
 *
 * The full CardTable uses @tanstack/react-virtual which doesn't render rows in
 * jsdom (no layout engine). These tests instead render a minimal component that
 * calls useCardStatuses — the same hook CardTable uses — so we verify the hook's
 * reactive contract without fighting the virtualizer in tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useCardStatuses } from "@/app/stores/selectors";
import { useCardStore, EMPTY_CARD_DATA } from "@/app/stores/cardStore";
import { useDraftStore } from "@/app/stores/draftStore";
import { useLiveStore } from "@/app/stores/liveStore";
import { createEmptyDeckState } from "@/core/deckBuilder";

vi.mock("@/core/isLocal", () => ({
  isLocalClient: () => false,
}));

vi.mock("@vercel/analytics/react", () => ({
  track: vi.fn(),
}));

// Thin component that renders status for a single card via the hook CardTable uses.
// Renders a <span title={status}> so tests can assert the status without the virtualizer.
function StatusProbe({ cardName }: { cardName: string }) {
  const statusMap = useCardStatuses([cardName]);
  const status = statusMap.get(cardName)?.status ?? "none";
  const queuePosition = statusMap.get(cardName)?.queuePosition;
  const title =
    status === "queued" ? `Queue position ${queuePosition}` : status;
  return <span data-testid="status" title={title} />;
}

beforeEach(() => {
  useDraftStore.setState({
    selectedDrafts: new Set(),
    activeDraft: null,
    selectedSeat: 1,
    hideTaken: false,
    completedDraftIds: [],
    hydrated: true,
    dataVersion: 0,
    liveDraftStatus: null,
    board: null,
    poolAsOfDraft: null,
    syncStatus: { lastSyncedAt: "0", syncInProgress: false, activeDrafts: [] },
  });
  useCardStore.setState({
    cardData: { ...EMPTY_CARD_DATA, cubeCopies: { "Lightning Bolt": 1 } },
    colorFilter: [],
    colorFilterMode: "inclusive",
    scryfallDataMap: new Map(),
    takenCardNamesSet: undefined,
    takenCardCounts: undefined,
    seatCardNames: undefined,
    seatCardList: undefined,
    bannedCardNamesSet: undefined,
    selectedCard: null,
    cardStatsDetail: null,
    cardStatsLoading: false,
    cardStatsMap: new Map(),
    isLoading: false,
    searchQuery: "",
    scryfallMatchNames: null,
    displayCards: [],
    searchFilteredCards: [],
    availableCount: 0,
    drafts: [],
  });
  useLiveStore.setState({
    seatToken: "test-token",
    mySeat: 1,
    autoPick: false,
    displayName: null,
    queue: [],
    queuedCardCounts: new Map(),
    queueLoading: false,
    queueError: null,
    floatedCards: [],
    floatedCardsSet: new Set<string>(),
    pickError: null,
    isMyTurn: false,
    deckState: createEmptyDeckState("", 0),
    deckReady: false,
    deckSaveStatus: "idle",
    deckBuilderActive: false,
    viewingSharedDeck: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function getStatus(): string | null {
  const el = document.querySelector("[data-testid='status']");
  return el ? el.getAttribute("title") : null;
}

describe("useCardStatuses reactive subscriptions (used by CardTable)", () => {
  it("returns none when card has no status", () => {
    render(<StatusProbe cardName="Lightning Bolt" />);
    expect(getStatus()).toBe("none");
  });

  it("updates to queued when queue store changes — without a parent re-render", async () => {
    // Render the probe in isolation (no parent wrapper drives re-renders)
    render(<StatusProbe cardName="Lightning Bolt" />);
    expect(getStatus()).toBe("none");

    // Directly mutate the live store (simulates server confirming the queue).
    // The StatusProbe must re-render from its own useCardStatuses subscription.
    await act(async () => {
      useLiveStore.setState({
        queuedCardCounts: new Map([["Lightning Bolt", 1]]),
        queue: [
          {
            mode: "pause",
            cards: [{ cardId: 1, cardName: "Lightning Bolt" }],
          },
        ],
      });
    });

    expect(getStatus()).toBe("Queue position 1");
  });

  it("updates to floated when float store changes — without a parent re-render", async () => {
    render(<StatusProbe cardName="Lightning Bolt" />);
    expect(getStatus()).toBe("none");

    await act(async () => {
      useLiveStore.setState({
        floatedCards: ["Lightning Bolt"],
        floatedCardsSet: new Set(["Lightning Bolt"]),
      });
    });

    expect(getStatus()).toBe("floated");
  });

  it("updates to picked when seatCardNames changes — without a parent re-render", async () => {
    render(<StatusProbe cardName="Lightning Bolt" />);
    expect(getStatus()).toBe("none");

    await act(async () => {
      useCardStore.setState({
        seatCardNames: new Set(["Lightning Bolt"]),
      });
    });

    expect(getStatus()).toBe("picked");
  });

  it("clears queued status when card is removed from queue", async () => {
    render(<StatusProbe cardName="Lightning Bolt" />);

    await act(async () => {
      useLiveStore.setState({
        queuedCardCounts: new Map([["Lightning Bolt", 1]]),
        queue: [{ mode: "pause", cards: [{ cardId: 1, cardName: "Lightning Bolt" }] }],
      });
    });

    expect(getStatus()).toBe("Queue position 1");

    await act(async () => {
      useLiveStore.setState({
        queuedCardCounts: new Map(),
        queue: [],
      });
    });

    expect(getStatus()).toBe("none");
  });

  it("does not show queued status when user is not authed (mySeat !== selectedSeat)", async () => {
    useDraftStore.setState({ selectedSeat: 1 });
    useLiveStore.setState({ mySeat: 2 });

    render(<StatusProbe cardName="Lightning Bolt" />);

    await act(async () => {
      useLiveStore.setState({
        queuedCardCounts: new Map([["Lightning Bolt", 1]]),
        queue: [{ mode: "pause", cards: [{ cardId: 1, cardName: "Lightning Bolt" }] }],
      });
    });

    // mySeat(2) !== selectedSeat(1) → not authed → no queued status
    expect(getStatus()).not.toBe("Queue position 1");
  });
});
