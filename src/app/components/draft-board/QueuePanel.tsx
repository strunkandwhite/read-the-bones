"use client";

import { useState, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
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

// Draggable IDs:
//   "drag-entry:<i>"        — dragging a top-level entry
//   "drag-card:<i>:<j>"     — dragging a card within a group
//
// Droppable IDs (slots between items where things can be inserted):
//   "slot:<i>"              — drop slot before entry i (slot:N = after last entry)
//   "cardslot:<i>:<j>"      — drop slot before card j in entry i
//   "merge:<i>"             — merge zone (entire entry body)

function makeDragEntryId(i: number) { return `drag-entry:${i}`; }
function makeDragCardId(i: number, j: number) { return `drag-card:${i}:${j}`; }
function makeSlotId(i: number) { return `slot:${i}`; }
function makeCardSlotId(i: number, j: number) { return `cardslot:${i}:${j}`; }
function makeMergeId(i: number) { return `merge:${i}`; }

type DragId =
  | { kind: "entry"; entryIndex: number }
  | { kind: "card"; entryIndex: number; cardIndex: number };

type DropId =
  | { kind: "slot"; index: number }
  | { kind: "cardslot"; entryIndex: number; cardIndex: number }
  | { kind: "merge"; entryIndex: number };

function parseDragId(id: string): DragId | null {
  const p = id.split(":");
  if (p[0] === "drag-entry") return { kind: "entry", entryIndex: +p[1] };
  if (p[0] === "drag-card") return { kind: "card", entryIndex: +p[1], cardIndex: +p[2] };
  return null;
}

function parseDropId(id: string): DropId | null {
  const p = id.split(":");
  if (p[0] === "slot") return { kind: "slot", index: +p[1] };
  if (p[0] === "cardslot") return { kind: "cardslot", entryIndex: +p[1], cardIndex: +p[2] };
  if (p[0] === "merge") return { kind: "merge", entryIndex: +p[1] };
  return null;
}

// ─── Custom collision detection ──────────────────────────────────────────────

const slotAwareCollision: CollisionDetection = (args) => {
  const active = parseDragId(String(args.active.id));
  const isDraggingEntry = active?.kind === "entry";

  // 1. Check merge zones first — but only when dragging an entry (not a card)
  if (isDraggingEntry) {
    const mergeContainers = args.droppableContainers.filter(
      ({ id }) => String(id).startsWith("merge:"),
    );
    const mergeHits = pointerWithin({ ...args, droppableContainers: mergeContainers });
    if (mergeHits.length > 0) return mergeHits;
  }

  // 2. Check all slots and cardslots
  const slotContainers = args.droppableContainers.filter(({ id }) => {
    const s = String(id);
    return s.startsWith("slot:") || s.startsWith("cardslot:");
  });
  return closestCenter({ ...args, droppableContainers: slotContainers });
};

// ─── Visual components ───────────────────────────────────────────────────────

// Drop slot between items. Has a small physical height so closestCenter can target it.
// When active (being hovered), shows a blue insertion line.
function DropSlot({ id, isActive }: { id: string; isActive: boolean }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center ${isActive ? "py-0.5" : "min-h-[6px]"}`}
    >
      {isActive && (
        <div className="h-0.5 w-full rounded-full bg-blue-500" />
      )}
    </div>
  );
}

// ─── Draggable Entry ─────────────────────────────────────────────────────────

interface DraggableEntryProps {
  entry: QueueGroupEntry;
  entryIndex: number;
  onRemove: (cardName: string) => void;
  onSetEntryMode: (entryIndex: number, mode: "pause" | "flow-through") => void;
  takenCards: Set<string>;
  isMergeTarget: boolean;
  activeSlotId: string | null;
}

function DraggableEntry({
  entry,
  entryIndex,
  onRemove,
  onSetEntryMode,
  takenCards,
  isMergeTarget,
  activeSlotId,
}: DraggableEntryProps) {
  const dragId = makeDragEntryId(entryIndex);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: dragId });
  const { setNodeRef: setMergeRef } = useDroppable({ id: makeMergeId(entryIndex) });

  const isGroup = entry.cards.length > 1;
  const allTaken = entry.cards.every((c) => takenCards.has(c.cardName));
  const isPause = entry.mode === "pause";

  const modeToggle = (
    <button
      onClick={() => onSetEntryMode(entryIndex, isPause ? "flow-through" : "pause")}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={`Mode: ${entry.mode}`}
      title={isPause ? "Currently set to Pause: stops here if top card taken" : "Currently set to Flow-through: skips taken cards"}
      className={`rounded px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 text-sm sm:text-[10px] font-semibold leading-none transition-colors cursor-pointer border-none ${
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

  if (isGroup) {
    return (
      <div ref={setNodeRef} style={{ opacity: isDragging ? 0.3 : 1 }} {...attributes} {...listeners} className="select-none">
        <div ref={setMergeRef}>
          <div
            className={`cursor-grab rounded px-2 py-2.5 sm:py-1.5 text-sm sm:text-xs transition-colors ${
              mergeStyle || "border border-zinc-700/60 bg-zinc-800/50"
            } ${allTaken ? "opacity-40" : ""}`}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-600 select-none">
                ⠿
              </span>
              <span className="flex-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                Group ({entry.cards.length})
              </span>
              {modeToggle}
            </div>
            <div className="mt-1.5 flex flex-col pl-4">
              {entry.cards.map((card, cardIndex) => (
                <div key={`${card.cardId}-${cardIndex}`}>
                  <DropSlot
                    id={makeCardSlotId(entryIndex, cardIndex)}
                    isActive={activeSlotId === makeCardSlotId(entryIndex, cardIndex)}
                  />
                  <DraggableGroupCard
                    cardName={card.cardName}
                    entryIndex={entryIndex}
                    cardIndex={cardIndex}
                    isTaken={takenCards.has(card.cardName)}
                    onRemove={onRemove}
                  />
                </div>
              ))}
              <DropSlot
                id={makeCardSlotId(entryIndex, entry.cards.length)}
                isActive={activeSlotId === makeCardSlotId(entryIndex, entry.cards.length)}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Single-card entry
  const card = entry.cards[0];
  const isTaken = takenCards.has(card.cardName);

  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.3 : 1 }} {...attributes} {...listeners} className="select-none">
      <div ref={setMergeRef}>
        <div
          className={`flex items-center gap-1.5 cursor-grab rounded px-2 py-2.5 sm:py-1 text-sm sm:text-xs transition-colors ${
            mergeStyle || "border border-transparent bg-zinc-800/30"
          }`}
        >
          <span className="text-zinc-600 select-none">
            ⠿
          </span>
          <span className={`flex-1 ${isTaken ? "text-zinc-600 line-through" : "text-zinc-300"}`}>
            {card.cardName}
          </span>
          {modeToggle}
          <button
            onClick={() => onRemove(card.cardName)}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Remove ${card.cardName}`}
            className="cursor-pointer border-none bg-transparent px-2.5 py-1.5 sm:px-1 sm:py-0.5 text-lg sm:text-sm leading-none text-zinc-500 hover:text-zinc-300"
          >
            &times;
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Draggable Card within a Group ───────────────────────────────────────────

interface DraggableGroupCardProps {
  cardName: string;
  entryIndex: number;
  cardIndex: number;
  isTaken: boolean;
  onRemove: (cardName: string) => void;
}

function DraggableGroupCard({
  cardName,
  entryIndex,
  cardIndex,
  isTaken,
  onRemove,
}: DraggableGroupCardProps) {
  const dragId = makeDragCardId(entryIndex, cardIndex);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: dragId });

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.3 : 1 }}
      className="flex items-center gap-1.5 cursor-grab select-none rounded px-1 py-1.5 sm:py-0.5"
      {...attributes}
      {...listeners}
    >
      <span className="text-zinc-700 select-none text-[10px]">
        ⠿
      </span>
      <span className={`flex-1 text-xs ${isTaken ? "text-zinc-600 line-through" : "text-zinc-400"}`}>
        {cardName}
      </span>
      <button
        onClick={() => onRemove(cardName)}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={`Remove ${cardName}`}
        className="cursor-pointer border-none bg-transparent px-2.5 py-1.5 sm:px-1 sm:py-0.5 text-lg sm:text-sm leading-none text-zinc-600 hover:text-zinc-300"
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
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);
  const mergeTargetRef = useRef<number | null>(null);
  const activeSlotRef = useRef<string | null>(null);

  function updateMergeTarget(v: number | null) {
    setMergeTarget(v);
    mergeTargetRef.current = v;
  }
  function updateActiveSlot(v: string | null) {
    setActiveSlotId(v);
    activeSlotRef.current = v;
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
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 500, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveDragId(event.active.id as string);
      updateActiveSlot(null);
      updateMergeTarget(null);
      clearHoverTimer();
      // Haptic feedback on mobile when drag activates
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(10);
      }
    },
    [clearHoverTimer],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      if (!event.over) {
        updateActiveSlot(null);
        updateMergeTarget(null);
        clearHoverTimer();
        return;
      }

      const active = activeDragId ? parseDragId(activeDragId) : null;
      if (!active) return;

      const overId = String(event.over.id);
      const over = parseDropId(overId);
      if (!over) return;

      // ── Over a merge zone (entry dragged over another entry) ──
      if (over.kind === "merge" && active.kind === "entry") {
        if (over.entryIndex === active.entryIndex) {
          updateActiveSlot(null);
          updateMergeTarget(null);
          clearHoverTimer();
          return;
        }
        updateActiveSlot(null);
        if (hoverMergeIdRef.current !== overId) {
          clearHoverTimer();
          hoverMergeIdRef.current = overId;
          const idx = over.entryIndex;
          hoverTimerRef.current = setTimeout(() => {
            updateMergeTarget(idx);
          }, MERGE_HOLD_MS);
        }
        return;
      }

      // ── Over a slot or cardslot ──
      if (over.kind === "slot" || over.kind === "cardslot") {
        // Don't show slot indicators while merge is active
        if (mergeTargetRef.current !== null) return;

        // For card drags: skip cardslots in the same group as the dragged card
        // (they'll still show — we want within-group reorder)
        updateActiveSlot(overId);
        updateMergeTarget(null);
        clearHoverTimer();
        return;
      }

      // Default
      updateActiveSlot(null);
      updateMergeTarget(null);
      clearHoverTimer();
    },
    [activeDragId, clearHoverTimer],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const currentMergeTarget = mergeTargetRef.current;
      const currentSlot = activeSlotRef.current;
      setActiveDragId(null);
      updateActiveSlot(null);
      updateMergeTarget(null);
      clearHoverTimer();

      const { active: activeEvt } = event;
      const active = parseDragId(activeEvt.id as string);
      if (!active) return;

      // ── Merge (hold-to-merge was active) ──
      if (active.kind === "entry" && currentMergeTarget !== null) {
        const from = active.entryIndex;
        const to = currentMergeTarget;
        if (from === to) return;

        const draggedEntry = queue[from];
        const targetEntry = queue[to];
        const merged: QueueGroupEntry = {
          mode: targetEntry.mode,
          cards: [...targetEntry.cards, ...draggedEntry.cards],
        };
        const adjusted = from < to ? to - 1 : to;
        const newQueue = queue
          .filter((_, i) => i !== from)
          .map((e, i) => (i === adjusted ? merged : e));
        onReorder(newQueue);
        return;
      }

      // ── Drop on a slot ──
      if (currentSlot) {
        const slot = parseDropId(currentSlot);
        if (!slot) return;

        // Entry dropped on a top-level slot → reorder
        if (active.kind === "entry" && slot.kind === "slot") {
          const from = active.entryIndex;
          let to = slot.index;
          if (to === from || to === from + 1) return; // no-op: same position
          const newQueue = [...queue];
          const [moved] = newQueue.splice(from, 1);
          if (to > from) to--;
          newQueue.splice(to, 0, moved);
          onReorder(newQueue);
          return;
        }

        // Card dropped on a top-level slot → ungroup
        if (active.kind === "card" && slot.kind === "slot") {
          const srcEntry = queue[active.entryIndex];
          if (srcEntry.cards.length <= 1) return;
          const draggedCard = srcEntry.cards[active.cardIndex];
          const newSrcCards = srcEntry.cards.filter((_, i) => i !== active.cardIndex);

          let newQueue: QueueGroupEntry[] = queue.map((e, i) =>
            i === active.entryIndex ? { ...e, cards: newSrcCards } : e,
          );

          let to = slot.index;
          // Only adjust if source entry was completely removed
          if (newSrcCards.length === 0) {
            newQueue = newQueue.filter((_, i) => i !== active.entryIndex);
            if (active.entryIndex < to) to--;
          }
          to = Math.max(0, Math.min(to, newQueue.length));

          newQueue.splice(to, 0, { mode: "pause", cards: [draggedCard] });
          onReorder(newQueue);
          return;
        }

        // Card dropped on a cardslot in the SAME group → reorder within group
        if (
          active.kind === "card" &&
          slot.kind === "cardslot" &&
          slot.entryIndex === active.entryIndex
        ) {
          const from = active.cardIndex;
          let to = slot.cardIndex;
          if (to === from || to === from + 1) return; // no-op
          const entry = queue[active.entryIndex];
          const newCards = [...entry.cards];
          const [moved] = newCards.splice(from, 1);
          if (to > from) to--;
          newCards.splice(to, 0, moved);
          const newQueue = queue.map((e, i) =>
            i === active.entryIndex ? { ...e, cards: newCards } : e,
          );
          onReorder(newQueue);
          return;
        }

        // Card dropped on a cardslot in a DIFFERENT group → move between groups
        if (
          active.kind === "card" &&
          slot.kind === "cardslot" &&
          slot.entryIndex !== active.entryIndex
        ) {
          const srcEntry = queue[active.entryIndex];
          const draggedCard = srcEntry.cards[active.cardIndex];
          const newSrcCards = srcEntry.cards.filter((_, i) => i !== active.cardIndex);

          let newQueue: QueueGroupEntry[] = queue.map((e, i) => {
            if (i === active.entryIndex) return { ...e, cards: newSrcCards };
            return e;
          });

          if (newSrcCards.length === 0) {
            newQueue = newQueue.filter((_, i) => i !== active.entryIndex);
          }

          // Find the target entry (index may have shifted if source was removed)
          let targetEntryIdx = slot.entryIndex;
          if (newSrcCards.length === 0 && active.entryIndex < slot.entryIndex) {
            targetEntryIdx--;
          }
          const targetEntry = newQueue[targetEntryIdx];
          if (!targetEntry) return;

          const insertAt = Math.min(slot.cardIndex, targetEntry.cards.length);
          const newCards = [...targetEntry.cards];
          newCards.splice(insertAt, 0, draggedCard);
          newQueue = newQueue.map((e, i) =>
            i === targetEntryIdx ? { ...e, cards: newCards } : e,
          );
          onReorder(newQueue);
          return;
        }

        // Entry dropped on a cardslot → treat as reorder to that entry's position
        if (active.kind === "entry" && slot.kind === "cardslot") {
          const from = active.entryIndex;
          let to = slot.entryIndex;
          if (to === from) return;
          const newQueue = [...queue];
          const [moved] = newQueue.splice(from, 1);
          if (to > from) to--;
          newQueue.splice(to, 0, moved);
          onReorder(newQueue);
          return;
        }
      }
    },
    [queue, onReorder, clearHoverTimer],
  );

  // Derive overlay label
  const active = activeDragId ? parseDragId(activeDragId) : null;
  let overlayLabel: string | null = null;
  if (active) {
    if (active.kind === "entry") {
      const entry = queue[active.entryIndex];
      if (entry) {
        overlayLabel = entry.cards.length === 1
          ? entry.cards[0].cardName
          : `Group (${entry.cards.length})`;
      }
    } else if (active.kind === "card") {
      const entry = queue[active.entryIndex];
      if (entry) overlayLabel = entry.cards[active.cardIndex]?.cardName ?? null;
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
          collisionDetection={slotAwareCollision}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex max-h-[30vh] flex-col overflow-y-auto pb-2">
            {queue.map((entry, entryIndex) => (
              <div key={`entry-${entryIndex}`}>
                <DropSlot
                  id={makeSlotId(entryIndex)}
                  isActive={activeSlotId === makeSlotId(entryIndex)}
                />
                <DraggableEntry
                  entry={entry}
                  entryIndex={entryIndex}
                  onRemove={onRemove}
                  onSetEntryMode={onSetEntryMode}
                  takenCards={takenCards}
                  isMergeTarget={mergeTarget === entryIndex}
                  activeSlotId={activeSlotId}
                />
              </div>
            ))}
            <DropSlot
              id={makeSlotId(queue.length)}
              isActive={activeSlotId === makeSlotId(queue.length)}
            />
          </div>

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
