"use client";

import { useState, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
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
//
// Drag-and-drop reorders top-level entries only. Grouping/ungrouping are done
// with buttons, never drag.
//   "drag-entry:<i>" — dragging entry i
//   "slot:<i>"       — drop slot before entry i (slot:N = after the last entry)

function makeDragEntryId(i: number) { return `drag-entry:${i}`; }
function makeSlotId(i: number) { return `slot:${i}`; }

function parseDragEntryIndex(id: string): number | null {
  const p = id.split(":");
  return p[0] === "drag-entry" ? +p[1] : null;
}
function parseSlotIndex(id: string): number | null {
  const p = id.split(":");
  return p[0] === "slot" ? +p[1] : null;
}

/**
 * Move entry `from` to drop-slot `slot` (slot N = before entry N; slot ===
 * queue.length = after the last entry). Returns the reordered queue, or null
 * when the move is a no-op (dropping back into the same position).
 */
export function reorderEntryToSlot(
  queue: QueueGroupEntry[],
  from: number,
  slot: number,
): QueueGroupEntry[] | null {
  if (slot === from || slot === from + 1) return null;
  const newQueue = [...queue];
  const [moved] = newQueue.splice(from, 1);
  const to = slot > from ? slot - 1 : slot;
  newQueue.splice(to, 0, moved);
  return newQueue;
}

// ─── Visual components ───────────────────────────────────────────────────────

// Drop slot between entries. Has a small physical height so closestCenter can
// target it; shows a blue insertion line when active.
function DropSlot({ id, isActive }: { id: string; isActive: boolean }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`flex items-center ${isActive ? "py-0.5" : "min-h-[6px]"}`}>
      {isActive && <div className="h-0.5 w-full rounded-full bg-blue-500" />}
    </div>
  );
}

// Up/down buttons for reordering cards within a group.
function MoveButtons({
  onUp, onDown, disableUp, disableDown,
}: {
  onUp: () => void;
  onDown: () => void;
  disableUp: boolean;
  disableDown: boolean;
}) {
  return (
    <div className="flex flex-col">
      <button
        onClick={onUp}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={disableUp}
        aria-label="Move up"
        className={`border-none bg-transparent px-1.5 py-0.5 sm:px-1 sm:py-0 text-base sm:text-xs leading-none transition-colors ${
          disableUp ? "cursor-default text-zinc-800" : "cursor-pointer text-zinc-500 hover:text-zinc-300"
        }`}
      >
        ▲
      </button>
      <button
        onClick={onDown}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={disableDown}
        aria-label="Move down"
        className={`border-none bg-transparent px-1.5 py-0.5 sm:px-1 sm:py-0 text-base sm:text-xs leading-none transition-colors ${
          disableDown ? "cursor-default text-zinc-800" : "cursor-pointer text-zinc-500 hover:text-zinc-300"
        }`}
      >
        ▼
      </button>
    </div>
  );
}

// Merges this entry with the entry directly above it. Disabled on the first entry.
function GroupButton({ onGroup, disabled }: { onGroup: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onGroup}
      onPointerDown={(e) => e.stopPropagation()}
      disabled={disabled}
      aria-label="Group with card above"
      title="Group with the card above — auto-pick takes any one of a group"
      className={`border-none bg-transparent px-2 py-1.5 sm:px-1 sm:py-0.5 text-base sm:text-sm leading-none transition-colors ${
        disabled ? "cursor-default text-zinc-800" : "cursor-pointer text-zinc-500 hover:text-zinc-300"
      }`}
    >
      ⧉
    </button>
  );
}

// ─── Draggable Entry ─────────────────────────────────────────────────────────

interface DraggableEntryProps {
  entry: QueueGroupEntry;
  entryIndex: number;
  onRemove: (cardName: string) => void;
  onSetEntryMode: (entryIndex: number, mode: "pause" | "flow-through") => void;
  onMoveCard: (entryIndex: number, fromCard: number, toCard: number) => void;
  onGroupWithAbove: (entryIndex: number) => void;
  onEject: (entryIndex: number, cardIndex: number) => void;
  takenCards: Set<string>;
}

