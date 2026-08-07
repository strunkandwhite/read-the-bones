// @vitest-environment jsdom
/**
 * CardTable tests, in two groups:
 *
 * 1. Card-status subscriptions: a minimal probe component around
 *    useCardStatuses verifies the reactive contract without the table.
 * 2. The dev-only desire column: the FULL CardTable rendered through a
 *    virtualizer stub (the real @tanstack/react-virtual renders zero rows in
 *    jsdom's layout-less DOM), exercising the real TanStack table — column
 *    gating, pick-1 fallback, and the tableData clone memo that busts
 *    TanStack's per-row accessor value caches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useCardStatuses } from "@/app/stores/selectors";
import { useCardStore, EMPTY_CARD_DATA } from "@/app/stores/cardStore";
import { useDraftStore } from "@/app/stores/draftStore";
import { useLiveStore } from "@/app/stores/liveStore";
import { createEmptyDeckState } from "@/core/deckBuilder";
import { CardTable } from "./CardTable";
import { desireAt, desireIndex, formatDesireIndex } from "./desireCurve";
import type { WorthCard } from "@/core/worthModel";
import type { EnrichedCardStats } from "@/core/types";

const isLocalClientMock = vi.fn<() => boolean>(() => false);
vi.mock("@/core/isLocal", () => ({
  isLocalClient: () => isLocalClientMock(),
}));

vi.mock("@vercel/analytics/react", () => ({
  track: vi.fn(),
}));

// The real virtualizer renders zero rows in jsdom (no layout engine). This
// stub renders every row so the full CardTable — real TanStack table, real
// columns, real accessor caching — can be exercised.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 48,
        end: (index + 1) * 48,
        size: 48,
      })),
    getTotalSize: () => count * 48,
    measureElement: () => {},
  }),
}));

// jsdom has no ResizeObserver; CardTable's breakpoint observer needs a stub.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

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

// ---------------------------------------------------------------------------
// Desire column (dev-only) — rendered through the real table via the
// virtualizer stub above.
// ---------------------------------------------------------------------------

const SIGMA = 0.5;

function worthCardFixture(name: string, worth: number, geomean: number): WorthCard {
  return {
    card_name: name,
    colors: "R",
    is_land: false,
    in_current_cube: true,
    geomean,
    games: 200,
    wins: 100,
    losses: 100,
    wr: 0.5,
    se: 0.03,
    delta: worth,
    expected: 0,
    pvi: 1,
    worth,
    prior_only: false,
    no_data: false,
    act_by: null,
  };
}

function tableCardFixture(name: string, geomean: number): EnrichedCardStats {
  return {
    cardName: name,
    colors: ["R"],
    weightedGeomean: geomean,
    timesAvailable: 2,
  } as unknown as EnrichedCardStats;
}

// Early Bird: taken almost immediately (geo 5). Late Bloomer: geo 300, desire
// dashes at pick 1 and wakes up under a mid-draft override.
const WORTH_SCALE = 0.05; // max |worth| across the two fixtures
const earlyBird = { worth: 0.04, geomean: 5, sigma: SIGMA };
const lateBloomer = { worth: 0.05, geomean: 300, sigma: SIGMA };

function expectedIndex(pick: number, inputs: typeof earlyBird): string {
  return formatDesireIndex(desireIndex(desireAt(pick, inputs), WORTH_SCALE)!);
}

function rowText(cardName: string): string {
  const row = [...document.querySelectorAll("tbody tr")].find((tr) =>
    tr.textContent?.includes(cardName),
  );
  return row?.textContent ?? "";
}

describe("CardTable desire column (dev-only)", () => {
  beforeEach(() => {
    isLocalClientMock.mockReturnValue(true);
    useCardStore.setState({
      worthCards: new Map([
        ["Early Bird", worthCardFixture("Early Bird", earlyBird.worth, earlyBird.geomean)],
        ["Late Bloomer", worthCardFixture("Late Bloomer", lateBloomer.worth, lateBloomer.geomean)],
      ]),
      worthModel: {
        a: 0,
        b: 0,
        tau: 0.03,
        tau0: 0.035,
        sigma: SIGMA,
        tau_a: 0.01,
        kappa: 0.5,
        baselines: {},
        pair_edges: {},
      },
      desirePickOverride: null,
    });
  });

  const cards = [
    tableCardFixture("Early Bird", 5),
    tableCardFixture("Late Bloomer", 300),
  ];

  it("renders desire at pick 1 when no draft is active", () => {
    render(<CardTable cards={cards} />);

    expect(screen.getByText(/Desire \(1\)/)).toBeTruthy();
    expect(rowText("Early Bird")).toContain(expectedIndex(1, earlyBird));
    // Late-geo card at pick 1: danger is remote, index rounds to 0 → dash.
    expect(rowText("Late Bloomer")).toContain("—");
  });

  it("hides the worth-model columns off localhost", () => {
    isLocalClientMock.mockReturnValue(false);
    render(<CardTable cards={cards} />);

    expect(screen.queryByText(/Desire/)).toBeNull();
    expect(screen.queryByText("Worth")).toBeNull();
    expect(screen.queryByText("PVI")).toBeNull();
  });

  it("live-recalculates desire when the pick override changes (row cache-bust regression)", async () => {
    // Regression for the tableData clone memo: TanStack caches each row's
    // accessor values keyed by data identity only, so without the clone the
    // header would update while the cells served stale pre-override values.
    render(<CardTable cards={cards} />);
    expect(rowText("Late Bloomer")).toContain("—");

    await act(async () => {
      useCardStore.setState({ desirePickOverride: 250 });
    });

    expect(screen.getByText(/Desire \(250\)/)).toBeTruthy();
    expect(rowText("Late Bloomer")).toContain(expectedIndex(250, lateBloomer));
    expect(rowText("Early Bird")).toContain(expectedIndex(250, earlyBird));

    await act(async () => {
      useCardStore.setState({ desirePickOverride: null });
    });

    expect(screen.getByText(/Desire \(1\)/)).toBeTruthy();
    expect(rowText("Late Bloomer")).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// Cost column — prepared cards show the front face only.
// ---------------------------------------------------------------------------

function multiFaceCardFixture(
  name: string,
  manaCost: string,
  oracleText: string,
): EnrichedCardStats {
  return {
    cardName: name,
    colors: ["B"],
    weightedGeomean: 100,
    timesAvailable: 2,
    scryfall: {
      manaCost,
      oracleText,
      manaValue: 2,
      typeLine: "Creature",
      colorIdentity: ["B"],
    },
  } as unknown as EnrichedCardStats;
}

// ColorPills and the card-name cell also render <img> elements, so the symbols
// are read from the Cost cell specifically — which doubles as a check that the
// Cost column is visible at the rendered breakpoint.
function costSymbols(cardName: string): string[] {
  const headers = [...document.querySelectorAll("thead th")];
  const costIndex = headers.findIndex((th) => th.textContent?.includes("Cost"));
  expect(costIndex).toBeGreaterThanOrEqual(0);

  const row = [...document.querySelectorAll("tbody tr")].find((tr) =>
    tr.textContent?.includes(cardName),
  );
  const cell = row?.querySelectorAll("td")[costIndex];
  return [...(cell?.querySelectorAll("img") ?? [])].map(
    (img) => img.getAttribute("alt") ?? "",
  );
}

describe("CardTable cost column", () => {
  beforeEach(() => {
    isLocalClientMock.mockReturnValue(false);
  });

  const cards = [
    multiFaceCardFixture(
      "Scheming Silvertongue",
      "{1}{B} // {B}{B}",
      "When this creature enters, it becomes prepared. (While it's prepared, you may cast a copy of the other half.)",
    ),
    multiFaceCardFixture(
      "Bonecrusher Giant",
      "{2}{R} // {1}{R}",
      "Whenever this creature becomes the target of a spell, Bonecrusher Giant deals 2 damage to that spell's controller.",
    ),
  ];

  it("shows only the front face of a prepared card's cost", () => {
    render(<CardTable cards={cards} />);

    expect(costSymbols("Scheming Silvertongue")).toEqual(["{1}", "{B}"]);
  });

  it("keeps both halves of an Adventure's cost", () => {
    render(<CardTable cards={cards} />);

    expect(costSymbols("Bonecrusher Giant")).toEqual(["{2}", "{R}", "{1}", "{R}"]);
  });
});
