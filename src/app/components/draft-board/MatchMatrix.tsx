"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { MatchReportParams } from "@/app/stores/liveStore";

export interface MatchMatrixProps {
  matches: Array<{
    seat1: number;
    seat2: number;
    seat1Wins: number;
    seat2Wins: number;
  }>;
  numSeats: number;
  seatNames: Record<string, string>;
  mySeat: number | null;
  phase: string;
  /**
   * Store action that POSTs the match result and refreshes standings.
   * Returns an error message string on failure, or null on success.
   */
  onReportMatch: (params: MatchReportParams) => Promise<string | null>;
  onMatchReported: (data: {
    mySeat: number;
    opponent: number;
    wins: number;
    losses: number;
  }) => void;
  onMatchReverted: () => void;
}

/** Look up the result for row vs col from the matches array. */
function findMatch(
  matches: MatchMatrixProps["matches"],
  row: number,
  col: number
): { wins: number; losses: number } | null {
  for (const m of matches) {
    if (m.seat1 === row && m.seat2 === col) {
      return { wins: m.seat1Wins, losses: m.seat2Wins };
    }
    if (m.seat1 === col && m.seat2 === row) {
      return { wins: m.seat2Wins, losses: m.seat1Wins };
    }
  }
  return null;
}

const RESULT_PATTERN = /^[012]-[012]$/;

function isValidResult(value: string): boolean {
  if (!RESULT_PATTERN.test(value)) return false;
  const [a, b] = value.split("-").map(Number);
  // Exactly one side must reach 2 wins (2-2 is impossible in best-of-3)
  return (a === 2) !== (b === 2);
}

interface EditingState {
  row: number;
  col: number;
  value: string;
  error: string | null;
  saving: boolean;
}