function DraggableEntry({
  entry,
  entryIndex,
  onRemove,
  onSetEntryMode,
  onMoveCard,
  onGroupWithAbove,
  onEject,
  takenCards,
}: DraggableEntryProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: makeDragEntryId(entryIndex) });

  const isGroup = entry.cards.length > 1;
  const allTaken = entry.cards.every((c) => takenCards.has(c.cardName));
  const isPause = entry.mode === "pause";

  const modeToggle = (
    <button
      onClick={() => onSetEntryMode(entryIndex, isPause ? "flow-through" : "pause")}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={`Mode: ${entry.mode}`}
      title={isPause ? "Currently set to Pause — stops if top card taken" : "Currently set to Flow-through — skips taken cards"}
      className={`rounded px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 text-sm sm:text-[10px] font-semibold leading-none transition-colors cursor-pointer border-none ${
        isPause
          ? "bg-blue-900/50 text-blue-300 hover:bg-blue-800/60"
          : "bg-amber-900/50 text-amber-300 hover:bg-amber-800/60"
      }`}
    >
      {isPause ? "⏸" : "▶"}
    </button>
  );

  const groupButton = (
    <GroupButton onGroup={() => onGroupWithAbove(entryIndex)} disabled={entryIndex === 0} />
  );

  if (isGroup) {
    return (
      <div ref={setNodeRef} style={{ opacity: isDragging ? 0.3 : 1 }} {...attributes} {...listeners} className="select-none">
        <div className={`cursor-grab rounded px-2 py-2.5 sm:py-1.5 text-sm sm:text-xs border border-zinc-700/60 bg-zinc-800/50 ${allTaken ? "opacity-40" : ""}`}>
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-600 select-none">⠿</span>
            <span className="flex-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Group ({entry.cards.length})
            </span>
            {groupButton}
            {modeToggle}
          </div>
          <div className="mt-1.5 flex flex-col pl-4">
            {entry.cards.map((card, cardIndex) => (
              <GroupCard
                key={`${card.cardId}-${cardIndex}`}
                cardName={card.cardName}
                entryIndex={entryIndex}
                cardIndex={cardIndex}
                totalCards={entry.cards.length}
                isTaken={takenCards.has(card.cardName)}
                onRemove={onRemove}
                onMoveCard={onMoveCard}
                onEject={onEject}
              />
            ))}
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
      <div className="flex items-center gap-1.5 cursor-grab rounded px-2 py-2.5 sm:py-1 text-sm sm:text-xs border border-transparent bg-zinc-800/30">
        <span className="text-zinc-600 select-none">⠿</span>
        <span className={`flex-1 ${isTaken ? "text-zinc-600 line-through" : "text-zinc-300"}`}>
          {card.cardName}
        </span>
        {groupButton}
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
  );
}

// ─── Card within a Group (not draggable) ──────────────────────────────────────

interface GroupCardProps {
  cardName: string;
  entryIndex: number;
  cardIndex: number;
  totalCards: number;
  isTaken: boolean;
  onRemove: (cardName: string) => void;
  onMoveCard: (entryIndex: number, fromCard: number, toCard: number) => void;
  onEject: (entryIndex: number, cardIndex: number) => void;
}

