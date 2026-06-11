// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CardStatsModal } from "./CardStatsModal";
import { useCardStore } from "@/app/stores/cardStore";
import { useDraftStore } from "@/app/stores/draftStore";
import { useLiveStore } from "@/app/stores/liveStore";

// Mock the Zustand stores
vi.mock("@/app/stores/cardStore", () => {
  const store: ReturnType<typeof vi.fn> & { getState: ReturnType<typeof vi.fn> } = Object.assign(vi.fn(), {
    getState: vi.fn(() => ({
      scryfallDataMap: new Map(),
      seatCardNames: new Set(),
      takenCardNamesSet: new Set(),
    })),
  });
  return { useCardStore: store };
});

vi.mock("@/app/stores/draftStore", () => {
  const store: ReturnType<typeof vi.fn> & { getState: ReturnType<typeof vi.fn> } = Object.assign(vi.fn(), {
    getState: vi.fn(() => ({
      selectedSeat: null,
    })),
  });
  return { useDraftStore: store };
});

vi.mock("@/app/stores/liveStore", () => {
  const store: ReturnType<typeof vi.fn> & { getState: ReturnType<typeof vi.fn> } = Object.assign(vi.fn(), {
    getState: vi.fn(() => ({
      mySeat: null,
      queuedCardCounts: new Map(),
      floatedCardsSet: new Set(),
    })),
  });
  return { useLiveStore: store };
});

vi.mock("@/app/stores/selectors", () => ({
  useCardStatus: vi.fn(() => ({ status: "none" as const })),
  getImageUrl: vi.fn((name: string | null) =>
    name ? "https://cards.scryfall.io/normal/front/bolt.jpg" : undefined,
  ),
  useIsAuthed: vi.fn(() => false),
}));

vi.mock("@/core/isLocal", () => ({
  isLocalClient: vi.fn(() => false),
}));

const mockCardStatsData = {
  pick: { drafts_in_pool: 5, times_picked: 4, avg_pick: 10.2, median_pick: 9, geomean_pick: 12.4 },
  pick_history: [],
  pick_distribution: Array(15).fill(0),
  times_banned: 0,
  color_pair_breakdown: [{ colorPair: "RW", percentage: 55, deckCount: 3 }],
};

function setupStoreMocks(overrides: {
  selectedCard?: string | null;
  isOpen?: boolean;
  activeDraft?: string | null;
  liveDraftPhase?: string | null;
  mySeat?: number | null;
  selectedSeat?: number | null;
  isMyTurn?: boolean;
} = {}) {
  const cardState: Record<string, unknown> = {
    selectedCard: overrides.selectedCard ?? "Lightning Bolt",
    clearSelectedCard: vi.fn(),
    cardStatsDetail: mockCardStatsData,
    cardStatsLoading: false,
    selectCard: vi.fn(),
  };

  const draftState: Record<string, unknown> = {
    activeDraft: overrides.activeDraft ?? null,
    liveDraftStatus: overrides.liveDraftPhase ? { phase: overrides.liveDraftPhase } : null,
    selectedSeat: overrides.selectedSeat ?? null,
  };

  const liveState: Record<string, unknown> = {
    mySeat: overrides.mySeat ?? null,
    isMyTurn: overrides.isMyTurn ?? false,
    queue: [],
    autoPick: false,
    handlePick: vi.fn(),
    addToQueue: vi.fn(),
    removeFromQueue: vi.fn(),
    addFloat: vi.fn(),
    removeFloat: vi.fn(),
  };

  (useCardStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (state: Record<string, unknown>) => unknown) => selector(cardState),
  );
  (useDraftStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (state: Record<string, unknown>) => unknown) => selector(draftState),
  );
  (useLiveStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (state: Record<string, unknown>) => unknown) => selector(liveState),
  );
}

beforeEach(() => {
  setupStoreMocks();
});

afterEach(() => {
  cleanup();
});

describe("CardStatsModal", () => {
  it("renders card image when open", () => {
    render(<CardStatsModal />);
    const img = screen.getByAltText("Lightning Bolt");
    expect(img).toBeTruthy();
  });

  it("shows pick score", () => {
    render(<CardStatsModal />);
    expect(screen.getByText("12.4")).toBeTruthy();
  });

  it("shows color pair breakdown pills", () => {
    render(<CardStatsModal />);
    expect(screen.getByText("55%")).toBeTruthy();
  });

  it("does not render when selectedCard is null", () => {
    cleanup();
    // Verify mock applies correctly
    (useCardStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          selectedCard: null,
          clearSelectedCard: vi.fn(),
          cardStatsDetail: null,
          cardStatsLoading: false,
          selectCard: vi.fn(),
        }),
    );
    (useDraftStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({ activeDraft: null, liveDraftStatus: null, selectedSeat: null }),
    );
    (useLiveStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          mySeat: null, isMyTurn: false, queue: [], autoPick: false,
          handlePick: vi.fn(), addToQueue: vi.fn(), removeFromQueue: vi.fn(),
          addFloat: vi.fn(), removeFloat: vi.fn(),
        }),
    );
    const { container } = render(<CardStatsModal />);
    expect(container.children.length).toBe(0);
  });

  it("shows action buttons during live draft when it is user's turn", async () => {
    const { useCardStatus, useIsAuthed } = await import("@/app/stores/selectors");
    (useCardStatus as ReturnType<typeof vi.fn>).mockReturnValue({ status: "none" });
    (useIsAuthed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    setupStoreMocks({
      activeDraft: "test-draft",
      liveDraftPhase: "drafting",
      mySeat: 1,
      selectedSeat: 1,
      isMyTurn: true,
    });
    render(<CardStatsModal />);
    expect(screen.getByText("Hold to Pick")).toBeTruthy();
    expect(screen.getByText("Queue")).toBeTruthy();
    expect(screen.getByText("Float")).toBeTruthy();
  });

  it("shows no action buttons for historical drafts", () => {
    render(<CardStatsModal />);
    expect(screen.queryByText("Hold to Pick")).toBeNull();
    expect(screen.queryByText("Queue")).toBeNull();
  });
});
