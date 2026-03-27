"use client";

import Image from "next/image";
import type { EnrichedCardStats } from "@/core/types";
import { CardStatusIcon, type CardStatus } from "./CardStatusIcon";

interface CardNameCellProps {
  card: EnrichedCardStats;
  cubeCopies?: number;
  cardStatus: CardStatus;
  queuePosition?: number;
}

export function CardNameCell({
  card, cubeCopies, cardStatus, queuePosition,
}: CardNameCellProps) {
  const imageUri = card.scryfall?.imageUri;

  return (
    <div className="min-w-0">
      <div className="flex cursor-pointer items-center gap-2 min-w-0">
        {imageUri && (
          <Image
            src={imageUri}
            alt={card.cardName}
            width={32}
            height={45}
            className="shrink-0 rounded-sm object-cover shadow-sm"
          />
        )}
        <span className="min-w-0 flex-1 font-medium text-zinc-900 dark:text-zinc-100">{card.cardName}</span>
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
            className="shrink-0 rounded bg-purple-100 px-1 py-0.5 text-[10px] leading-none text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
            title={`${cubeCopies} copies in the cube`}
          >
            ×{cubeCopies}
          </span>
        )}
        {/* Status icon */}
        <CardStatusIcon status={cardStatus} queuePosition={queuePosition} />
      </div>
    </div>
  );
}
