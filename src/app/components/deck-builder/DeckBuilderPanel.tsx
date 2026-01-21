"use client";

import { useState, useCallback, useMemo } from "react";
import { track } from "@vercel/analytics/react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { DeckZone } from "./DeckZone";
import { BasicLandsDialog } from "./BasicLandsDialog";
import { BASIC_LAND_IMAGES } from "./basicLandImages";
import type { DeckState, ScryCard, CardStats, BasicLandCounts } from "@/core/types";
import { type DeckAction, formatDecklistText } from "@/core/deckBuilder";
import { useSlowRenderTracking } from "../../hooks/useSlowRenderTracking";

interface DeckBuilderPanelProps {
  state: DeckState;
  dispatch: (action: DeckAction) => void;
  scryfallData: Map<string, ScryCard>;
  cardStats: Map<string, CardStats>;
  draftName: string;
  onClose: () => void;
}

function parseDragId(id: string) {
  const [zone, column, indexStr, ...rest] = id.split(":");
  return {
    zone: zone as "deck" | "sideboard",
    column,
    index: parseInt(indexStr, 10),
    cardName: rest.join(":"),
  };
}

export function DeckBuilderPanel({
  state,
  dispatch,
  scryfallData,
  cardStats,
  draftName,
  onClose,
}: DeckBuilderPanelProps) {
  useSlowRenderTracking("deck_builder");
  const [showBasicLands, setShowBasicLands] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const from = parseDragId(activeId);

      const toParts = overId.split(":");
      const toZone = toParts[0] as "deck" | "sideboard";
      const toColumn = toParts[1];
      const isCardTarget = toParts.length >= 4;

      if (activeId === overId) return;

      if (from.zone === toZone && from.column === toColumn) {
        const list = state.zones[from.zone][from.column];
        const fromIndex = list.indexOf(from.cardName);
        if (isCardTarget) {
          const targetIndex = parseInt(toParts[2], 10);
          if (
            fromIndex !== -1 &&
            targetIndex !== -1 &&
            fromIndex !== targetIndex
          ) {
            dispatch({
              type: "REORDER_CARD",
              zone: from.zone,
              column: from.column,
              fromIndex,
              toIndex: targetIndex,
            });
          }
        }
        return;
      }

      const targetList = state.zones[toZone][toColumn] ?? [];
      let toIndex = targetList.length;
      if (isCardTarget) {
        const targetIndex = parseInt(toParts[2], 10);
        if (targetIndex >= 0) toIndex = targetIndex;
      }

      dispatch({
        type: "MOVE_CARD",
        cardName: from.cardName,
        fromZone: from.zone,
        fromColumn: from.column,
        toZone,
        toColumn,
        toIndex,
      });
      if (from.zone !== toZone) {
        track("deck_card_add", { zone: toZone, source: "drag" });
      }
    },
    [state, dispatch]
  );

  const [shareStatus, setShareStatus] = useState<"idle" | "sharing" | "shared">("idle");

  const handleShareDeck = useCallback(async () => {
    setShareStatus("sharing");
    try {
      const response = await fetch("/api/deck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "Server error");
      }
      const { deckId } = await response.json();
      const url = `${window.location.origin}/?deck=${deckId}`;
      await navigator.clipboard.writeText(url);
      const totalCards = Object.values(state.zones.deck).flat().length
        + Object.values(state.zones.sideboard).flat().length;
      track("deck_shared", { draft: draftName, card_count: totalCards });
      setShareStatus("shared");
      setTimeout(() => setShareStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to share deck:", error);
      setShareStatus("idle");
      alert("Failed to share deck. Please try again.");
    }
  }, [state, draftName]);

  const handleSetBasics = useCallback(
    (basics: BasicLandCounts) => {
      dispatch({ type: "SET_BASICS", basics, scryfallData });
    },
    [dispatch, scryfallData]
  );

  const [exportStatus, setExportStatus] = useState<"idle" | "copied">("idle");

  const handleExportText = useCallback(async () => {
    try {
      const text = formatDecklistText(state);
      await navigator.clipboard.writeText(text);
      track("deck_exported", { draft: draftName, format: "text" });
      setExportStatus("copied");
      setTimeout(() => setExportStatus("idle"), 2000);
    } catch {
      alert("Failed to copy to clipboard.");
    }
  }, [state, draftName]);

  const handleClearDeck = useCallback(() => {
    dispatch({ type: "CLEAR_DECK", scryfallData });
  }, [dispatch, scryfallData]);

  const handleRemoveSpeculative = useCallback(
    (cardName: string) => {
      dispatch({ type: "REMOVE_SPECULATIVE", cardName });
    },
    [dispatch],
  );

  const dragOverlayCard = useMemo(() => {
    if (!activeDragId) return null;
    const { cardName } = parseDragId(activeDragId);
    const scryfall = scryfallData.get(cardName);
    return { cardName, imageUri: scryfall?.imageUri ?? BASIC_LAND_IMAGES[cardName] };
  }, [activeDragId, scryfallData]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-zinc-700/40 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800/60 bg-zinc-900/80 px-5 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={onClose}
            className="cursor-pointer rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
          >
            Close
          </button>
          <div className="h-4 w-px bg-zinc-700/60" />
          <span className="text-sm font-semibold tracking-tight text-zinc-200">
            {draftName}
          </span>
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400">
            Seat {state.seat}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowBasicLands(true)}
            className="cursor-pointer rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
          >
            Add Basic Lands
          </button>
          <button
            onClick={handleClearDeck}
            className="cursor-pointer rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
          >
            Clear Deck
          </button>
          <button
            onClick={handleExportText}
            className="cursor-pointer rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
          >
            {exportStatus === "copied" ? "Copied!" : "Export"}
          </button>
          <button
            onClick={handleShareDeck}
            className="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-blue-900/40 hover:bg-blue-500 transition-colors"
          >
            {shareStatus === "sharing" ? "Sharing..." : shareStatus === "shared" ? "Copied!" : "Share Deck"}
          </button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="overflow-y-auto px-5 py-4 space-y-5 flex-1">
          <DeckZone
            zone="sideboard"
            columns={state.zones.sideboard}
            scryfallData={scryfallData}
            cardStats={cardStats}
            speculativeCards={state.speculativeCards}
            onRemoveSpeculative={handleRemoveSpeculative}
          />
          <div className="border-t border-zinc-700/30" />
          <DeckZone
            zone="deck"
            columns={state.zones.deck}
            scryfallData={scryfallData}
            cardStats={cardStats}
            speculativeCards={state.speculativeCards}
            onRemoveSpeculative={handleRemoveSpeculative}
          />
        </div>

        <DragOverlay>
          {dragOverlayCard && (
            <div className="w-[120px] rounded border border-zinc-500 shadow-xl opacity-90">
              {dragOverlayCard.imageUri ? (
                <img
                  src={dragOverlayCard.imageUri}
                  alt={dragOverlayCard.cardName}
                  className="rounded w-full"
                  draggable={false}
                />
              ) : (
                <div className="flex items-center justify-center bg-zinc-800 p-2 text-xs text-zinc-300 aspect-[5/7] rounded">
                  {dragOverlayCard.cardName}
                </div>
              )}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {showBasicLands && (
        <BasicLandsDialog
          basicLands={state.basicLands}
          onSave={handleSetBasics}
          onClose={() => setShowBasicLands(false)}
        />
      )}
    </div>
  );
}
