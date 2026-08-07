"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { DeckCard } from "./DeckCard";
import type { ScryCard, CardStats } from "@/core/types";
import type { WorthCard } from "@/core/worthModel";
import { BASIC_LAND_IMAGES } from "./basicLandImages";

interface DeckColumnProps {
  columnKey: string;
  label: string;
  cardNames: string[];
  zone: "deck" | "sideboard";
  scryfallData: Map<string, ScryCard>;
  cardStats: Map<string, CardStats>;
  worthCards: Map<string, WorthCard>;
  floatedIndices: Set<string>;
  queuedIndices: Set<string>;
  onRemoveFloat?: (cardName: string) => void;
  onToggleQueue?: (cardName: string) => void;
  /** Let the card box grow to whatever height the layout gives the column,
   *  instead of hugging its contents. Used by the maindeck lands column, which
   *  stands beside two rows of mana-value columns. */
  fillHeight?: boolean;
}

export function DeckColumn({
  columnKey,
  label,
  cardNames,
  zone,
  scryfallData,
  cardStats,
  worthCards,
  floatedIndices,
  queuedIndices,
  onRemoveFloat,
  onToggleQueue,
  fillHeight = false,
}: DeckColumnProps) {
  const droppableId = `${zone}:${columnKey}`;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  const sortableIds = cardNames.map(
    (name, idx) => `${zone}:${columnKey}:${idx}:${name}`
  );

  return (
    <div className={`flex flex-col ${fillHeight ? "flex-1" : ""}`}>
      <div className="mb-1.5 flex items-baseline justify-center gap-1 text-[11px]">
        <span className="font-semibold text-zinc-400">
          {label}
        </span>
        <span className="font-mono text-zinc-500/80">
          ({cardNames.length})
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[48px] flex-col rounded-md p-1 transition-colors ${
          fillHeight ? "flex-1" : ""
        } ${
          isOver
            ? "bg-blue-500/15 ring-1 ring-blue-400/40"
            : "bg-zinc-800/40 ring-1 ring-zinc-800/60"
        }`}
      >
        <SortableContext
          items={sortableIds}
          strategy={verticalListSortingStrategy}
        >
          {cardNames.map((name, idx) => {
            const scryfall = scryfallData.get(name);
            const imageUri = scryfall?.imageUri ?? BASIC_LAND_IMAGES[name];
            const stats = cardStats.get(name);
            const worthCard = worthCards.get(name);
            const showWorth = worthCard != null && !worthCard.no_data;
            return (
              <DeckCard
                key={`${zone}:${columnKey}:${idx}:${name}`}
                id={`${zone}:${columnKey}:${idx}:${name}`}
                cardName={name}
                imageUri={imageUri}
                isFloated={floatedIndices.has(`${columnKey}:${idx}`)}
                isQueued={queuedIndices.has(`${columnKey}:${idx}`)}
                isLast={idx === cardNames.length - 1}
                onRemoveFloat={onRemoveFloat}
                onToggleQueue={onToggleQueue}
                pickScore={stats?.weightedGeomean}
                gpwr={stats?.gpwr}
                gpwrCi={stats?.gpwrCi}
                worth={showWorth ? worthCard.worth ?? undefined : undefined}
              />
            );
          })}
        </SortableContext>
      </div>
    </div>
  );
}
