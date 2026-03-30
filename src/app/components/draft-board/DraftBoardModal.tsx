"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import type { BoardData, LiveDraftStatus } from "@/app/stores/draftStore";
import { useScrollLock } from "@/app/hooks/useScrollLock";
import { getNextPick } from "@/core/snakeDraft";
import { DraftBoardMatrix } from "./DraftBoardMatrix";
import { QueuePanel } from "./QueuePanel";
import type { QueueItem } from "./QueuePanel";
import { StandingsSection } from "./StandingsSection";

interface DraftBoardModalProps {
  board: BoardData | null;
  status: LiveDraftStatus | null;
  mySeat: number | null;
  token: string | null;
  draftId: string;
  draftName?: string;
  availableCount?: number;
  bannedCardNames?: string[];
  isOpen: boolean;
  onClose: () => void;
  onMatchReported: () => void;
  onUpdateDisplayName?: (name: string) => Promise<void>;
  pickQueue?: QueueItem[];
  autoPick?: boolean;
  autoPickMode?: "resilient" | "cautious";
  onQueueReorder?: (queue: string[]) => void;
  onQueueRemove?: (cardName: string) => void;
  onToggleAutoPick?: () => void;
  onChangeAutoPickMode?: (mode: "resilient" | "cautious") => void;
  handlePick?: (cardName: string) => Promise<void>;
  isMyTurn?: boolean;
  pickError?: string | null;
}

const PHASE_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  drafting: { bg: "bg-yellow-800", text: "text-amber-200" },
  playing: { bg: "bg-blue-900", text: "text-blue-300" },
  complete: { bg: "bg-green-900", text: "text-green-300" },
};

export function DraftBoardModal({
  board,
  status,
  mySeat,
  token,
  draftId,
  draftName,
  availableCount,
  bannedCardNames,
  isOpen,
  onClose,
  onMatchReported,
  onUpdateDisplayName,
  pickQueue = [],
  autoPick = false,
  autoPickMode = "resilient",
  onQueueReorder,
  onQueueRemove,
  onToggleAutoPick,
  onChangeAutoPickMode,
  handlePick,
  isMyTurn = false,
  pickError = null,
}: DraftBoardModalProps) {
  useScrollLock(isOpen);

  const backdropRef = useRef<HTMLDivElement>(null);

  // Auto-focus backdrop so it can receive keyboard events
  useEffect(() => {
    if (isOpen) backdropRef.current?.focus();
  }, [isOpen]);

  const phase = board?.phase ?? status?.phase ?? "unknown";
  const badgeColors = PHASE_BADGE_COLORS[phase] ?? { bg: "bg-zinc-700", text: "text-zinc-400" };

  const nextPick =
    board
      ? getNextPick(board.picks.length, board.numSeats, board.picksPerPlayer)
      : null;

  return (
    <div
      ref={backdropRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm outline-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="flex flex-col max-h-[95vh] w-full max-w-[95vw] mx-3 rounded-xl border border-zinc-700/40 bg-zinc-950 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 border-b border-zinc-800/60 bg-zinc-900/80"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-zinc-200 tracking-tight">
              {draftName || draftId}
            </span>
            <span
              className={`text-[11px] font-medium px-2 py-0.5 rounded ${badgeColors.bg} ${badgeColors.text}`}
            >
              {phase}
            </span>
            {availableCount !== undefined && (
              <span className="text-[11px] text-zinc-400">
                {availableCount} available
                {bannedCardNames && bannedCardNames.length > 0 && (
                  <span
                    className="text-zinc-500 cursor-default"
                    title={bannedCardNames.join("\n")}
                  >{" · "}{bannedCardNames.length} banned</span>
                )}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="bg-transparent border-none text-zinc-400 cursor-pointer p-1 text-lg leading-none"
            aria-label="Close draft board"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex flex-col overflow-hidden px-5 py-4 gap-4">
          {board ? (
            <>
              <div className="flex-1 min-h-0 overflow-auto">
                <DraftBoardMatrix
                  board={board}
                  mySeat={mySeat}
                  nextPickN={nextPick?.pickNumber ?? null}
                  onUpdateDisplayName={onUpdateDisplayName}
                  handlePick={handlePick}
                  isMyTurn={isMyTurn}
                  draftId={draftId}
                  pickError={pickError}
                />
              </div>
              <div className="shrink-0">
                <StandingsSection
                  board={board}
                  status={status}
                  draftId={draftId}
                  mySeat={mySeat}
                  token={token}
                  onMatchReported={onMatchReported}
                />
                {token !== null && (
                  <QueuePanel
                    queue={pickQueue}
                    autoPick={autoPick}
                    autoPickMode={autoPickMode}
                    onReorder={onQueueReorder ?? (() => {})}
                    onRemove={onQueueRemove ?? (() => {})}
                    onToggleAutoPick={onToggleAutoPick ?? (() => {})}
                    onChangeAutoPickMode={onChangeAutoPickMode ?? (() => {})}
                  />
                )}
              </div>
            </>
          ) : (
            <div
              className="py-10 text-center text-zinc-500 text-[13px]"
            >
              Loading draft board...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
