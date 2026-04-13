"use client";

import { useState, useEffect, useCallback } from "react";
import type { BoardData, LiveDraftStatus } from "@/app/stores/draftStore";
import { MatchMatrix } from "./MatchMatrix";

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
  omwPct: number | null;
  ogwPct: number | null;
}

interface MatchRecord {
  seat1: number;
  seat2: number;
  seat1Wins: number;
  seat2Wins: number;
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
  const [matches, setMatches] = useState<MatchRecord[]>([]);
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
          omwPct: (row.omwPct as number) ?? null,
          ogwPct: (row.ogwPct as number) ?? null,
        })));
      }
      if (Array.isArray(data.matches)) {
        setMatches(data.matches as MatchRecord[]);
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

  const handleMatchReported = useCallback((data: { mySeat: number; opponent: number; wins: number; losses: number }) => {
    // Optimistic: apply match result to standings immediately
    setStandings((prev) => {
      const updated = prev.map((row) => {
        if (row.seat === data.mySeat) {
          return {
            ...row,
            gameWins: row.gameWins + data.wins,
            gameLosses: row.gameLosses + data.losses,
            matchWins: row.matchWins + (data.wins > data.losses ? 1 : 0),
            matchLosses: row.matchLosses + (data.wins < data.losses ? 1 : 0),
          };
        }
        if (row.seat === data.opponent) {
          return {
            ...row,
            gameWins: row.gameWins + data.losses,
            gameLosses: row.gameLosses + data.wins,
            matchWins: row.matchWins + (data.losses > data.wins ? 1 : 0),
            matchLosses: row.matchLosses + (data.losses < data.wins ? 1 : 0),
          };
        }
        return row;
      });
      // Sort: matchWins DESC, omwPct DESC (nulls last), ogwPct DESC (nulls last)
      return updated.sort((a, b) => {
        if (b.matchWins !== a.matchWins) return b.matchWins - a.matchWins;
        const aOmw = a.omwPct ?? -1;
        const bOmw = b.omwPct ?? -1;
        if (bOmw !== aOmw) return bOmw - aOmw;
        const aOgw = a.ogwPct ?? -1;
        const bOgw = b.ogwPct ?? -1;
        return bOgw - aOgw;
      });
    });
    onMatchReported();
  }, [onMatchReported]);

  const handleMatchReverted = useCallback(() => {
    fetchStandings();
  }, [fetchStandings]);

  if (loading) {
    return (
      <div className="py-3 text-zinc-500 text-xs">
        Loading standings...
      </div>
    );
  }

  return (
    <div className="py-3">
      <div className="flex gap-6 flex-wrap items-start">
        <div className="flex-1 basis-[calc(50%-0.75rem)] min-w-[480px]">
          <h3 className="text-[13px] font-semibold text-zinc-200 mb-2">
            Standings
          </h3>
          {standings.length > 0 ? (
            <table className="border-collapse text-sm w-full text-zinc-200">
              <thead>
                <tr className="border-b border-zinc-700">
                  <th className="px-1.5 py-1 text-left text-zinc-500 whitespace-nowrap">Player</th>
                  <th className="px-1.5 py-1 text-center text-zinc-500 whitespace-nowrap">Match W-L</th>
                  <th className="px-1.5 py-1 text-center text-zinc-500 whitespace-nowrap">Game W-L</th>
                  <th className="px-1.5 py-1 text-center text-zinc-500 whitespace-nowrap">OMW%</th>
                  <th className="px-1.5 py-1 text-center text-zinc-500 whitespace-nowrap">OGW%</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((row) => (
                  <tr
                    key={row.seat}
                    className={row.seat === mySeat ? "bg-blue-500/10" : ""}
                  >
                    <td className="px-1.5 py-1 whitespace-nowrap">{row.displayName}</td>
                    <td className="px-1.5 py-1 text-center whitespace-nowrap">
                      {row.matchWins}-{row.matchLosses}
                    </td>
                    <td className="px-1.5 py-1 text-center whitespace-nowrap">
                      {row.gameWins}-{row.gameLosses}
                    </td>
                    <td className="px-1.5 py-1 text-center text-zinc-400 whitespace-nowrap">
                      {row.omwPct !== null ? (row.omwPct * 100).toFixed(1) + "%" : "\u2014"}
                    </td>
                    <td className="px-1.5 py-1 text-center text-zinc-400 whitespace-nowrap">
                      {row.ogwPct !== null ? (row.ogwPct * 100).toFixed(1) + "%" : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-zinc-500">No match results yet.</p>
          )}
        </div>
        <div className="flex-1 basis-[calc(50%-0.75rem)] min-w-[480px]">
          <h3 className="text-[13px] font-semibold text-zinc-200 mb-2">
            Match Results
          </h3>
          <MatchMatrix
            matches={matches}
            numSeats={board.numSeats}
            seatNames={board.seatNames}
            mySeat={mySeat}
            token={token}
            draftId={draftId}
            phase={status?.phase ?? "setup"}
            onMatchReported={handleMatchReported}
            onMatchReverted={handleMatchReverted}
          />
        </div>
      </div>
    </div>
  );
}
