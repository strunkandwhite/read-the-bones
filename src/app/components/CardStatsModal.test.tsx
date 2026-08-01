// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { CardStatsModal } from "./CardStatsModal";
import type { WorthCard } from "@/core/worthModel";
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
  useLocalDeckMode: vi.fn(() => false),
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

const mockWorthCard: WorthCard = {
  card_name: "Lightning Bolt",
  colors: "R",
  is_land: false,
  in_current_cube: true,
  geomean: 4.2,
  games: 33,
  wins: 20,
  losses: 13,
  wr: 0.606,
  se: 0.085,
  delta: 0.05,
  expected: 0.003,
  pvi: 1.63,
  worth: 0.047,
  prior_only: false,
  no_data: false,
  act_by: 17,
};

function setupStoreMocks(overrides: {
  selectedCard?: string | null;
  isOpen?: boolean;
  activeDraft?: string | null;
  liveDraftPhase?: string | null;
  mySeat?: number | null;
  selectedSeat?: number | null;
  isMyTurn?: boolean;
  worthCard?: WorthCard;
  worthModel?: { tau: number; sigma: number; kappa: number } | null;
} = {}) {
  const cardState: Record<string, unknown> = {
    selectedCard: overrides.selectedCard ?? "Lightning Bolt",
    clearSelectedCard: vi.fn(),
    cardStatsDetail: mockCardStatsData,
    cardStatsLoading: false,
    selectCard: vi.fn(),
    worthCards: overrides.worthCard
      ? new Map([[overrides.worthCard.card_name, overrides.worthCard]])
      : new Map(),
    worthModel: overrides.worthModel ?? null,
  };

  const draftState: Record<string, unknown> = {
    activeDraft: overrides.activeDraft ?? null,
    board: overrides.liveDraftPhase ? { phase: overrides.liveDraftPhase } : null,
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

  describe("action button interactions", () => {
    async function setupWithActions() {
      const { useCardStatus, useIsAuthed } = await import("@/app/stores/selectors");
      (useCardStatus as ReturnType<typeof vi.fn>).mockReturnValue({ status: "none" });
      (useIsAuthed as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const addToQueue = vi.fn();
      const addFloat = vi.fn();
      const handlePick = vi.fn().mockResolvedValue(undefined);
      const clearSelectedCard = vi.fn();

      (useCardStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({
            selectedCard: "Lightning Bolt",
            clearSelectedCard,
            cardStatsDetail: mockCardStatsData,
            cardStatsLoading: false,
            selectCard: vi.fn(),
            worthCards: new Map(),
            worthModel: null,
          }),
      );
      (useDraftStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({ activeDraft: "test-draft", board: { phase: "drafting" }, selectedSeat: 1 }),
      );
      (useLiveStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({
            mySeat: 1,
            isMyTurn: true,
            queue: [],
            autoPick: false,
            handlePick,
            addToQueue,
            removeFromQueue: vi.fn(),
            addFloat,
            removeFloat: vi.fn(),
          }),
      );
      return { addToQueue, addFloat, handlePick, clearSelectedCard };
    }

    it("clicking Queue button calls addToQueue with the selected card", async () => {
      const { addToQueue } = await setupWithActions();
      render(<CardStatsModal />);

      const queueBtn = screen.getByText("Queue");
      fireEvent.click(queueBtn);

      expect(addToQueue).toHaveBeenCalledWith("Lightning Bolt");
    });

    it("clicking Float button calls addFloat with the selected card", async () => {
      const { addFloat } = await setupWithActions();
      render(<CardStatsModal />);

      const floatBtn = screen.getByText("Float");
      fireEvent.click(floatBtn);

      expect(addFloat).toHaveBeenCalledWith("Lightning Bolt");
    });

    it("clicking Queue disables buttons (actionPending) for at least ACTION_PENDING_MIN_MS", async () => {
      vi.useFakeTimers();
      await setupWithActions();
      render(<CardStatsModal />);

      const queueBtn = screen.getByText("Queue") as HTMLButtonElement;
      expect(queueBtn.disabled).toBe(false);

      await act(async () => {
        fireEvent.click(queueBtn);
        // Flush promises — actionPending is set synchronously
        await Promise.resolve();
      });

      // Immediately after click — the button should be disabled (actionPending)
      expect((screen.getByText("Queue") as HTMLButtonElement).disabled).toBe(true);

      // After timer fires, actionPending clears
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });

      vi.useRealTimers();
    });
  });

  describe("close behaviour", () => {
    it("pressing Escape calls clearSelectedCard", async () => {
      const clearSelectedCard = vi.fn();
      (useCardStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({
            selectedCard: "Lightning Bolt",
            clearSelectedCard,
            cardStatsDetail: mockCardStatsData,
            cardStatsLoading: false,
            selectCard: vi.fn(),
            worthCards: new Map(),
            worthModel: null,
          }),
      );
      (useDraftStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({ activeDraft: null, board: null, selectedSeat: null }),
      );
      (useLiveStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({
            mySeat: null, isMyTurn: false, queue: [], autoPick: false,
            handlePick: vi.fn(), addToQueue: vi.fn(), removeFromQueue: vi.fn(),
            addFloat: vi.fn(), removeFloat: vi.fn(),
          }),
      );

      render(<CardStatsModal />);

      fireEvent.keyDown(document, { key: "Escape" });

      expect(clearSelectedCard).toHaveBeenCalled();
    });

    it("clicking the backdrop (overlay div) calls clearSelectedCard", () => {
      const clearSelectedCard = vi.fn();
      (useCardStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({
            selectedCard: "Lightning Bolt",
            clearSelectedCard,
            cardStatsDetail: mockCardStatsData,
            cardStatsLoading: false,
            selectCard: vi.fn(),
            worthCards: new Map(),
            worthModel: null,
          }),
      );
      (useDraftStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({ activeDraft: null, board: null, selectedSeat: null }),
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

      // The backdrop is the outermost div with bg-black/60 class
      const backdrop = container.firstElementChild as HTMLElement;
      expect(backdrop).toBeTruthy();
      fireEvent.click(backdrop);

      expect(clearSelectedCard).toHaveBeenCalled();
    });

    it("clicking inside the modal content does NOT call clearSelectedCard", () => {
      const clearSelectedCard = vi.fn();
      (useCardStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({
            selectedCard: "Lightning Bolt",
            clearSelectedCard,
            cardStatsDetail: mockCardStatsData,
            cardStatsLoading: false,
            selectCard: vi.fn(),
            worthCards: new Map(),
            worthModel: null,
          }),
      );
      (useDraftStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({ activeDraft: null, board: null, selectedSeat: null }),
      );
      (useLiveStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: Record<string, unknown>) => unknown) =>
          selector({
            mySeat: null, isMyTurn: false, queue: [], autoPick: false,
            handlePick: vi.fn(), addToQueue: vi.fn(), removeFromQueue: vi.fn(),
            addFloat: vi.fn(), removeFloat: vi.fn(),
          }),
      );

      render(<CardStatsModal />);

      // Click the stats value (inside modal content) — should NOT close
      const pickScore = screen.getByText("12.4");
      fireEvent.click(pickScore);

      expect(clearSelectedCard).not.toHaveBeenCalled();
    });
  });

  describe("worth model block (dev-only)", () => {
    const mockWorthModel = { tau: 0.035, sigma: 0.51, kappa: 0.5 };

    async function setLocalClient(value: boolean) {
      const { isLocalClient } = await import("@/core/isLocal");
      (isLocalClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(value);
    }

    afterEach(async () => {
      await setLocalClient(false);
    });

    it("renders Worth, PVI, act_by, games, and the model footnote on localhost", async () => {
      await setLocalClient(true);
      setupStoreMocks({ worthCard: mockWorthCard, worthModel: mockWorthModel });

      render(<CardStatsModal />);

      expect(screen.getByText("Worth Model")).toBeTruthy();
      expect(screen.getByText("+4.7%")).toBeTruthy(); // worth
      expect(screen.getByText("+1.6σ")).toBeTruthy(); // pvi
      expect(screen.getByText("17")).toBeTruthy(); // act_by
      expect(screen.getByText("33")).toBeTruthy(); // games
      expect(screen.getByText(/τ 0\.035 · σ 0\.510 · κ/)).toBeTruthy();
    });

    it("shows em-dashes for null worth/pvi/act_by", async () => {
      await setLocalClient(true);
      setupStoreMocks({
        worthCard: {
          ...mockWorthCard,
          worth: null,
          pvi: null,
          act_by: null,
          no_data: true,
          games: 0,
        },
        worthModel: mockWorthModel,
      });

      render(<CardStatsModal />);

      expect(screen.getByText("Worth Model")).toBeTruthy();
      expect(screen.getAllByText("—")).toHaveLength(3);
    });

    it("does not render the block off localhost", () => {
      setupStoreMocks({ worthCard: mockWorthCard, worthModel: mockWorthModel });

      render(<CardStatsModal />);

      expect(screen.queryByText("Worth Model")).toBeNull();
    });

    it("does not render the block when no worth data exists for the card", async () => {
      await setLocalClient(true);
      setupStoreMocks({ worthModel: mockWorthModel });

      render(<CardStatsModal />);

      expect(screen.queryByText("Worth Model")).toBeNull();
    });
  });
});
