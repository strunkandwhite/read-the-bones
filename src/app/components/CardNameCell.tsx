"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
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

/** Two-step pick button with confirmation timeout. */
function PickButton({ cardName, onPick }: { cardName: string; onPick: (name: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (confirming) {
      timeoutRef.current = setTimeout(() => setConfirming(false), 3000);
      return () => clearTimeout(timeoutRef.current);
    }
  }, [confirming]);

  if (confirming) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setConfirming(false); onPick(cardName); }}
        className="flex h-4 w-4 cursor-pointer items-center justify-center animate-pulse"
        title="Confirm"
        aria-label="Confirm pick"
      >
        <DeckIcon className="h-3.5 w-3.5 text-emerald-500" />
      </button>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
      className="flex h-4 w-4 cursor-pointer items-center justify-center opacity-0 transition-opacity group-hover/row:opacity-100 active:opacity-100"
      title="Click, then confirm to draft this card"
      aria-label="Draft this card"
    >
      <DeckIcon className="h-3.5 w-3.5 text-emerald-500" />
    </button>
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
  // Live draft props
  onPick?: (cardName: string) => Promise<void>;
  isMyTurn?: boolean;
  queuePos?: number;
  onQueueAdd?: (cardName: string) => void;
  onQueueRemove?: (cardName: string) => void;
}

export function CardNameCell({
  card, cubeCopies, onAddSpeculative, onRemoveSpeculative, canAddMore,
  isInDeckBuilder, isSpeculative, isTaken, isSeatCard,
  onPick, isMyTurn, queuePos, onQueueAdd, onQueueRemove,
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
        {/* Right-side icons: pick, queue, and deck builder */}
        {(() => {
          const icons: ReactNode[] = [];

          // Live draft: pick icon (emerald DeckIcon, visible on hover when it's my turn)
          if (onPick && isMyTurn && !isTaken && !isSeatCard) {
            icons.push(
              <PickButton key="pick" cardName={card.cardName} onPick={onPick} />
            );
          }

          // Live draft: queue icon (hide for cards already picked by this seat)
          if (onQueueAdd && onQueueRemove && !isTaken && !isSeatCard) {
            if (queuePos !== undefined) {
              icons.push(
                <button
                  key="queue"
                  onClick={(e) => { e.stopPropagation(); onQueueRemove(card.cardName); }}
                  className="relative flex h-4 w-4 cursor-pointer items-center justify-center hover:opacity-75"
                  title={`Queued #${queuePos} for auto-pick — click to remove`}
                  aria-label={`Queued at position ${queuePos}, click to remove`}
                >
                  <DeckIcon className="h-3.5 w-3.5 text-blue-400" />
                  <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-blue-500 text-[7px] font-bold leading-none text-white">{queuePos}</span>
                </button>
              );
            } else {
              icons.push(
                <button
                  key="queue-add"
                  onClick={(e) => { e.stopPropagation(); onQueueAdd(card.cardName); }}
                  className="flex h-4 w-4 cursor-pointer items-center justify-center opacity-0 transition-opacity group-hover/row:opacity-50 active:opacity-100"
                  title="Add to auto-pick queue"
                  aria-label="Add to auto-pick queue"
                >
                  <DeckIcon className="h-3.5 w-3.5 text-blue-400" />
                </button>
              );
            }
          }

          // Deck builder: seat card or in deck builder (solid blue)
          if (isSeatCard && !isInDeckBuilder) {
            icons.push(<DeckIcon key="deck" className="h-3.5 w-3.5 shrink-0 text-blue-400" />);
          } else if (isInDeckBuilder && !isSpeculative) {
            icons.push(<DeckIcon key="deck" className="h-3.5 w-3.5 shrink-0 text-blue-400" />);
          } else if (isSpeculative && onRemoveSpeculative) {
            // Speculative — show remove + optionally add if more copies available
            icons.push(
              <span key="deck-spec" className="flex shrink-0 items-center">
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
          } else if (onAddSpeculative && canAddMore && !isTaken) {
            // Can add speculative — show deck icon on row hover
            icons.push(
              <button
                key="deck-add"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddSpeculative(card.cardName);
                }}
                className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center opacity-0 transition-opacity group-hover/row:opacity-35 active:opacity-100"
                title="Add to deck builder"
                aria-label="Add to deck builder"
              >
                <DeckIcon className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-400" />
              </button>
            );
          }

          if (icons.length === 0) return null;
          return <span className="ml-1 flex shrink-0 items-center gap-0.5">{icons}</span>;
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