export function MatchMatrix({
  matches,
  numSeats,
  seatNames,
  mySeat,
  phase,
  onReportMatch,
  onMatchReported,
  onMatchReverted,
}: MatchMatrixProps) {
  const [editing, setEditing] = useState<EditingState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const seats = Array.from({ length: numSeats }, (_, i) => i + 1);
  const canEdit = (phase === "playing" || phase === "complete") && mySeat !== null;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing?.row, editing?.col]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayName = useCallback(
    (seat: number) => {
      const name = seatNames[String(seat)];
      return name || `Seat ${seat}`;
    },
    [seatNames]
  );

  const startEditing = useCallback(
    (row: number, col: number) => {
      if (!canEdit || row !== mySeat) return;
      const existing = findMatch(matches, row, col);
      const initialValue = existing ? `${existing.wins}-${existing.losses}` : "";
      setEditing({ row, col, value: initialValue, error: null, saving: false });
    },
    [canEdit, mySeat, matches]
  );

  const cancelEditing = useCallback(() => {
    setEditing(null);
  }, []);

  const saveResult = useCallback(
    async (state: EditingState) => {
      if (!isValidResult(state.value)) {
        setEditing((prev) =>
          prev ? { ...prev, error: "Format: W-L (e.g. 2-1), one side must be 2" } : null
        );
        return;
      }

      const [wins, losses] = state.value.split("-").map(Number);
      const existing = findMatch(matches, state.row, state.col);
      const isCorrection = existing !== null;

      setEditing((prev) => (prev ? { ...prev, saving: true, error: null } : null));

      // Optimistic update for new reports only
      if (!isCorrection) {
        onMatchReported({ mySeat: state.row, opponent: state.col, wins, losses });
      }

      const errorMsg = await onReportMatch({
        opponentSeat: state.col,
        wins,
        losses,
      });

      if (errorMsg === null) {
        setEditing(null);
        // For corrections, trigger a revert (standings already refreshed by the action)
        if (isCorrection) {
          onMatchReverted();
        }
      } else {
        setEditing((prev) => (prev ? { ...prev, saving: false, error: errorMsg } : null));
        onMatchReverted();
      }
    },
    [matches, onReportMatch, onMatchReported, onMatchReverted]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelEditing();
      } else if (e.key === "Enter" && editing && !editing.saving) {
        saveResult(editing);
      }
    },
    [editing, cancelEditing, saveResult]
  );

  const handleBlur = useCallback(() => {
    if (editing && !editing.saving) {
      if (editing.value === "") {
        cancelEditing();
      } else {
        saveResult(editing);
      }
    }
  }, [editing, cancelEditing, saveResult]);

  return (
    <div data-testid="match-matrix" className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-sm text-zinc-300">
        <thead>
          <tr className="border-b border-zinc-700">
            <th className="px-1.5 py-1" />
            {seats.map((col) => (
              <th
                key={col}
                className="overflow-hidden px-1.5 py-1 text-center font-normal text-ellipsis whitespace-nowrap text-zinc-500"
                title={displayName(col)}
              >
                {displayName(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {seats.map((row) => {
            const isMyRow = row === mySeat;
            return (
              <tr key={row} className={isMyRow ? "bg-blue-500/10" : ""}>
                <td
                  className="overflow-hidden px-1.5 py-1 text-ellipsis whitespace-nowrap"
                  title={displayName(row)}
                >
                  {displayName(row)}
                </td>
                {seats.map((col) => {
                  const isDiagonal = row === col;
                  const isEditing = editing !== null && editing.row === row && editing.col === col;

                  if (isDiagonal) {
                    return (
                      <td
                        key={col}
                        data-testid={`match-cell-${row}-${col}`}
                        className="px-1.5 py-1 text-center text-zinc-600"
                      >
                        X
                      </td>
                    );
                  }

                  const result = findMatch(matches, row, col);
                  const isMyCell = isMyRow && canEdit;

                  if (isEditing) {
                    return (
                      <td
                        key={col}
                        data-testid={`match-cell-${row}-${col}`}
                        className="px-0.5 py-0.5"
                      >
                        <div className="flex flex-col items-center">
                          <input
                            ref={inputRef}
                            data-testid="match-input"
                            type="text"
                            value={editing.value}
                            onChange={(e) =>
                              setEditing((prev) =>
                                prev ? { ...prev, value: e.target.value, error: null } : null
                              )
                            }
                            onKeyDown={handleKeyDown}
                            onBlur={handleBlur}
                            disabled={editing.saving}
                            className="w-10 rounded border border-zinc-500 bg-zinc-800 px-0.5 py-0.5 text-center text-[11px] text-zinc-200 focus:border-blue-500 focus:outline-none"
                            placeholder="W-L"
                          />
                          {editing.error && (
                            <span className="mt-0.5 text-[9px] whitespace-nowrap text-red-500">
                              {editing.error}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  }

                  if (result) {
                    const isWin = result.wins > result.losses;
                    const colorClass = isWin ? "text-emerald-400" : "text-red-400";
                    return (
                      <td
                        key={col}
                        data-testid={`match-cell-${row}-${col}`}
                        className={`px-1.5 py-1 text-center ${colorClass} ${
                          isMyCell ? "cursor-pointer hover:bg-zinc-700/50" : ""
                        }`}
                        onClick={isMyCell ? () => startEditing(row, col) : undefined}
                      >
                        {result.wins}-{result.losses}
                      </td>
                    );
                  }

                  // Unplayed cell
                  if (isMyCell) {
                    return (
                      <td
                        key={col}
                        data-testid={`match-cell-${row}-${col}`}
                        className="cursor-pointer px-1.5 py-1 text-center hover:bg-zinc-700/50"
                        onClick={() => startEditing(row, col)}
                      >
                        <span className="inline-block h-5 w-6 rounded border border-dashed border-zinc-600 leading-5 text-zinc-600">
                          &mdash;
                        </span>
                      </td>
                    );
                  }

                  return (
                    <td
                      key={col}
                      data-testid={`match-cell-${row}-${col}`}
                      className="px-1.5 py-1 text-center text-zinc-600"
                    >
                      &mdash;
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
