"use client";

import { useEffect } from "react";
import type { BoardData, LiveDraftStatus } from "@/app/hooks/useLiveDraftStatus";
import { getNextPick } from "@/core/snakeDraft";
import { DraftBoardMatrix } from "./DraftBoardMatrix";
import { StandingsSection } from "./StandingsSection";

interface DraftBoardModalProps {
  board: BoardData | null;
  status: LiveDraftStatus | null;
  mySeat: number | null;
  token: string | null;
  draftId: string;
  isOpen: boolean;
  onClose: () => void;
  onMatchReported: () => void;
}

const PHASE_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  drafting: { bg: "#854d0e", text: "#fde68a" },
  playing: { bg: "#1e3a5f", text: "#93c5fd" },
  complete: { bg: "#14532d", text: "#86efac" },
};

export function DraftBoardModal({
  board,
  status,
  mySeat,
  token,
  draftId,
  isOpen,
  onClose,
  onMatchReported,
}: DraftBoardModalProps) {
  // Lock body scroll and handle Escape
  useEffect(() => {
    if (!isOpen) return;

    document.body.style.overflow = "hidden";

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const phase = board?.phase ?? status?.phase ?? "unknown";
  const badgeColors = PHASE_BADGE_COLORS[phase] ?? { bg: "#333", text: "#aaa" };

  const nextPick =
    board
      ? getNextPick(board.picks.length, board.numSeats, board.picksPerPlayer)
      : null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(2px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          maxHeight: "95vh",
          width: "100%",
          maxWidth: "1400px",
          margin: "0 12px",
          borderRadius: "12px",
          border: "1px solid rgba(63,63,70,0.4)",
          backgroundColor: "#09090b",
          boxShadow: "0 0 60px -12px rgba(0,0,0,0.8)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 20px",
            borderBottom: "1px solid rgba(39,39,42,0.6)",
            backgroundColor: "rgba(24,24,27,0.8)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#e4e4e7",
                letterSpacing: "-0.01em",
              }}
            >
              Draft Board
            </span>
            <span
              style={{
                fontSize: "11px",
                fontWeight: 500,
                padding: "2px 8px",
                borderRadius: "4px",
                backgroundColor: badgeColors.bg,
                color: badgeColors.text,
              }}
            >
              {phase}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#a1a1aa",
              cursor: "pointer",
              padding: "4px",
              fontSize: "18px",
              lineHeight: 1,
            }}
            aria-label="Close draft board"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {board ? (
            <>
              <DraftBoardMatrix
                board={board}
                mySeat={mySeat}
                nextPickN={nextPick?.pickNumber ?? null}
                nextSeat={nextPick?.seat ?? null}
              />
              <StandingsSection
                board={board}
                status={status}
                draftId={draftId}
                mySeat={mySeat}
                token={token}
                onMatchReported={onMatchReported}
              />
            </>
          ) : (
            <div
              style={{
                padding: "40px 0",
                textAlign: "center",
                color: "#71717a",
                fontSize: "13px",
              }}
            >
              Loading draft board...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
