"use client";

import { useState, useEffect, useCallback } from "react";
import type { BoardData, LiveDraftStatus } from "@/app/stores/draftStore";
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

function DraftProgress({
  board,
  status,
  mySeat,
}: {
  board: BoardData;
  status: LiveDraftStatus | null;
  mySeat: number | null;
}) {
  if (!status || board.phase !== "drafting") return null;

  const nextPickNumber = (status.latestPickN ?? 0) + 1;
  const isMyPick = mySeat !== null && status.nextSeat === mySeat;
  const nextSeatName =
    status.nextSeat !== null
      ? board.seatNames[String(status.nextSeat)] ?? `Seat ${status.nextSeat}`
      : null;

  return (
    <div className="py-2 text-xs text-zinc-500">
      {isMyPick ? (
        <span>
          <span className="text-emerald-400">Your pick</span>{" "}
          (Pick #{nextPickNumber})
        </span>
      ) : nextSeatName ? (
        <span>
          Next pick: <span className="text-zinc-200">{nextSeatName}</span>{" "}
          (Pick #{nextPickNumber})
        </span>
      ) : null}
    </div>
  );
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
    return (
      <div className="py-3">
        <h3 className="text-[13px] font-semibold text-zinc-200 mb-2">
          Draft Progress
        </h3>
        <DraftProgress board={board} status={status} mySeat={mySeat} />
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
        setStandings(data.standings.map((row: Record<string, unknown>) => ({
          seat: row.seat as number,
          displayName: board.seatNames[String(row.seat)] || `Seat ${row.seat}`,
          matchWins: (row.matchWins ?? 0) as number,
          matchLosses: (row.matchLosses ?? 0) as number,
          gameWins: (row.gameWins ?? 0) as number,
          gameLosses: (row.gameLosses ?? 0) as number,
        })));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [draftId, board.seatNames]);

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
      <div className="py-3 text-zinc-500 text-xs">
        Loading standings...
      </div>
    );
  }

  const showMatchReporting =
    board.phase === "playing" && mySeat !== null && token !== null;

  return (
    <div className="py-3">
      <h3 className="text-[13px] font-semibold text-zinc-200 mb-2">
        Standings
      </h3>
      {standings.length > 0 ? (
        <table
          className="border-collapse text-xs w-full max-w-[500px] text-zinc-200"
        >
          <thead>
            <tr className="border-b border-zinc-600">
              <th className="px-2 py-1 text-left text-zinc-500">Player</th>
              <th className="px-2 py-1 text-center text-zinc-500">Match W-L</th>
              <th className="px-2 py-1 text-center text-zinc-500">Game W-L</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row) => (
              <tr
                key={row.seat}
                className="border-b border-zinc-700"
                style={{
                  backgroundColor: row.seat === mySeat ? "rgba(59,130,246,0.08)" : undefined,
                }}
              >
                <td className="px-2 py-1">{row.displayName}</td>
                <td className="px-2 py-1 text-center">
                  {row.matchWins}-{row.matchLosses}
                </td>
                <td className="px-2 py-1 text-center">
                  {row.gameWins}-{row.gameLosses}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-zinc-500">No match results yet.</p>
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