function GroupCard({
  cardName,
  entryIndex,
  cardIndex,
  totalCards,
  isTaken,
  onRemove,
  onMoveCard,
  onEject,
}: GroupCardProps) {
  return (
    <div className="flex items-center gap-1.5 select-none rounded px-1 py-1.5 sm:py-0.5">
      <span className={`flex-1 text-xs ${isTaken ? "text-zinc-600 line-through" : "text-zinc-400"}`}>
        {cardName}
      </span>
      <MoveButtons
        onUp={() => onMoveCard(entryIndex, cardIndex, cardIndex - 1)}
        onDown={() => onMoveCard(entryIndex, cardIndex, cardIndex + 1)}
        disableUp={cardIndex === 0}
        disableDown={cardIndex === totalCards - 1}
      />
      <button
        onClick={() => onEject(entryIndex, cardIndex)}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={`Ungroup ${cardName}`}
        title="Remove from group (keep in queue on its own)"
        className="cursor-pointer border-none bg-transparent px-2 py-1.5 sm:px-1 sm:py-0.5 text-base sm:text-xs leading-none text-zinc-600 hover:text-zinc-300"
      >
        ⏏
      </button>
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

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 500, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
    setActiveSlotId(null);
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setActiveSlotId(event.over ? String(event.over.id) : null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const slotId = activeSlotId;
      setActiveDragId(null);
      setActiveSlotId(null);

      const from = parseDragEntryIndex(event.active.id as string);
      if (from === null || !slotId) return;
      const slot = parseSlotIndex(slotId);
      if (slot === null) return;

      const newQueue = reorderEntryToSlot(queue, from, slot);
      if (newQueue) onReorder(newQueue);
    },
    [queue, onReorder, activeSlotId],
  );

  const handleMoveCard = useCallback(
    (entryIndex: number, from: number, to: number) => {
      const entry = queue[entryIndex];
      if (!entry || to < 0 || to >= entry.cards.length) return;
      const newCards = [...entry.cards];
      const [moved] = newCards.splice(from, 1);
      newCards.splice(to, 0, moved);
      onReorder(queue.map((e, i) => (i === entryIndex ? { ...e, cards: newCards } : e)));
    },
    [queue, onReorder],
  );

  // Merge entry[entryIndex] into the entry directly above it. The combined
  // group keeps the upper entry's mode, with its cards first.
  const handleGroupWithAbove = useCallback(
    (entryIndex: number) => {
      if (entryIndex <= 0 || entryIndex >= queue.length) return;
      const upper = queue[entryIndex - 1];
      const lower = queue[entryIndex];
      const merged: QueueGroupEntry = { mode: upper.mode, cards: [...upper.cards, ...lower.cards] };
      const newQueue = queue
        .filter((_, i) => i !== entryIndex)
        .map((e, i) => (i === entryIndex - 1 ? merged : e));
      onReorder(newQueue);
    },
    [queue, onReorder],
  );

  // Pull a card out of its group into its own entry, placed right after the
  // group. If the group drops to one card it becomes a single entry.
  const handleEject = useCallback(
    (entryIndex: number, cardIndex: number) => {
      const entry = queue[entryIndex];
      if (!entry || entry.cards.length <= 1) return;
      const ejected = entry.cards[cardIndex];
      const remaining = entry.cards.filter((_, i) => i !== cardIndex);
      const newQueue = [...queue];
      newQueue[entryIndex] = { ...entry, cards: remaining };
      newQueue.splice(entryIndex + 1, 0, { mode: "pause", cards: [ejected] });
      onReorder(newQueue);
    },
    [queue, onReorder],
  );

  // Derive the drag overlay label
  let overlayLabel: string | null = null;
  const draggingIndex = activeDragId ? parseDragEntryIndex(activeDragId) : null;
  if (draggingIndex !== null) {
    const entry = queue[draggingIndex];
    if (entry) overlayLabel = entry.cards.length === 1 ? entry.cards[0].cardName : `Group (${entry.cards.length})`;
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
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex max-h-[30vh] flex-col overflow-y-auto pb-2">
            {queue.map((entry, entryIndex) => (
              <div key={`entry-${entryIndex}`}>
                <DropSlot id={makeSlotId(entryIndex)} isActive={activeSlotId === makeSlotId(entryIndex)} />
                <DraggableEntry
                  entry={entry}
                  entryIndex={entryIndex}
                  onRemove={onRemove}
                  onSetEntryMode={onSetEntryMode}
                  onMoveCard={handleMoveCard}
                  onGroupWithAbove={handleGroupWithAbove}
                  onEject={handleEject}
                  takenCards={takenCards}
                />
              </div>
            ))}
            <DropSlot id={makeSlotId(queue.length)} isActive={activeSlotId === makeSlotId(queue.length)} />
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
