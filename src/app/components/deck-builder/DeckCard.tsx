"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatSignedPercent } from "../worthFormat";

interface DeckCardProps {
  cardName: string;
  imageUri?: string;
  isFloated: boolean;
  isQueued: boolean;
  isLast: boolean;
  id: string; // unique drag ID: "zone:column:index:cardName"
  onRemoveFloat?: (cardName: string) => void;
  onToggleQueue?: (cardName: string) => void;
  pickScore?: number;
  gpwr?: number;
  gpwrCi?: { lower: number; upper: number };
  worth?: number;
}

export function DeckCard({
  cardName,
  imageUri,
  isFloated,
  isQueued,
  isLast,
  id,
  onRemoveFloat,
  onToggleQueue,
  pickScore,
  gpwr,
  gpwrCi,
  worth,
}: DeckCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const [showImage, setShowImage] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  if (isDragging && showImage) setShowImage(false);

  const handleMouseEnter = (e: React.MouseEvent) => {
    if (isDragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const left = Math.min(rect.right + 8, window.innerWidth - 340);
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 520));
    setPosition({ top, left });
    setShowImage(true);
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : isFloated ? 0.35 : isQueued ? 0.7 : 1,
  };

  // Show only the name bar (~28px) for stacked cards, full image for the last card
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setShowImage(false)}
      className={`group/card relative cursor-grab overflow-hidden rounded active:cursor-grabbing ${
        isFloated
          ? "border border-dashed border-zinc-500/70"
          : isQueued
            ? "border-2 border-dashed border-orange-500/70"
            : "border border-zinc-700/50"
      } ${!isLast ? "h-[28px]" : ""}`}
    >
      {imageUri ? (
        <img src={imageUri} alt={cardName} className="block w-full" draggable={false} />
      ) : (
        <div
          className={`flex items-center bg-zinc-800 px-2 text-[11px] font-medium text-zinc-300 ${
            isLast ? "py-1.5" : "h-[28px]"
          }`}
        >
          {cardName}
        </div>
      )}
      {/* Remove button for floated cards — top right */}
      {isFloated && onRemoveFloat && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemoveFloat(cardName);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-0.5 right-0.5 z-10 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover/card:opacity-100 hover:bg-red-600"
          title="Remove speculative card"
          aria-label="Remove speculative card"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="h-2.5 w-2.5"
            aria-hidden="true"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
      {/* Queue toggle for floated cards — top left */}
      {isFloated && onToggleQueue && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleQueue(cardName);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={`absolute top-0.5 left-0.5 z-10 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full transition-opacity ${
            isQueued
              ? "bg-amber-500 text-white opacity-100"
              : "bg-black/60 text-amber-400 opacity-0 group-hover/card:opacity-100 hover:bg-amber-600 hover:text-white"
          }`}
          title={isQueued ? "Remove from queue" : "Add to queue"}
          aria-label={isQueued ? "Remove from queue" : "Add to queue"}
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            stroke="none"
            className="h-2.5 w-2.5"
            aria-hidden="true"
          >
            <rect x="3" y="2.5" width="10" height="1.8" rx="0.4" />
            <rect x="3.4" y="5.3" width="10" height="1.8" rx="0.4" />
            <rect x="3.8" y="8.1" width="10" height="1.8" rx="0.4" />
            <rect x="4.2" y="10.9" width="10" height="1.8" rx="0.4" />
          </svg>
        </button>
      )}
      {/* Hover card preview — portaled to body for full opacity and z-index */}
      {showImage &&
        imageUri &&
        !isDragging &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999]"
            style={{ top: position.top, left: position.left }}
          >
            <img
              src={imageUri}
              alt={cardName}
              width={320}
              height={448}
              className="rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-800"
              draggable={false}
            />
            {(pickScore != null || gpwr != null || worth != null) && (
              <div className="mt-1.5 flex max-w-[320px] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-700/60 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
                {pickScore != null && (
                  <span className="text-zinc-400">
                    Pick{" "}
                    <span className="font-mono font-semibold text-zinc-100">
                      {pickScore.toFixed(1)}
                    </span>
                  </span>
                )}
                {gpwr != null && (
                  <span className="text-zinc-400">
                    GPWR{" "}
                    <span className="font-mono font-semibold text-zinc-100">
                      {(gpwr * 100).toFixed(0)}%
                    </span>
                    {gpwrCi && (
                      <span className="ml-0.5 text-zinc-500">
                        {"\u00b1"}
                        {Math.round((gpwrCi.upper - gpwrCi.lower) * 50)}%
                      </span>
                    )}
                  </span>
                )}
                {worth != null && (
                  <span className="text-zinc-400">
                    Worth{" "}
                    <span className="font-mono font-semibold text-zinc-100">
                      {formatSignedPercent(worth)}
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
