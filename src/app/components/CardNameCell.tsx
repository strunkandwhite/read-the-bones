"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import type { EnrichedCardStats } from "@/core/types";

/**
 * Card name cell with thumbnail and image hover preview.
 */
export function CardNameCell({ card }: { card: EnrichedCardStats }) {
  const [showImage, setShowImage] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const cellRef = useRef<HTMLDivElement>(null);
  const imageUri = card.scryfall?.imageUri;

  const handleMouseEnter = () => {
    if (cellRef.current) {
      const rect = cellRef.current.getBoundingClientRect();
      // Position image to the right of the cell, clamped to viewport
      const left = Math.min(rect.right + 8, window.innerWidth - 340);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 480));
      setPosition({ top, left });
    }
    setShowImage(true);
  };

  return (
    <div className="relative" ref={cellRef}>
      <div
        className="flex cursor-pointer items-center gap-2"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setShowImage(false)}
      >
        {imageUri && (
          <Image
            src={imageUri}
            alt={card.cardName}
            width={32}
            height={45}
            className="rounded-sm object-cover shadow-sm"
          />
        )}
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{card.cardName}</span>
      </div>

      {showImage && imageUri && (
        <div className="fixed z-50" style={{ top: position.top, left: position.left }}>
          <Image
            src={imageUri}
            alt={card.cardName}
            width={320}
            height={448}
            className="rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-800"
          />
        </div>
      )}
    </div>
  );
}
