"use client";

import { useMemo, useRef, useEffect } from "react";
import { buildPickMatrix } from "@/core/snakeDraft";
import type { BoardData } from "@/app/stores/draftStore";
import { DraftBoardCell } from "./DraftBoardCell";
import { InlineEditableName } from "./InlineEditableName";

const SEAT_COLORS = [
  "#e8c050", "#ff6050", "#60c0ff", "#70dd70", "#e080d0",
  "#ff9050", "#50e0c0", "#c0a0ff", "#f0e070", "#ff7090",
];

interface DraftBoardMatrixProps {
  board: BoardData;
  mySeat: number | null;
  nextPickN: number | null;
  onUpdateDisplayName?: (name: string) => Promise<void>;
  handlePick?: (cardName: string) => Promise<void>;
  isMyTurn?: boolean;
  draftId?: string;
  pickError?: string | null;
}

export function DraftBoardMatrix({
  board,
  mySeat,
  nextPickN,
  onUpdateDisplayName,
  handlePick,
  isMyTurn = false,
  draftId,
  pickError = null,
}: DraftBoardMatrixProps) {
  const matrix = useMemo(
    () => buildPickMatrix(board.numSeats, board.picksPerPlayer),
    [board.numSeats, board.picksPerPlayer],
  );

  // Build a lookup: pickN -> pick data
  const { picks } = board;
  const picksByN = useMemo(() => {
    const map = new Map<number, BoardData["picks"][number]>();
    for (const pick of picks) {
      map.set(pick.pickN, pick);
    }
    return map;
  }, [picks]);

  // Track current round for auto-scroll
  const currentRoundRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (currentRoundRef.current) {
      currentRoundRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [nextPickN]);

  // Compute which pickN each (round, seatIndex) cell corresponds to
  // We need to track the global pick number per cell
  const cellPickNumbers = useMemo(() => {
    const result: Map<string, number> = new Map();
    let pickN = 1;
    for (const row of matrix) {
      for (let i = 0; i < row.seats.length; i++) {
        const seat = row.seats[i];
        result.set(`${row.round}-${i}-${seat}`, pickN);
        pickN++;
      }
    }
    return result;
  }, [matrix]);

  // Determine current round (the round containing the next pick)
  const currentRound = useMemo(() => {
    if (nextPickN === null) return null;
    for (const row of matrix) {
      for (let i = 0; i < row.seats.length; i++) {
        const seat = row.seats[i];
        const pn = cellPickNumbers.get(`${row.round}-${i}-${seat}`);
        if (pn === nextPickN) return row.round;
      }
    }
    return null;
  }, [nextPickN, matrix, cellPickNumbers]);

  // Build unique seat order from column headers (seats 1..numSeats)
  const seatOrder = useMemo(() => {
    const seats: number[] = [];
    for (let s = 1; s <= board.numSeats; s++) seats.push(s);
    return seats;
  }, [board.numSeats]);

  return (
    <div className="overflow-x-auto overflow-y-auto">
      <style>{`
        @keyframes pulse-border {
          0%, 100% { border-color: #3b82f6; }
          50% { border-color: transparent; }
        }
        .pencil-icon { opacity: 0; transition: opacity 0.15s; }
        th:hover .pencil-icon { opacity: 0.5; }
      `}</style>
      <table
        className="border-collapse text-xs w-full text-zinc-200"
      >
        <thead>
          <tr
            className="sticky top-0 z-10 bg-zinc-900"
          >
            <th className="px-2 py-1 text-center text-zinc-500 text-[10px]">
              #
            </th>
            {seatOrder.map((seat) => (
              <th
                key={seat}
                className="px-1.5 py-1 text-center font-semibold text-[11px] min-w-[130px]"
                style={{
                  color: SEAT_COLORS[(seat - 1) % SEAT_COLORS.length],
                  backgroundColor: mySeat === seat ? "rgba(59,130,246,0.1)" : undefined,
                }}
              >
                <InlineEditableName
                  currentName={board.seatNames[String(seat)] || `Seat ${seat}`}
                  seatNumber={seat}
                  isEditable={mySeat === seat && !!onUpdateDisplayName}
                  onSave={onUpdateDisplayName ?? (async () => {})}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(() => {
            const rowLabelClassName = "px-1.5 py-0.5 text-center text-zinc-500 text-[10px] whitespace-nowrap border-r border-zinc-700";
            let displayRow = 0;
            return matrix.map((row) => {
              const isCurrentRound = row.round === currentRound;

              // For each seat column, find the pick(s) in this round
              const seatPicks: Map<number, (typeof board.picks)[number][]> = new Map();
              for (let i = 0; i < row.seats.length; i++) {
                const seat = row.seats[i];
                const pickN = cellPickNumbers.get(`${row.round}-${i}-${seat}`);
                if (pickN !== undefined) {
                  const pick = picksByN.get(pickN);
                  if (!seatPicks.has(seat)) seatPicks.set(seat, []);
                  seatPicks.get(seat)!.push(
                    pick ?? { pickN, seat, cardName: "", oracleId: "", colorIdentity: [], manaCost: "" /* required by BoardData type */ },
                  );
                }
              }

              const subRows = row.isDoublePick ? [0, 1] : [0];

              return subRows.map((subRow) => {
                displayRow++;
                const rowNum = displayRow;
                return (
                  <tr
                    key={`${row.round}-${subRow}`}
                    ref={isCurrentRound && subRow === 0 ? currentRoundRef : undefined}
                    style={{
                      backgroundColor: isCurrentRound ? "rgba(59,130,246,0.05)" : undefined,
                    }}
                  >
                    <td className={rowLabelClassName}>
                      <span>{rowNum}</span>
                      <span className="ml-0.5 text-[9px] text-zinc-600">
                        {row.isForward ? "\u2192" : "\u2190"}
                      </span>
                    </td>
                    {seatOrder.map((seat) => {
                      const picks = seatPicks.get(seat) ?? [];
                      const pick = picks[subRow];
                      const isActive = pick && nextPickN !== null && pick.pickN === nextPickN;
                      return (
                        <DraftBoardCell
                          key={seat}
                          cardName={pick?.cardName || null}
                          colorIdentity={pick?.colorIdentity ?? []}
                          isActive={isActive ?? false}
                          isMyColumn={mySeat === seat}
                          isEditable={!!isActive && isMyTurn && !!handlePick}
                          draftId={draftId ?? null}
                          nextPickN={nextPickN}
                          onPick={handlePick}
                          pickError={isActive ? pickError : null}
                        />
                      );
                    })}
                  </tr>
                );
              });
            });
          })()}
        </tbody>
      </table>
    </div>
  );
}
