"use client";

import { useState, useRef } from "react";
import { createPortal } from "react-dom";
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
  const [showImage, setShowImage] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const cellRef = useRef<HTMLDivElement>(null);
  const imageUri = card.scryfall?.imageUri;

  const handleMouseEnter = () => {
    if (cellRef.current) {
      const rect = cellRef.current.getBoundingClientRect();
      const left = Math.min(rect.right + 8, window.innerWidth - 340);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 480));
      setPosition({ top, left });
    }
    setShowImage(true);
  };

  return (
    <div className="relative group/row min-w-0" ref={cellRef}>
      <div
        className="flex cursor-pointer items-center gap-2 min-w-0"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setShowImage(false)}
      >
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

      {showImage && imageUri && createPortal(
        <div className="fixed z-[9999] pointer-events-none" style={{ top: position.top, left: position.left }}>
          <Image
            src={imageUri}
            alt={card.cardName}
            width={320}
            height={448}
            className="rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-800"
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
