"use client";

import { useState, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { QueueGroupEntry } from "../../stores/liveStore";

export type QueuePanelProps = {
  queue: QueueGroupEntry[];
  autoPick: boolean;
  onReorder: (queue: QueueGroupEntry[]) => void;
  onRemove: (cardName: string) => void;
  onToggleAutoPick: () => void;
  onSetEntryMode: (entryIndex: number, mode: "pause" | "flow-through") => void;
  takenCards?: Set<string>;
};

// Drag IDs encode context:
//   "entry:<entryIndex>"          — top-level entry drag
//   "card:<entryIndex>:<cardIndex>" — card within a group drag
function makeEntryId(entryIndex: number) {
  return `entry:${entryIndex}`;
}
function makeCardId(entryIndex: number, cardIndex: number) {
  return `card:${entryIndex}:${cardIndex}`;
}
function parseId(id: string) {
  const parts = id.split(":");
  if (parts[0] === "entry") return { type: "entry" as const, entryIndex: parseInt(parts[1], 10) };
  if (parts[0] === "card") return { type: "card" as const, entryIndex: parseInt(parts[1], 10), cardIndex: parseInt(parts[2], 10) };
  return null;
}

// ─── Sortable Entry (top-level) ───────────────────────────────────────────────

interface SortableEntryProps {
  id: string;
  entry: QueueGroupEntry;
  entryIndex: number;
  allEntries: QueueGroupEntry[];
  onRemove: (cardName: string) => void;
  onSetEntryMode: (entryIndex: number, mode: "pause" | "flow-through") => void;
  onReorder: (queue: QueueGroupEntry[]) => void;
  takenCards: Set<string>;
  isOver: boolean;
  isMergeTarget: boolean;
}

function SortableEntry({
  id,
  entry,
  entryIndex,
  allEntries,
  onRemove,
  onSetEntryMode,
  onReorder,
  takenCards,
  isOver,
  isMergeTarget,
}: SortableEntryProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data: { type: "entry", entryIndex } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const isGroup = entry.cards.length > 1;
  const allTaken = entry.cards.every((c) => takenCards.has(c.cardName));
  const isPause = entry.mode === "pause";

  // Grouped entries: inner sortable for cards within the group
  if (isGroup) {
    const cardIds = entry.cards.map((_, ci) => makeCardId(entryIndex, ci));
    return (
      <li
        ref={setNodeRef}
        style={style}
        className={`rounded px-2 py-1.5 text-xs transition-colors ${
          isMergeTarget
            ? "border-2 border-dashed border-green-500/60 bg-green-900/20"
            : isOver
              ? "border border-blue-500/60 bg-blue-900/20"
              : "border border-zinc-700/60 bg-zinc-800/50"
        } ${allTaken ? "opacity-40" : ""}`}
      >
        {/* Group header */}
        <div className="flex items-center gap-1.5">
          {/* Drag handle */}
          <span
            {...attributes}
            {...listeners}
            className="cursor-grab text-zinc-600 select-none touch-none"
            aria-label="Drag to reorder"
          >
            ⠿
          </span>
          <span className="flex-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Group ({entry.cards.length})
          </span>
          {/* Mode toggle */}
          <button
            onClick={() => onSetEntryMode(entryIndex, isPause ? "flow-through" : "pause")}
            aria-label={`Mode: ${entry.mode}`}
            title={isPause ? "Pause: stops here if top card taken" : "Flow-through: skips taken cards"}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none transition-colors cursor-pointer border-none ${
              isPause
                ? "bg-blue-900/50 text-blue-300 hover:bg-blue-800/60"
                : "bg-amber-900/50 text-amber-300 hover:bg-amber-800/60"
            }`}
          >
            {isPause ? "⏸" : "⏩"}
          </button>
        </div>

        {/* Cards within group */}
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          <ul className="mt-1.5 flex flex-col gap-0.5 pl-4">
            {entry.cards.map((card, cardIndex) => (
              <SortableGroupCard
                key={makeCardId(entryIndex, cardIndex)}
                id={makeCardId(entryIndex, cardIndex)}
                cardName={card.cardName}
                entryIndex={entryIndex}
                cardIndex={cardIndex}
                allEntries={allEntries}
                onRemove={onRemove}
                onReorder={onReorder}
                isTaken={takenCards.has(card.cardName)}
              />
            ))}
          </ul>
        </SortableContext>
      </li>
    );
  }

  // Single-card entry
  const card = entry.cards[0];
  const isTaken = takenCards.has(card.cardName);

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
        isMergeTarget
          ? "border-2 border-dashed border-green-500/60 bg-green-900/20"
          : isOver
            ? "border border-blue-500/60 bg-blue-900/20"
            : "border border-transparent bg-zinc-800/30"
      }`}
    >
      {/* Drag handle */}
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-zinc-600 select-none touch-none"
        aria-label="Drag to reorder"
      >
        ⠿
      </span>

      {/* Card name */}
      <span className={`flex-1 ${isTaken ? "text-zinc-600 line-through" : "text-zinc-300"}`}>
        {card.cardName}
      </span>

      {/* Mode toggle */}
      <button
        onClick={() => onSetEntryMode(entryIndex, isPause ? "flow-through" : "pause")}
        aria-label={`Mode: ${entry.mode}`}
        title={isPause ? "Pause: stops here if card taken" : "Flow-through: skips if card taken"}
        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none transition-colors cursor-pointer border-none ${
          isPause
            ? "bg-blue-900/50 text-blue-300 hover:bg-blue-800/60"
            : "bg-amber-900/50 text-amber-300 hover:bg-amber-800/60"
        }`}
      >
        {isPause ? "⏸" : "⏩"}
      </button>

      {/* Remove */}
      <button
        onClick={() => onRemove(card.cardName)}
        aria-label={`Remove ${card.cardName}`}
        className="cursor-pointer border-none bg-transparent px-1 py-0.5 text-sm leading-none text-zinc-500 hover:text-zinc-300"
      >
        &times;
      </button>
    </li>
  );
}

// ─── Sortable Card within a Group ─────────────────────────────────────────────

interface SortableGroupCardProps {
  id: string;
  cardName: string;
  entryIndex: number;
  cardIndex: number;
  allEntries: QueueGroupEntry[];
  onRemove: (cardName: string) => void;
  onReorder: (queue: QueueGroupEntry[]) => void;
  isTaken: boolean;
}

function SortableGroupCard({
  id,
  cardName,
  entryIndex,
  cardIndex,
  allEntries,
  onRemove,
  onReorder,
  isTaken,
}: SortableGroupCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data: { type: "card", entryIndex, cardIndex } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  function handleRemoveFromGroup() {
    const entry = allEntries[entryIndex];
    const newCards = entry.cards.filter((_, i) => i !== cardIndex);
    let newEntries: QueueGroupEntry[];
    if (newCards.length === 0) {
      // Remove entire entry
      newEntries = allEntries.filter((_, i) => i !== entryIndex);
    } else if (newCards.length === 1) {
      // Collapse to single-card entry
      newEntries = allEntries.map((e, i) =>
        i === entryIndex ? { ...e, cards: newCards } : e
      );
    } else {
      newEntries = allEntries.map((e, i) =>
        i === entryIndex ? { ...e, cards: newCards } : e
      );
    }
    onReorder(newEntries);
    onRemove(cardName);
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1.5 rounded px-1 py-0.5"
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-zinc-700 select-none touch-none text-[10px]"
        aria-label="Drag to reorder"
      >
        ⠿
      </span>
      <span className={`flex-1 text-xs ${isTaken ? "text-zinc-600 line-through" : "text-zinc-400"}`}>
        {cardName}
      </span>
      <button
        onClick={handleRemoveFromGroup}
        aria-label={`Remove ${cardName}`}
        className="cursor-pointer border-none bg-transparent px-1 py-0.5 text-sm leading-none text-zinc-600 hover:text-zinc-300"
      >
        &times;
      </button>
    </li>
  );
}

// ─── QueuePanel ───────────────────────────────────────────────────────────────

export function QueuePanel({
  queue,
  autoPick,
  onReorder,
  onRemove,
  onToggleAutoPick,
  onSetEntryMode,
  takenCards = new Set(),
}: QueuePanelProps) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overEntryIndex, setOverEntryIndex] = useState<number | null>(null);
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);
  const mergeTargetRef = useRef<number | null>(null);

  function updateMergeTarget(index: number | null) {
    setMergeTarget(index);
    mergeTargetRef.current = index;
  }

  // Hold-to-merge: track which entry the dragged item is hovering over,
  // and after MERGE_HOLD_MS, activate the merge indicator.
  const MERGE_HOLD_MS = 500;
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverEntryRef = useRef<number | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverEntryRef.current = null;
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
    updateMergeTarget(null);
    clearHoverTimer();
  }, [clearHoverTimer]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      setOverEntryIndex(null);
      updateMergeTarget(null);
      clearHoverTimer();
      return;
    }
    const activeParsed = activeDragId ? parseId(activeDragId) : null;
    const overParsed = parseId(String(event.over.id));

    if (!activeParsed || activeParsed.type !== "entry") {
      setOverEntryIndex(overParsed?.type === "entry" ? overParsed.entryIndex : null);
      updateMergeTarget(null);
      clearHoverTimer();
      return;
    }

    // Determine which entry index the pointer is over
    let overEntryIdx: number | null = null;
    if (overParsed?.type === "entry" && overParsed.entryIndex !== activeParsed.entryIndex) {
      overEntryIdx = overParsed.entryIndex;
    } else if (overParsed?.type === "card" && overParsed.entryIndex !== activeParsed.entryIndex) {
      overEntryIdx = overParsed.entryIndex;
    }

    setOverEntryIndex(overParsed?.type === "entry" ? overParsed.entryIndex : (overParsed?.type === "card" ? overParsed.entryIndex : null));

    if (overEntryIdx !== null) {
      // Hovering over a different entry — start or continue the hold timer
      if (hoverEntryRef.current !== overEntryIdx) {
        // Moved to a new entry — reset timer
        clearHoverTimer();
        hoverEntryRef.current = overEntryIdx;
        const targetIdx = overEntryIdx;
        hoverTimerRef.current = setTimeout(() => {
          updateMergeTarget(targetIdx);
        }, MERGE_HOLD_MS);
      }
      // If same entry, timer is already running (or merge already active)
    } else {
      // Not over a valid merge target
      updateMergeTarget(null);
      clearHoverTimer();
    }
  }, [activeDragId, clearHoverTimer]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const currentMergeTarget = mergeTargetRef.current;
      setActiveDragId(null);
      setOverEntryIndex(null);
      updateMergeTarget(null);
      clearHoverTimer();

      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeId = active.id as string;
      const overId = over.id as string;
      const activeParsed = parseId(activeId);
      const overParsed = parseId(overId);
      if (!activeParsed || !overParsed) return;

      // ── Case 1: Merge entry into another entry or group ────────────────
      // If mergeTarget was set (green indicator was showing), always merge.
      if (activeParsed.type === "entry" && currentMergeTarget !== null) {
        const fromIndex = activeParsed.entryIndex;
        const toIndex = currentMergeTarget;
        if (fromIndex === toIndex) return;

        const draggedEntry = queue[fromIndex];
        const targetEntry = queue[toIndex];
        const mergedEntry: QueueGroupEntry = {
          mode: targetEntry.mode,
          cards: [...targetEntry.cards, ...draggedEntry.cards],
        };
        const newQueue = queue
          .filter((_, i) => i !== fromIndex)
          .map((entry, i) => {
            const adjustedTarget = fromIndex < toIndex ? toIndex - 1 : toIndex;
            return i === adjustedTarget ? mergedEntry : entry;
          });
        onReorder(newQueue);
        return;
      }

      // ── Case 2: Reorder top-level entries ──────────────────────────────
      if (activeParsed.type === "entry" && overParsed.type === "entry") {
        const fromIndex = activeParsed.entryIndex;
        const toIndex = overParsed.entryIndex;
        if (fromIndex === toIndex) return;

        const newQueue = [...queue];
        const [moved] = newQueue.splice(fromIndex, 1);
        newQueue.splice(toIndex, 0, moved);
        onReorder(newQueue);
        return;
      }

      // ── Case 2: Reorder cards within a group ───────────────────────────────
      if (
        activeParsed.type === "card" &&
        overParsed.type === "card" &&
        activeParsed.entryIndex === overParsed.entryIndex
      ) {
        const entryIndex = activeParsed.entryIndex;
        const fromCardIndex = activeParsed.cardIndex;
        const toCardIndex = overParsed.cardIndex;
        if (fromCardIndex === toCardIndex) return;

        const newQueue = queue.map((entry, i) => {
          if (i !== entryIndex) return entry;
          const newCards = [...entry.cards];
          const [moved] = newCards.splice(fromCardIndex, 1);
          newCards.splice(toCardIndex, 0, moved);
          return { ...entry, cards: newCards };
        });
        onReorder(newQueue);
        return;
      }

      // ── Case 3: Drag card out of group to become top-level entry ───────────
      if (activeParsed.type === "card" && overParsed.type === "entry") {
        const srcEntryIndex = activeParsed.entryIndex;
        const srcCardIndex = activeParsed.cardIndex;
        const targetEntryIndex = overParsed.entryIndex;

        if (srcEntryIndex === targetEntryIndex) return;

        const srcEntry = queue[srcEntryIndex];
        const draggedCard = srcEntry.cards[srcCardIndex];

        // Remove card from source group
        const newSrcCards = srcEntry.cards.filter((_, i) => i !== srcCardIndex);

        let newQueue: QueueGroupEntry[] = queue.map((entry, i) => {
          if (i !== srcEntryIndex) return entry;
          return { ...entry, cards: newSrcCards };
        });

        // Remove empty source entry
        if (newSrcCards.length === 0) {
          newQueue = newQueue.filter((_, i) => i !== srcEntryIndex);
        }

        // Insert as new single-card entry at the target position
        const adjustedTarget = newSrcCards.length === 0 && srcEntryIndex < targetEntryIndex
          ? targetEntryIndex - 1
          : targetEntryIndex;

        const newEntry: QueueGroupEntry = { mode: "pause", cards: [draggedCard] };
        newQueue.splice(adjustedTarget, 0, newEntry);
        onReorder(newQueue);
        return;
      }

    },
    [queue, onReorder, clearHoverTimer]
  );

  const entryIds = queue.map((_, i) => makeEntryId(i));

  // Derive active drag info for overlay
  const activeParsed = activeDragId ? parseId(activeDragId) : null;
  let overlayLabel: string | null = null;
  if (activeParsed) {
    if (activeParsed.type === "entry") {
      const entry = queue[activeParsed.entryIndex];
      if (entry) {
        overlayLabel = entry.cards.length === 1
          ? entry.cards[0].cardName
          : `Group (${entry.cards.length})`;
      }
    } else if (activeParsed.type === "card") {
      const entry = queue[activeParsed.entryIndex];
      if (entry) overlayLabel = entry.cards[activeParsed.cardIndex]?.cardName ?? null;
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-4">
      {/* Header */}
      <div className="mb-2 text-[13px] font-semibold tracking-tight text-zinc-200">
        Pick Queue
      </div>

      {/* Auto-pick toggle */}
      <div className="mb-3">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <span>Auto-pick</span>
          <input
            type="checkbox"
            checked={autoPick}
            onChange={onToggleAutoPick}
            className="cursor-pointer"
          />
        </label>
      </div>

      {/* Queue list */}
      {queue.length === 0 ? (
        <div className="py-5 text-center text-xs text-zinc-600">
          Queue is empty. Add cards from the card table.
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
            <ol className="m-0 flex max-h-[30vh] list-none flex-col gap-1 overflow-y-auto p-0">
              {queue.map((entry, entryIndex) => (
                <SortableEntry
                  key={makeEntryId(entryIndex)}
                  id={makeEntryId(entryIndex)}
                  entry={entry}
                  entryIndex={entryIndex}
                  allEntries={queue}
                  onRemove={onRemove}
                  onSetEntryMode={onSetEntryMode}
                  onReorder={onReorder}
                  takenCards={takenCards}
                  isOver={overEntryIndex === entryIndex && activeDragId !== makeEntryId(entryIndex)}
                  isMergeTarget={mergeTarget === entryIndex}
                />
              ))}
            </ol>
          </SortableContext>

          <DragOverlay>
            {overlayLabel && (
              <div className="rounded border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-lg opacity-90">
                {overlayLabel}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
