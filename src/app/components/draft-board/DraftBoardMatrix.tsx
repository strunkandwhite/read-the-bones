"use client";

import { useMemo, useRef, useEffect } from "react";
import { buildPickMatrix } from "@/core/snakeDraft";
import type { BoardData } from "@/app/hooks/useLiveDraftStatus";
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
  nextSeat: number | null;
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
  nextSeat: _nextSeat,
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
    <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "75vh" }}>
      <style>{`
        @keyframes pulse-border {
          0%, 100% { border-color: #3b82f6; }
          50% { border-color: transparent; }
        }
        .pencil-icon { opacity: 0; transition: opacity 0.15s; }
        th:hover .pencil-icon { opacity: 0.5; }
      `}</style>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: "12px",
          width: "100%",
          color: "#e0e0e0",
        }}
      >
        <thead>
          <tr
            style={{
              position: "sticky",
              top: 0,
              zIndex: 10,
              backgroundColor: "#18181b",
            }}
          >
            <th style={{ padding: "4px 8px", textAlign: "center", color: "#888", fontSize: "10px" }}>
              Rd
            </th>
            {seatOrder.map((seat) => (
              <th
                key={seat}
                style={{
                  padding: "4px 6px",
                  textAlign: "center",
                  color: SEAT_COLORS[(seat - 1) % SEAT_COLORS.length],
                  fontWeight: 600,
                  fontSize: "11px",
                  minWidth: "130px",
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
          {matrix.map((row) => {
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
                  pick ?? { pickN, seat, cardName: "", oracleId: "", colorIdentity: [], manaCost: "" },
                );
              }
            }

            const roundLabelStyle = {
              padding: "3px 6px",
              textAlign: "center" as const,
              color: "#888",
              fontSize: "10px",
              whiteSpace: "nowrap" as const,
              borderRight: "1px solid #333",
            };

            // Double-pick rounds: render as two separate <tr> rows
            if (row.isDoublePick) {
              return [0, 1].map((subRow) => (
                <tr
                  key={`${row.round}-${subRow}`}
                  ref={isCurrentRound && subRow === 0 ? currentRoundRef : undefined}
                  style={{
                    backgroundColor: isCurrentRound ? "rgba(59,130,246,0.05)" : undefined,
                  }}
                >
                  {subRow === 0 && (
                    <td rowSpan={2} style={roundLabelStyle}>
                      <span>{row.round}</span>
                      <span style={{ marginLeft: "3px", fontSize: "9px", color: "#666" }}>
                        {row.isForward ? "\u2192" : "\u2190"}
                      </span>
                    </td>
                  )}
                  {seatOrder.map((seat) => {
                    const picks = seatPicks.get(seat) ?? [];
                    const pick = picks[subRow];
                    const isActive = pick && nextPickN !== null && pick.pickN === nextPickN;
                    return (
                      <DraftBoardCell
                        key={seat}
                        cardName={pick?.cardName || null}
                        manaCost={pick?.manaCost ?? null}
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
              ));
            }

            // Single-pick round: one <tr>
            return (
              <tr
                key={row.round}
                ref={isCurrentRound ? currentRoundRef : undefined}
                style={{
                  backgroundColor: isCurrentRound ? "rgba(59,130,246,0.05)" : undefined,
                }}
              >
                <td style={roundLabelStyle}>
                  <span>{row.round}</span>
                  <span style={{ marginLeft: "3px", fontSize: "9px", color: "#666" }}>
                    {row.isForward ? "\u2192" : "\u2190"}
                  </span>
                </td>
                {seatOrder.map((seat) => {
                  const picks = seatPicks.get(seat) ?? [];
                  const pick = picks[0];
                  const isActive = pick && nextPickN !== null && pick.pickN === nextPickN;
                  return (
                    <DraftBoardCell
                      key={seat}
                      cardName={pick?.cardName || null}
                      manaCost={pick?.manaCost ?? null}
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
          })}
        </tbody>
      </table>
    </div>
  );
}
