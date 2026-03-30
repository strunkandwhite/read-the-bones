// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDeckBuilderSync } from "./useDeckBuilderSync";
import type { DeckState, ScryCard } from "@/core/types";

function makeEmptyState(overrides: Partial<DeckState> = {}): DeckState {
  return {
    draftId: "test-draft",
    seat: 1,
    zones: {
      deck: {},
      sideboard: {},
    },
    ...overrides,
  } as DeckState;
}

describe("useDeckBuilderSync", () => {
  const dispatch = vi.fn();
  const scryfallDataMap = new Map<string, ScryCard>();

  const baseProps = {
    deckBuilderActive: true,
    seatCardList: ["Lightning Bolt", "Counterspell"],
    deckBuilderState: makeEmptyState(),
    dispatch,
    scryfallDataMap,
    activeDraft: "test-draft",
    selectedSeat: 1,
    ready: true,
    floatedCards: [] as string[],
    queuedCardNames: [] as string[],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    dispatch.mockClear();
  });

  it("dispatches INIT_FROM_PICKS when first activated with empty zones", () => {
    renderHook(() => useDeckBuilderSync(baseProps));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "INIT_FROM_PICKS" }),
    );
  });

  it("does not dispatch INIT_FROM_PICKS when zones are non-empty", () => {
    const state = makeEmptyState({
      zones: {
        deck: { "0": ["Existing Card"] },
        sideboard: {},
      },
    });

    renderHook(() => useDeckBuilderSync({ ...baseProps, deckBuilderState: state }));

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "INIT_FROM_PICKS" }),
    );
  });

  it("does not dispatch when deck builder is inactive", () => {
    renderHook(() =>
      useDeckBuilderSync({ ...baseProps, deckBuilderActive: false }),
    );

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch when seatCardList is empty", () => {
    renderHook(() =>
      useDeckBuilderSync({ ...baseProps, seatCardList: [] }),
    );

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches SYNC_PICKS when active with card list", () => {
    renderHook(() => useDeckBuilderSync(baseProps));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SYNC_PICKS",
        pickedCardNames: ["Lightning Bolt", "Counterspell"],
      }),
    );
  });

  it("resets initialized flag when deactivated then reactivated", () => {
    const { rerender } = renderHook(
      (props) => useDeckBuilderSync(props),
      { initialProps: baseProps },
    );

    dispatch.mockClear();

    // Deactivate
    rerender({ ...baseProps, deckBuilderActive: false });
    dispatch.mockClear();

    // Reactivate — should dispatch INIT_FROM_PICKS again
    rerender({ ...baseProps, deckBuilderActive: true });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "INIT_FROM_PICKS" }),
    );
  });

  it("does not initialize from picks when ready is false", () => {
    renderHook(() =>
      useDeckBuilderSync({ ...baseProps, ready: false }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("initializes from picks when ready is true and zones are empty", () => {
    renderHook(() =>
      useDeckBuilderSync({ ...baseProps, ready: true }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "INIT_FROM_PICKS" }),
    );
  });

  it("includes floated cards in SYNC_PICKS dispatch", () => {
    renderHook(() =>
      useDeckBuilderSync({ ...baseProps, floatedCards: ["Phelia"] }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SYNC_PICKS",
        pickedCardNames: ["Lightning Bolt", "Counterspell", "Phelia"],
      }),
    );
  });

  it("includes queued cards in SYNC_PICKS dispatch", () => {
    renderHook(() =>
      useDeckBuilderSync({ ...baseProps, queuedCardNames: ["Ragavan"] }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SYNC_PICKS",
        pickedCardNames: ["Lightning Bolt", "Counterspell", "Ragavan"],
      }),
    );
  });

  it("dispatches REMOVE_CARDS when a card is unfloated", () => {
    const { rerender } = renderHook(
      (props) => useDeckBuilderSync(props),
      { initialProps: { ...baseProps, floatedCards: ["Phelia"] } },
    );

    dispatch.mockClear();

    // Unfloat Phelia
    rerender({ ...baseProps, floatedCards: [] });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REMOVE_CARDS",
        cardNames: ["Phelia"],
      }),
    );
  });

  it("does not remove picked cards when unfloated", () => {
    // "Lightning Bolt" is in seatCardList AND floatedCards
    const { rerender } = renderHook(
      (props) => useDeckBuilderSync(props),
      { initialProps: { ...baseProps, floatedCards: ["Lightning Bolt"] } },
    );

    dispatch.mockClear();

    // Unfloat Lightning Bolt — but it's still picked, so no REMOVE_CARDS
    rerender({ ...baseProps, floatedCards: [] });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "REMOVE_CARDS" }),
    );
  });
});
