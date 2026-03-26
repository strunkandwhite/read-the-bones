"use client";

import { useState, useEffect, useCallback } from "react";
import type { BoardData, LiveDraftStatus } from "@/app/hooks/useLiveDraftStatus";
import { getNextPick } from "@/core/snakeDraft";
import { MatchReporting } from "./MatchReporting";

interface StandingsSectionProps {
  board: BoardData;
  status: LiveDraftStatus | null;
  draftId: string;
  mySeat: number | null;
  token: string | null;
  onMatchReported: () => void;
}

interface StandingsRow {
  seat: number;
  displayName: string;
  matchWins: number;
  matchLosses: number;
  gameWins: number;
  gameLosses: number;
}

export function StandingsSection({
  board,
  status,
  draftId,
  mySeat,
  token,
  onMatchReported,
}: StandingsSectionProps) {
  const phase = board.phase;
  const isDrafting = phase === "drafting";

  // During drafting: show pick count and whose turn
  if (isDrafting) {
    const next = getNextPick(board.picks.length, board.numSeats, board.picksPerPlayer);
    const nextSeatName = next
      ? board.seatNames[String(next.seat)] || `Seat ${next.seat}`
      : null;

    return (
      <div style={{ padding: "12px 0" }}>
        <h3
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#e0e0e0",
            marginBottom: "8px",
          }}
        >
          Draft Progress
        </h3>
        {next && (
          <p style={{ fontSize: "12px", color: "#888" }}>
            Next pick: <strong style={{ color: "#e0e0e0" }}>{nextSeatName}</strong> (Pick #{next.pickNumber})
          </p>
        )}
        {!next && (
          <p style={{ fontSize: "12px", color: "#888" }}>All picks complete.</p>
        )}
      </div>
    );
  }

  // Playing/complete: show standings
  return (
    <StandingsTable
      draftId={draftId}
      board={board}
      status={status}
      mySeat={mySeat}
      token={token}
      onMatchReported={onMatchReported}
    />
  );
}

function StandingsTable({
  draftId,
  board,
  status,
  mySeat,
  token,
  onMatchReported,
}: {
  draftId: string;
  board: BoardData;
  status: LiveDraftStatus | null;
  mySeat: number | null;
  token: string | null;
  onMatchReported: () => void;
}) {
  const [standings, setStandings] = useState<StandingsRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStandings = useCallback(async () => {
    try {
      const res = await fetch(`/api/drafts/${draftId}/standings`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.standings)) {
        setStandings(data.standings);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [draftId]);

  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external system (API fetch) */
  useEffect(() => {
    fetchStandings();
  }, [fetchStandings]);

  // Re-fetch when a match is reported (status changes)
  useEffect(() => {
    if (status) fetchStandings();
  }, [status?.matchCount, fetchStandings]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleMatchReported = useCallback(() => {
    fetchStandings();
    onMatchReported();
  }, [fetchStandings, onMatchReported]);

  if (loading) {
    return (
      <div style={{ padding: "12px 0", color: "#888", fontSize: "12px" }}>
        Loading standings...
      </div>
    );
  }

  const showMatchReporting =
    board.phase === "playing" && mySeat !== null && token !== null;

  return (
    <div style={{ padding: "12px 0" }}>
      <h3
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "#e0e0e0",
          marginBottom: "8px",
        }}
      >
        Standings
      </h3>
      {standings.length > 0 ? (
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: "12px",
            width: "100%",
            maxWidth: "500px",
            color: "#e0e0e0",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #444" }}>
              <th style={{ padding: "4px 8px", textAlign: "left", color: "#888" }}>Player</th>
              <th style={{ padding: "4px 8px", textAlign: "center", color: "#888" }}>Match W-L</th>
              <th style={{ padding: "4px 8px", textAlign: "center", color: "#888" }}>Game W-L</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row) => (
              <tr
                key={row.seat}
                style={{
                  borderBottom: "1px solid #333",
                  backgroundColor: row.seat === mySeat ? "rgba(59,130,246,0.08)" : undefined,
                }}
              >
                <td style={{ padding: "4px 8px" }}>{row.displayName}</td>
                <td style={{ padding: "4px 8px", textAlign: "center" }}>
                  {row.matchWins}-{row.matchLosses}
                </td>
                <td style={{ padding: "4px 8px", textAlign: "center" }}>
                  {row.gameWins}-{row.gameLosses}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ fontSize: "12px", color: "#888" }}>No match results yet.</p>
      )}
      {showMatchReporting && (
        <MatchReporting
          draftId={draftId}
          mySeat={mySeat}
          token={token!}
          numSeats={board.numSeats}
          seatNames={board.seatNames}
          onMatchReported={handleMatchReported}
        />
      )}
    </div>
  );
}
