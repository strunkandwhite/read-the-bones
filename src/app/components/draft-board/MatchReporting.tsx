"use client";

import { useState, useCallback, useEffect } from "react";

interface MatchReportingProps {
  draftId: string;
  mySeat: number;
  token: string;
  numSeats: number;
  seatNames: Record<string, string>;
  onMatchReported: () => void;
}

interface MatchInput {
  wins: string;
  losses: string;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

export function MatchReporting({
  draftId,
  mySeat,
  token,
  numSeats,
  seatNames,
  onMatchReported,
}: MatchReportingProps) {
  const opponents: number[] = [];
  for (let s = 1; s <= numSeats; s++) {
    if (s !== mySeat) opponents.push(s);
  }

  const [inputs, setInputs] = useState<Record<number, MatchInput>>(() => {
    const initial: Record<number, MatchInput> = {};
    for (const opp of opponents) {
      initial[opp] = { wins: "", losses: "", saving: false, error: null, saved: false };
    }
    return initial;
  });

  // Pre-fill inputs from existing match results
  useEffect(() => {
    async function fetchExisting() {
      try {
        const res = await fetch(`/api/drafts/${draftId}/standings`);
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.matches)) return;

        setInputs((prev) => {
          const updated = { ...prev };
          for (const match of data.matches) {
            const isSeat1 = match.seat1 === mySeat;
            const isSeat2 = match.seat2 === mySeat;
            if (!isSeat1 && !isSeat2) continue;

            const opponent = isSeat1 ? match.seat2 : match.seat1;
            const myWins = isSeat1 ? match.seat1Wins : match.seat2Wins;
            const myLosses = isSeat1 ? match.seat2Wins : match.seat1Wins;

            if (opponent in updated) {
              updated[opponent] = {
                ...updated[opponent],
                wins: String(myWins),
                losses: String(myLosses),
                saved: true,
              };
            }
          }
          return updated;
        });
      } catch { /* ignore */ }
    }

    fetchExisting();
  }, [draftId, mySeat]);

  const updateInput = useCallback((opponent: number, field: "wins" | "losses", value: string) => {
    setInputs((prev) => ({
      ...prev,
      [opponent]: { ...prev[opponent], [field]: value, error: null, saved: false },
    }));
  }, []);

  const handleSave = useCallback(
    async (opponent: number) => {
      const input = inputs[opponent];
      const wins = parseInt(input.wins, 10);
      const losses = parseInt(input.losses, 10);

      if (isNaN(wins) || isNaN(losses) || wins < 0 || losses < 0) {
        setInputs((prev) => ({
          ...prev,
          [opponent]: { ...prev[opponent], error: "Enter valid win/loss numbers" },
        }));
        return;
      }

      setInputs((prev) => ({
        ...prev,
        [opponent]: { ...prev[opponent], saving: true, error: null },
      }));

      try {
        const res = await fetch(`/api/drafts/${draftId}/match`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Seat-Token": token,
          },
          body: JSON.stringify({
            opponent_seat: opponent,
            wins,
            losses,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }

        setInputs((prev) => ({
          ...prev,
          [opponent]: { ...prev[opponent], saving: false, saved: true },
        }));
        onMatchReported();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setInputs((prev) => ({
          ...prev,
          [opponent]: { ...prev[opponent], saving: false, error: message },
        }));
      }
    },
    [inputs, draftId, token, onMatchReported],
  );

  return (
    <div style={{ marginTop: "16px" }}>
      <h3
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "#e0e0e0",
          marginBottom: "8px",
        }}
      >
        Report Match Results
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {opponents.map((opp) => {
          const input = inputs[opp];
          const oppName = seatNames[String(opp)] || `Seat ${opp}`;
          return (
            <div
              key={opp}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "12px",
              }}
            >
              <span
                style={{
                  color: "#bbb",
                  minWidth: "100px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={oppName}
              >
                vs {oppName}
              </span>
              <input
                type="number"
                min={0}
                max={2}
                placeholder="W"
                value={input.wins}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || (Number(v) >= 0 && Number(v) <= 2)) updateInput(opp, "wins", v);
                }}
                className="[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{
                  width: "40px",
                  padding: "2px 4px",
                  fontSize: "11px",
                  backgroundColor: "#27272a",
                  border: "1px solid #444",
                  borderRadius: "4px",
                  color: "#e0e0e0",
                  textAlign: "center",
                  MozAppearance: "textfield",
                }}
              />
              <span style={{ color: "#666" }}>-</span>
              <input
                type="number"
                min={0}
                max={2}
                placeholder="L"
                value={input.losses}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || (Number(v) >= 0 && Number(v) <= 2)) updateInput(opp, "losses", v);
                }}
                className="[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{
                  width: "40px",
                  padding: "2px 4px",
                  fontSize: "11px",
                  backgroundColor: "#27272a",
                  border: "1px solid #444",
                  borderRadius: "4px",
                  color: "#e0e0e0",
                  textAlign: "center",
                  MozAppearance: "textfield",
                }}
              />
              <button
                onClick={() => handleSave(opp)}
                disabled={input.saving}
                style={{
                  padding: "2px 10px",
                  fontSize: "11px",
                  backgroundColor: input.saved ? "#27272a" : "#3f3f46",
                  color: input.saved ? "#6ee7b7" : "#e0e0e0",
                  border: input.saved ? "1px solid #374151" : "1px solid #52525b",
                  borderRadius: "4px",
                  cursor: input.saving ? "not-allowed" : "pointer",
                  opacity: input.saving ? 0.6 : 1,
                }}
              >
                {input.saving ? "..." : input.saved ? "Saved" : "Save"}
              </button>
              {input.error && (
                <span style={{ color: "#ef4444", fontSize: "11px" }}>{input.error}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
