"use client";

import type { EnrichedCardStats } from "@/core/types";
import { CardStatusIcon, type CardStatus } from "./CardStatusIcon";

interface CardNameCellProps {
  card: EnrichedCardStats;
  cubeCopies?: number;
  remainingCopies?: number;
  cardStatus: CardStatus;
  queuePosition?: number;
}

export function CardNameCell({
  card,
  cubeCopies,
  remainingCopies,
  cardStatus,
  queuePosition,
}: CardNameCellProps) {
  const imageUri = card.scryfall?.imageUri;
  const accentColor = cardStatus === "picked" ? "rgb(16 185 129)" : undefined;

  return (
    <div
      className="min-w-0"
      style={accentColor ? { borderLeft: `4px solid ${accentColor}`, paddingLeft: 8 } : undefined}
    >
      <div className="flex min-w-0 cursor-pointer items-center gap-2">
        {imageUri && (
          <img
            src={imageUri}
            alt={card.cardName}
            width={32}
            height={45}
            loading="lazy"
            className="shrink-0 rounded-sm object-cover shadow-sm"
          />
        )}
        <span className="min-w-0 flex-1 font-medium text-zinc-900 dark:text-zinc-100">
          {card.cardName}
        </span>
        {/* Note indicators */}
        {card.timesAvailable === 1 && (
          <span
            className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[10px] leading-none text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            title="Only appeared in 1 draft — low confidence"
          >
            1d
          </span>
        )}
        {(cubeCopies ?? 1) >= 2 && (
          <span
            className={`shrink-0 rounded px-1 py-0.5 text-[10px] leading-none ${
              remainingCopies !== undefined
                ? remainingCopies > 0
                  ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                  : "bg-zinc-200 text-zinc-500 dark:bg-zinc-700/40 dark:text-zinc-500"
                : "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
            }`}
            title={
              remainingCopies !== undefined
                ? `${remainingCopies} of ${cubeCopies} copies remaining`
                : `${cubeCopies} copies in the cube`
            }
          >
            {remainingCopies !== undefined ? `${remainingCopies}/${cubeCopies}` : `×${cubeCopies}`}
          </span>
        )}
        {/* Status icon */}
        <CardStatusIcon status={cardStatus} queuePosition={queuePosition} />
      </div>
    </div>
  );
}
