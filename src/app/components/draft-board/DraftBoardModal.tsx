"use client";

import { useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { useDraftStore } from "@/app/stores/draftStore";
import { useLiveStore } from "@/app/stores/liveStore";
import { useCardStore } from "@/app/stores/cardStore";
import { useIsAuthed } from "@/app/stores/selectors";
import { useScrollLock } from "@/app/hooks/useScrollLock";
import { getNextPick } from "@/core/snakeDraft";
import { CollapsibleSection } from "./CollapsibleSection";
import { DraftBoardMatrix } from "./DraftBoardMatrix";
import { QueuePanel } from "./QueuePanel";
import { StandingsSection } from "./StandingsSection";

interface DraftBoardModalProps {
  draftId: string;
  draftName?: string;
  isOpen: boolean;
  onClose: () => void;
}

const PHASE_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  drafting: { bg: "bg-yellow-800", text: "text-amber-200" },
  playing: { bg: "bg-blue-900", text: "text-blue-300" },
  complete: { bg: "bg-green-900", text: "text-green-300" },
};

export function DraftBoardModal({ draftId, draftName, isOpen, onClose }: DraftBoardModalProps) {
  // Draft store
  const board = useDraftStore((s) => s.board);
  const liveDraftStatus = useDraftStore((s) => s.liveDraftStatus);
  const pollFailed = useDraftStore((s) => s.pollFailed);
  const patchSeatName = useDraftStore((s) => s.patchSeatName);

  // Card store
  const availableCount = useCardStore((s) => s.availableCount);
  const bannedCardNames = useCardStore((s) => s.cardData).bannedCardNames;

  // Live store
  const mySeat = useLiveStore((s) => s.mySeat);
  const seatToken = useLiveStore((s) => s.seatToken);
  const autoPick = useLiveStore((s) => s.autoPick);
  const queue = useLiveStore((s) => s.queue);
  const isMyTurn = useLiveStore((s) => s.isMyTurn);
  const pickError = useLiveStore((s) => s.pickError);
  const submitPick = useLiveStore((s) => s.handlePick);
  const reorderQueue = useLiveStore((s) => s.reorderQueue);
  const removeFromQueue = useLiveStore((s) => s.removeFromQueue);
  const toggleAutoPick = useLiveStore((s) => s.toggleAutoPick);

  const isAuthed = useIsAuthed();

  useScrollLock(isOpen);

  const backdropRef = useRef<HTMLDivElement>(null);

  // Auto-focus backdrop so it can receive keyboard events
  useEffect(() => {
    if (isOpen) backdropRef.current?.focus();
  }, [isOpen]);

  const handleUpdateDisplayName = useCallback(
    async (name: string) => {
      if (mySeat !== null) patchSeatName(mySeat, name || `Seat ${mySeat}`);
      await useLiveStore.getState().updateDisplayName(name);
      await useDraftStore.getState().refreshNow();
    },
    [mySeat, patchSeatName]
  );

  const setEntryMode = useLiveStore((s) => s.setEntryMode);

  const phase = board?.phase ?? "unknown";
  const badgeColors = PHASE_BADGE_COLORS[phase] ?? { bg: "bg-zinc-700", text: "text-zinc-400" };

  const nextPick = board
    ? getNextPick(
        liveDraftStatus?.latestPickN ?? board.picks.length,
        board.numSeats,
        board.picksPerPlayer,
        board.doublePickAfterRound
      )
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
      <div className="mx-3 flex max-h-[95dvh] w-full max-w-[95vw] flex-col overflow-hidden rounded-xl border border-zinc-700/40 bg-zinc-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800/60 bg-zinc-900/80 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight text-zinc-200">
              {draftName || draftId}
            </span>
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${badgeColors.bg} ${badgeColors.text}`}
            >
              {phase}
            </span>
            {availableCount !== undefined && (
              <span className="text-[11px] text-zinc-400">
                {availableCount} available
                {bannedCardNames && bannedCardNames.length > 0 && (
                  <span className="cursor-default text-zinc-500" title={bannedCardNames.join("\n")}>
                    {" · "}
                    {bannedCardNames.length} banned
                  </span>
                )}
              </span>
            )}
            {pollFailed && (
              <span
                className="text-[11px] text-amber-400/70"
                title="Live data may be stale — polling failed"
              >
                ⚠ stale
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
            aria-label="Close draft board"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-4 overflow-hidden px-5 py-4">
          {board ? (
            <>
              <CollapsibleSection
                title="Draft Grid"
                storageKey="draftBoardCollapsed:grid"
                className="flex min-h-0 flex-col"
                expandedClassName="flex-1"
                bodyClassName="flex-1 min-h-0 overflow-auto"
              >
                <DraftBoardMatrix
                  board={board}
                  mySeat={mySeat}
                  nextPickN={nextPick?.pickNumber ?? null}
                  latestPickN={liveDraftStatus?.latestPickN ?? null}
                  onUpdateDisplayName={handleUpdateDisplayName}
                  handlePick={isAuthed ? submitPick : undefined}
                  isMyTurn={isAuthed && isMyTurn}
                  draftId={draftId}
                  pickError={pickError}
                />
              </CollapsibleSection>
              <div className="shrink-0">
                <CollapsibleSection
                  title={phase === "drafting" ? "Draft Progress" : "Standings & Match Results"}
                  storageKey="draftBoardCollapsed:results"
                >
                  <StandingsSection
                    board={board}
                    status={liveDraftStatus}
                    mySeat={mySeat}
                    onMatchReported={() => useDraftStore.getState().refreshNow()}
                  />
                </CollapsibleSection>
                {seatToken !== null && board?.phase === "drafting" && (
                  <CollapsibleSection
                    title="Pick Queue"
                    storageKey="draftBoardCollapsed:queue"
                    className="mt-3"
                  >
                    <QueuePanel
                      queue={queue}
                      autoPick={autoPick}
                      onReorder={reorderQueue}
                      onRemove={removeFromQueue}
                      onToggleAutoPick={toggleAutoPick}
                      onSetEntryMode={setEntryMode}
                    />
                  </CollapsibleSection>
                )}
              </div>
            </>
          ) : (
            <div className="py-10 text-center text-[13px] text-zinc-500">
              Loading draft board...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
