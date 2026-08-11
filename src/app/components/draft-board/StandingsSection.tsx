"use client";

import { useState, useCallback, useEffect } from "react";
import type { BoardData, LiveDraftStatus } from "@/app/stores/draftStore";
import { useDraftStore } from "@/app/stores/draftStore";
import { useLiveStore } from "@/app/stores/liveStore";
import { MatchMatrix } from "./MatchMatrix";

interface StandingsSectionProps {
  board: BoardData;
  status: LiveDraftStatus | null;
  mySeat: number | null;
  onMatchReported: () => void;
}

interface MatchReportData {
  mySeat: number;
  opponent: number;
  wins: number;
  losses: number;
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
      ? (board.seatNames[String(status.nextSeat)] ?? `Seat ${status.nextSeat}`)
      : null;

  return (
    <div className="py-2 text-xs text-zinc-500">
      {isMyPick ? (
        <span>
          <span className="text-emerald-400">Your pick</span> (Pick #{nextPickNumber})
        </span>
      ) : nextSeatName ? (
        <span>
          Next pick: <span className="text-zinc-200">{nextSeatName}</span> (Pick #{nextPickNumber})
        </span>
      ) : null}
    </div>
  );
}

export function StandingsSection({
  board,
  status,
  mySeat,
  onMatchReported,
}: StandingsSectionProps) {
  const phase = board.phase;
  const isDrafting = phase === "drafting";

  // During drafting: show pick count and whose turn. The "Draft Progress"
  // title comes from the CollapsibleSection header in DraftBoardModal.
  if (isDrafting) {
    return (
      <div className="py-1">
        <DraftProgress board={board} status={status} mySeat={mySeat} />
      </div>
    );
  }

  // Playing/complete: show standings
  return (
    <StandingsTable
      board={board}
      status={status}
      mySeat={mySeat}
      onMatchReported={onMatchReported}
    />
  );
}

function StandingsTable({
  board,
  status,
  mySeat,
  onMatchReported,
}: {
  board: BoardData;
  status: LiveDraftStatus | null;
  mySeat: number | null;
  onMatchReported: () => void;
}) {
  // Subscribe to draftStore standings — no direct fetch here
  const standings = useDraftStore((s) => s.standings);
  const standingsMatches = useDraftStore((s) => s.standingsMatches);
  const standingsLoading = useDraftStore((s) => s.standingsLoading);
  const fetchStandings = useDraftStore((s) => s.fetchStandings);

  // reportMatch is the single store action that POSTs the result and refreshes standings
  const reportMatch = useLiveStore((s) => s.reportMatch);

  // Pending state shown immediately after reporting a match while the refetch
  // is in flight — avoids stale OMW%/OGW% from an optimistic local recompute.
  const [reportPending, setReportPending] = useState(false);

  // Initial load — fetch once when the table mounts
  useEffect(() => {
    void fetchStandings();
  }, [fetchStandings]);

  // Re-fetch when matchCount changes (a match was reported on any device)
  useEffect(() => {
    if (status) void fetchStandings();
  }, [status?.matchCount, fetchStandings]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMatchReported = useCallback(
    (_data: MatchReportData) => {
      // Show a pending state immediately; standings will refresh after the action completes.
      setReportPending(true);
      onMatchReported();
    },
    [onMatchReported]
  );

  const handleMatchReverted = useCallback(async () => {
    await fetchStandings();
  }, [fetchStandings]);

  const handleReportMatch = useCallback(
    async (params: { opponentSeat: number; wins: number; losses: number }) => {
      const err = await reportMatch(params);
      setReportPending(false);
      return err;
    },
    [reportMatch]
  );

  if (standingsLoading && standings.length === 0) {
    return <div className="py-3 text-xs text-zinc-500">Loading standings...</div>;
  }

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start gap-6">
        <div className="min-w-[480px] flex-1 basis-[calc(50%-0.75rem)]">
          <h3 className="mb-2 text-[13px] font-semibold text-zinc-200">
            Standings
            {reportPending && (
              <span className="ml-2 text-xs font-normal text-zinc-500">Updating...</span>
            )}
          </h3>
          {standings.length > 0 ? (
            <table className="w-full table-fixed border-collapse text-sm text-zinc-300">
              <thead>
                <tr className="border-b border-zinc-700">
                  <th className="px-1.5 py-1 text-left font-normal whitespace-nowrap text-zinc-500">
                    Player
                  </th>
                  <th className="px-1.5 py-1 text-center font-normal whitespace-nowrap text-zinc-500">
                    Match W-L
                  </th>
                  <th className="px-1.5 py-1 text-center font-normal whitespace-nowrap text-zinc-500">
                    Game W-L
                  </th>
                  <th className="px-1.5 py-1 text-center font-normal whitespace-nowrap text-zinc-500">
                    OMW%
                  </th>
                  <th className="px-1.5 py-1 text-center font-normal whitespace-nowrap text-zinc-500">
                    OGW%
                  </th>
                </tr>
              </thead>
              <tbody>
                {standings.map((row) => (
                  <tr key={row.seat} className={row.seat === mySeat ? "bg-blue-500/10" : ""}>
                    <td className="px-1.5 py-1 whitespace-nowrap">
                      {board.seatNames[String(row.seat)] || `Seat ${row.seat}`}
                    </td>
                    <td className="px-1.5 py-1 text-center whitespace-nowrap">
                      {row.matchWins}-{row.matchLosses}
                    </td>
                    <td className="px-1.5 py-1 text-center whitespace-nowrap">
                      {row.gameWins}-{row.gameLosses}
                    </td>
                    <td className="px-1.5 py-1 text-center whitespace-nowrap text-zinc-400">
                      {row.omwPct !== null ? (row.omwPct * 100).toFixed(1) + "%" : "—"}
                    </td>
                    <td className="px-1.5 py-1 text-center whitespace-nowrap text-zinc-400">
                      {row.ogwPct !== null ? (row.ogwPct * 100).toFixed(1) + "%" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-zinc-500">No match results yet.</p>
          )}
        </div>
        <div className="min-w-[480px] flex-1 basis-[calc(50%-0.75rem)]">
          <h3 className="mb-2 text-[13px] font-semibold text-zinc-200">
            Match Results
            <span
              className="ml-1.5 cursor-help text-zinc-500"
              title="Read left to right: each row shows that player's result against the column player"
            >
              ?
            </span>
          </h3>
          <MatchMatrix
            matches={standingsMatches}
            numSeats={board.numSeats}
            seatNames={board.seatNames}
            mySeat={mySeat}
            phase={board.phase}
            onReportMatch={handleReportMatch}
            onMatchReported={handleMatchReported}
            onMatchReverted={handleMatchReverted}
          />
        </div>
      </div>
    </div>
  );
}
