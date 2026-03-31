"use client";

import { useState, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
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

// ─── ID helpers ──────────────────────────────────────────────────────────────
//   "entry:<i>"            — sortable top-level entry
//   "merge:<i>"            — droppable merge zone inside entry i
//   "card:<i>:<j>"         — sortable card j within group i

function makeEntryId(i: number) { return `entry:${i}`; }
function makeMergeId(i: number) { return `merge:${i}`; }
function makeCardId(i: number, j: number) { return `card:${i}:${j}`; }

type ParsedId =
  | { type: "entry"; entryIndex: number }
  | { type: "merge"; entryIndex: number }
  | { type: "card"; entryIndex: number; cardIndex: number };

function parseId(id: string): ParsedId | null {
  const p = id.split(":");
  if (p[0] === "entry") return { type: "entry", entryIndex: +p[1] };
  if (p[0] === "merge") return { type: "merge", entryIndex: +p[1] };
  if (p[0] === "card") return { type: "card", entryIndex: +p[1], cardIndex: +p[2] };
  return null;
}

// ─── Custom collision detection ──────────────────────────────────────────────
// Check merge: zones first (pointer must be inside). If pointer is inside a
// merge zone, return that. Otherwise fall back to closestCenter for sortable
// reorder behavior.

const mergeAwareCollision: CollisionDetection = (args) => {
  const mergeContainers = args.droppableContainers.filter(
    ({ id }) => String(id).startsWith("merge:"),
  );
  const mergeHits = pointerWithin({ ...args, droppableContainers: mergeContainers });
  if (mergeHits.length > 0) return mergeHits;

  // Fall back to sortable entries + cards (exclude merge: zones)
  const nonMerge = args.droppableContainers.filter(
    ({ id }) => !String(id).startsWith("merge:"),
  );
  return closestCenter({ ...args, droppableContainers: nonMerge });
};

// ─── Insertion Line ──────────────────────────────────────────────────────────

function InsertionLine() {
  return (
    <div className="relative h-0">
      <div className="absolute left-0 right-0 h-0.5 rounded-full bg-blue-500" />
    </div>
  );
}

// ─── Merge Drop Zone ─────────────────────────────────────────────────────────
// A smaller inner droppable that activates merge detection. Physically tracks
// the DOM element, so when sortable animation moves the entry, the merge zone
// moves with it and the pointer leaves naturally.

function MergeZone({ entryIndex, children }: { entryIndex: number; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({
    id: makeMergeId(entryIndex),
    data: { type: "merge", entryIndex },
  });
  return <div ref={setNodeRef}>{children}</div>;
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
  isMergeTarget: boolean;
  cardInsertionBefore: number | null;
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
  isMergeTarget,
  cardInsertionBefore,
}: SortableEntryProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, data: { type: "entry", entryIndex } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const isGroup = entry.cards.length > 1;
  const allTaken = entry.cards.every((c) => takenCards.has(c.cardName));
  const isPause = entry.mode === "pause";

  const modeToggle = (
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
  );

  const mergeStyle = isMergeTarget
    ? "border-2 border-dashed border-green-500/60 bg-green-900/20"
    : "";

  // Grouped entries
  if (isGroup) {
    const cardIds = entry.cards.map((_, ci) => makeCardId(entryIndex, ci));
    return (
      <div ref={setNodeRef} style={style}>
        <MergeZone entryIndex={entryIndex}>
          <div
            className={`rounded px-2 py-1.5 text-xs transition-colors ${
              mergeStyle || "border border-zinc-700/60 bg-zinc-800/50"
            } ${allTaken ? "opacity-40" : ""}`}
          >
            <div className="flex items-center gap-1.5">
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
              {modeToggle}
            </div>
            <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
              <div className="mt-1.5 flex flex-col gap-0.5 pl-4">
                {entry.cards.map((card, cardIndex) => (
                  <div key={makeCardId(entryIndex, cardIndex)}>
                    {cardInsertionBefore === cardIndex && <InsertionLine />}
                    <SortableGroupCard
                      id={makeCardId(entryIndex, cardIndex)}
                      cardName={card.cardName}
                      entryIndex={entryIndex}
                      cardIndex={cardIndex}
                      allEntries={allEntries}
                      onReorder={onReorder}
                      isTaken={takenCards.has(card.cardName)}
                    />
                  </div>
                ))}
                {cardInsertionBefore === entry.cards.length && <InsertionLine />}
              </div>
            </SortableContext>
          </div>
        </MergeZone>
      </div>
    );
  }

  // Single-card entry
  const card = entry.cards[0];
  const isTaken = takenCards.has(card.cardName);

  return (
    <div ref={setNodeRef} style={style}>
      <MergeZone entryIndex={entryIndex}>
        <div
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
            mergeStyle || "border border-transparent bg-zinc-800/30"
          }`}
        >
          <span
            {...attributes}
            {...listeners}
            className="cursor-grab text-zinc-600 select-none touch-none"
            aria-label="Drag to reorder"
          >
            ⠿
          </span>
          <span className={`flex-1 ${isTaken ? "text-zinc-600 line-through" : "text-zinc-300"}`}>
            {card.cardName}
          </span>
          {modeToggle}
          <button
            onClick={() => onRemove(card.cardName)}
            aria-label={`Remove ${card.cardName}`}
            className="cursor-pointer border-none bg-transparent px-1 py-0.5 text-sm leading-none text-zinc-500 hover:text-zinc-300"
          >
            &times;
          </button>
        </div>
      </MergeZone>
    </div>
  );
}

// ─── Sortable Card within a Group ─────────────────────────────────────────────

interface SortableGroupCardProps {
  id: string;
  cardName: string;
  entryIndex: number;
  cardIndex: number;
  allEntries: QueueGroupEntry[];
  onReorder: (queue: QueueGroupEntry[]) => void;
  isTaken: boolean;
}

function SortableGroupCard({
  id,
  cardName,
  entryIndex,
  cardIndex,
  allEntries,
  onReorder,
  isTaken,
}: SortableGroupCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, data: { type: "card", entryIndex, cardIndex } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  function handleRemoveFromGroup() {
    const entry = allEntries[entryIndex];
    const newCards = entry.cards.filter((_, i) => i !== cardIndex);
    const newEntries =
      newCards.length === 0
        ? allEntries.filter((_, i) => i !== entryIndex)
        : allEntries.map((e, i) => (i === entryIndex ? { ...e, cards: newCards } : e));
    onReorder(newEntries);
  }

  return (
    <div
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
    </div>
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
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);
  const mergeTargetRef = useRef<number | null>(null);
  const [insertionIndex, _setInsertionIndex] = useState<number | null>(null);
  const insertionIndexRef = useRef<number | null>(null);
  function setInsertionIndex(v: number | null) {
    _setInsertionIndex(v);
    insertionIndexRef.current = v;
  }
  // Blue line within a group for card reorder
  const [cardInsertionInfo, setCardInsertionInfo] = useState<{ entryIndex: number; before: number } | null>(null);

  function updateMergeTarget(index: number | null) {
    setMergeTarget(index);
    mergeTargetRef.current = index;
  }

  // Hold-to-merge timer
  const MERGE_HOLD_MS = 500;
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverMergeIdRef = useRef<string | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverMergeIdRef.current = null;
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveDragId(event.active.id as string);
      updateMergeTarget(null);
      setInsertionIndex(null);
      setCardInsertionInfo(null);
      clearHoverTimer();
    },
    [clearHoverTimer],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      if (!event.over) {
        updateMergeTarget(null);
        setInsertionIndex(null);
        setCardInsertionInfo(null);
        clearHoverTimer();
        return;
      }

      const activeParsed = activeDragId ? parseId(activeDragId) : null;
      if (!activeParsed) return;
      const isDraggingEntry = activeParsed.type === "entry";
      const isDraggingCard = activeParsed.type === "card";

      const overIdStr = String(event.over.id);
      const overParsed = parseId(overIdStr);
      if (!overParsed) return;

      // ── Pointer is inside a merge: zone ──
      if (overParsed.type === "merge" && isDraggingEntry) {
        const targetIdx = overParsed.entryIndex;
        setCardInsertionInfo(null);
        if (targetIdx === activeParsed.entryIndex) {
          updateMergeTarget(null);
          setInsertionIndex(null);
          clearHoverTimer();
          return;
        }

        setInsertionIndex(null);

        // Start hold timer if not already running for this merge zone
        if (hoverMergeIdRef.current !== overIdStr) {
          clearHoverTimer();
          hoverMergeIdRef.current = overIdStr;
          hoverTimerRef.current = setTimeout(() => {
            updateMergeTarget(targetIdx);
          }, MERGE_HOLD_MS);
        }
        return;
      }

      // ── Pointer is over a sortable entry: (reorder) ──
      if (overParsed.type === "entry" && isDraggingEntry) {
        updateMergeTarget(null);
        setCardInsertionInfo(null);
        clearHoverTimer();

        const fromIdx = activeParsed.entryIndex;
        const toIdx = overParsed.entryIndex;
        if (fromIdx !== toIdx) {
          const insertion = toIdx > fromIdx ? toIdx + 1 : toIdx;
          setInsertionIndex(insertion);
        } else {
          setInsertionIndex(null);
        }
        return;
      }

      // ── Card being dragged ──
      if (isDraggingCard) {
        const overEntryIdx = overParsed.type === "entry"
          ? overParsed.entryIndex
          : overParsed.type === "card"
            ? overParsed.entryIndex
            : overParsed.type === "merge"
              ? overParsed.entryIndex
              : null;

        // Reorder within same group — show card insertion line
        if (
          overParsed.type === "card" &&
          overParsed.entryIndex === activeParsed.entryIndex
        ) {
          const from = activeParsed.cardIndex;
          const to = overParsed.cardIndex;
          const before = to > from ? to + 1 : to;
          setCardInsertionInfo({ entryIndex: activeParsed.entryIndex, before });
          setInsertionIndex(null);
          updateMergeTarget(null);
          clearHoverTimer();
          return;
        }

        setCardInsertionInfo(null);

        // Card dragged to a different entry (ungroup)
        // Use pointer position relative to `over` to decide before vs after
        if (overEntryIdx !== null && overEntryIdx !== activeParsed.entryIndex) {
          let insertAfter = false;
          const overRect = event.over?.rect;
          if (overRect && event.activatorEvent instanceof PointerEvent) {
            const pointerY = event.activatorEvent.clientY + (event.delta?.y ?? 0);
            const midY = overRect.top + overRect.height / 2;
            insertAfter = pointerY > midY;
          }
          const insertion = insertAfter ? overEntryIdx + 1 : overEntryIdx;
          setInsertionIndex(insertion);
        } else {
          setInsertionIndex(null);
        }
        updateMergeTarget(null);
        clearHoverTimer();
        return;
      }

      // Default
      updateMergeTarget(null);
      setInsertionIndex(null);
      clearHoverTimer();
    },
    [activeDragId, clearHoverTimer],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const currentMergeTarget = mergeTargetRef.current;
      const savedInsertionIndex = insertionIndexRef.current;
      setActiveDragId(null);
      updateMergeTarget(null);
      setInsertionIndex(null);
      setCardInsertionInfo(null);
      clearHoverTimer();

      const { active, over } = event;
      const activeParsed = parseId(active.id as string);
      if (!activeParsed) return;

      // ── Card dropped outside all droppables — ungroup it ──
      if (!over && activeParsed.type === "card") {
        const srcEntry = queue[activeParsed.entryIndex];
        if (srcEntry.cards.length <= 1) return; // already single, nothing to do
        const draggedCard = srcEntry.cards[activeParsed.cardIndex];
        const newSrcCards = srcEntry.cards.filter((_, i) => i !== activeParsed.cardIndex);
        const newQueue: QueueGroupEntry[] = queue.map((entry, i) => {
          if (i !== activeParsed.entryIndex) return entry;
          return { ...entry, cards: newSrcCards };
        });
        // Insert as new entry after the source group
        const newEntry: QueueGroupEntry = { mode: "pause", cards: [draggedCard] };
        newQueue.splice(activeParsed.entryIndex + 1, 0, newEntry);
        onReorder(newQueue);
        return;
      }

      if (!over || active.id === over.id) return;

      const overParsed = parseId(over.id as string);
      if (!overParsed) return;

      // ── Merge: entry into another (hold-to-merge was active) ──
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
        const adjustedTarget = fromIndex < toIndex ? toIndex - 1 : toIndex;
        const newQueue = queue
          .filter((_, i) => i !== fromIndex)
          .map((entry, i) => (i === adjustedTarget ? mergedEntry : entry));
        onReorder(newQueue);
        return;
      }

      // ── Drop on merge zone without hold completing — treat as reorder ──
      // Resolve merge: to the entry: it belongs to
      const resolvedOver = overParsed.type === "merge"
        ? { type: "entry" as const, entryIndex: overParsed.entryIndex }
        : overParsed;

      // ── Reorder top-level entries ──
      if (activeParsed.type === "entry" && resolvedOver.type === "entry") {
        const fromIndex = activeParsed.entryIndex;
        const toIndex = resolvedOver.entryIndex;
        if (fromIndex === toIndex) return;

        const newQueue = [...queue];
        const [moved] = newQueue.splice(fromIndex, 1);
        newQueue.splice(toIndex, 0, moved);
        onReorder(newQueue);
        return;
      }

      // ── Reorder cards within the same group ──
      if (
        activeParsed.type === "card" &&
        resolvedOver.type === "card" &&
        activeParsed.entryIndex === resolvedOver.entryIndex
      ) {
        const entryIndex = activeParsed.entryIndex;
        const fromCardIndex = activeParsed.cardIndex;
        const toCardIndex = resolvedOver.cardIndex;
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

      // ── Drag card out of group ──
      const resolvedEntryIdx = resolvedOver.type === "entry"
        ? resolvedOver.entryIndex
        : resolvedOver.type === "card"
          ? resolvedOver.entryIndex
          : null;

      if (
        activeParsed.type === "card" &&
        resolvedEntryIdx !== null &&
        resolvedEntryIdx !== activeParsed.entryIndex
      ) {
        const srcEntryIndex = activeParsed.entryIndex;
        const srcCardIndex = activeParsed.cardIndex;

        const srcEntry = queue[srcEntryIndex];
        const draggedCard = srcEntry.cards[srcCardIndex];
        const newSrcCards = srcEntry.cards.filter((_, i) => i !== srcCardIndex);

        let newQueue: QueueGroupEntry[] = queue.map((entry, i) => {
          if (i !== srcEntryIndex) return entry;
          return { ...entry, cards: newSrcCards };
        });

        if (newSrcCards.length === 0) {
          newQueue = newQueue.filter((_, i) => i !== srcEntryIndex);
        }

        // Use the insertion index from handleDragOver (accounts for pointer position)
        let targetIdx = savedInsertionIndex ?? resolvedEntryIdx;
        // Adjust for the source entry being removed or shrunk
        if (newSrcCards.length === 0 && srcEntryIndex < targetIdx) {
          targetIdx--;
        }
        targetIdx = Math.max(0, Math.min(targetIdx, newQueue.length));

        const newEntry: QueueGroupEntry = { mode: "pause", cards: [draggedCard] };
        newQueue.splice(targetIdx, 0, newEntry);
        onReorder(newQueue);
      }
    },
    [queue, onReorder, clearHoverTimer],
  );

  const entryIds = queue.map((_, i) => makeEntryId(i));

  // Derive overlay label
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
      <div className="mb-2 text-[13px] font-semibold tracking-tight text-zinc-200">
        Pick Queue
      </div>

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

      {queue.length === 0 ? (
        <div className="py-5 text-center text-xs text-zinc-600">
          Queue is empty. Add cards from the card table.
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={mergeAwareCollision}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
            <div className="flex max-h-[30vh] flex-col gap-1 overflow-y-auto">
              {queue.map((entry, entryIndex) => (
                <div key={makeEntryId(entryIndex)}>
                  {insertionIndex === entryIndex && <InsertionLine />}
                  <SortableEntry
                    id={makeEntryId(entryIndex)}
                    entry={entry}
                    entryIndex={entryIndex}
                    allEntries={queue}
                    onRemove={onRemove}
                    onSetEntryMode={onSetEntryMode}
                    onReorder={onReorder}
                    takenCards={takenCards}
                    isMergeTarget={mergeTarget === entryIndex}
                    cardInsertionBefore={cardInsertionInfo?.entryIndex === entryIndex ? cardInsertionInfo.before : null}
                  />
                </div>
              ))}
              {insertionIndex === queue.length && <InsertionLine />}
            </div>
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
