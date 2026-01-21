"use client";

import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import type { EnrichedCardStats } from "@/core/types";

/** Stacked-layers icon — indicates a card is in the deck builder. */
function DeckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="2" y="5" width="10" height="7" rx="1.5" opacity="0.45" />
      <rect x="4" y="3" width="10" height="7" rx="1.5" />
    </svg>
  );
}

/** Small X icon for removing speculative cards. */
function RemoveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

interface CardNameCellProps {
  card: EnrichedCardStats;
  cubeCopies?: number;
  onAddSpeculative?: (cardName: string) => void;
  onRemoveSpeculative?: (cardName: string) => void;
  canAddMore?: boolean;
  isInDeckBuilder?: boolean;
  isSpeculative?: boolean;
  isTaken?: boolean;
  isSeatCard?: boolean;
}

export function CardNameCell({ card, cubeCopies, onAddSpeculative, onRemoveSpeculative, canAddMore, isInDeckBuilder, isSpeculative, isTaken, isSeatCard }: CardNameCellProps) {
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
        {/* Deck icon states — mutually exclusive */}
        {(() => {
          // Our seat's pick (not in deck builder)
          if (isSeatCard && !isInDeckBuilder) {
            return <DeckIcon className="ml-1 h-3.5 w-3.5 shrink-0 text-blue-400" />;
          }
          // In deck builder as a real pick
          if (isInDeckBuilder && !isSpeculative) {
            return <DeckIcon className="ml-1 h-3.5 w-3.5 shrink-0 text-blue-400" />;
          }
          // Speculative — show remove + optionally add if more copies available
          if (isSpeculative && onRemoveSpeculative) {
            return (
              <span className="ml-1 flex shrink-0 items-center">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveSpeculative(card.cardName);
                  }}
                  className="group/spec flex h-4 w-4 cursor-pointer items-center justify-center"
                  title="Remove speculative card"
                  aria-label="Remove speculative card"
                >
                  <DeckIcon className="h-3.5 w-3.5 text-zinc-300 opacity-50 group-hover/spec:hidden dark:text-zinc-400" />
                  <RemoveIcon className="hidden h-3.5 w-3.5 text-red-400 group-hover/spec:block" />
                </button>
                {canAddMore && onAddSpeculative && !isTaken && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddSpeculative(card.cardName);
                    }}
                    className="flex h-4 w-4 cursor-pointer items-center justify-center opacity-0 transition-opacity group-hover/row:opacity-35 active:opacity-100"
                    title="Add another copy"
                    aria-label="Add another copy"
                  >
                    <DeckIcon className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-400" />
                  </button>
                )}
              </span>
            );
          }
          // Can add speculative — show deck icon on row hover, flash on click
          if (onAddSpeculative && canAddMore && !isTaken) {
            return (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAddSpeculative(card.cardName);
                }}
                className="ml-1 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center opacity-0 transition-opacity group-hover/row:opacity-35 active:opacity-100"
                title="Add to deck builder"
                aria-label="Add to deck builder"
              >
                <DeckIcon className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-400" />
              </button>
            );
          }
          return null;
        })()}
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
