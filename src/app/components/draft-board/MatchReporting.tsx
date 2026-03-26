"use client";

import { useState, useCallback, useEffect, useRef } from "react";

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

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5l3.5 3.5 6.5-7" />
    </svg>
  );
}

function MatchRow({
  opponent,
  oppName,
  input,
  onUpdate,
  onSave,
}: {
  opponent: number;
  oppName: string;
  input: MatchInput;
  onUpdate: (opponent: number, field: "wins" | "losses", value: string) => void;
  onSave: (opponent: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const canSave = input.wins !== "" && input.losses !== "" && !input.saving && !input.saved;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSave) {
      e.preventDefault();
      onSave(opponent);
    }
  };

  const handleFocusSaved = () => {
    if (input.saved) {
      onUpdate(opponent, "wins", input.wins);
    }
  };

  const handleBlur = (e: React.FocusEvent) => {
    if (!rowRef.current?.contains(e.relatedTarget as Node)) {
      setFocused(false);
    }
  };

  const inputStyle = {
    width: "40px",
    padding: "2px 4px",
    fontSize: "11px",
    backgroundColor: input.saved ? "#1c1c1e" : "#27272a",
    border: "1px solid #444",
    borderRadius: "4px",
    color: input.saved ? "#888" : "#e0e0e0",
    textAlign: "center" as const,
    MozAppearance: "textfield" as const,
  };

  return (
    <div
      ref={rowRef}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "12px",
      }}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    >
      <span
        style={{
          color: input.saved ? "#666" : "#bbb",
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
        onFocus={handleFocusSaved}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || (Number(v) >= 0 && Number(v) <= 2)) onUpdate(opponent, "wins", v);
        }}
        onKeyDown={handleKeyDown}
        className="[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        style={inputStyle}
      />
      <span style={{ color: "#666" }}>-</span>
      <input
        type="number"
        min={0}
        max={2}
        placeholder="L"
        value={input.losses}
        onFocus={handleFocusSaved}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || (Number(v) >= 0 && Number(v) <= 2)) onUpdate(opponent, "losses", v);
        }}
        onKeyDown={handleKeyDown}
        className="[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        style={inputStyle}
      />
      <div style={{ width: "20px", display: "flex", justifyContent: "center" }}>
        {input.saving && (
          <span style={{ color: "#888", fontSize: "11px" }}>...</span>
        )}
        {!input.saving && canSave && focused && (
          <button
            onClick={() => onSave(opponent)}
            style={{ cursor: "pointer", background: "none", border: "none", padding: 0 }}
            title="Save match result"
            aria-label="Save match result"
          >
            <CheckIcon className="h-4 w-4 text-emerald-500" />
          </button>
        )}
      </div>
      {input.error && (
        <span style={{ color: "#ef4444", fontSize: "11px" }}>{input.error}</span>
      )}
    </div>
  );
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

      if (isNaN(wins) || isNaN(losses) || wins < 0 || losses < 0 || wins > 2 || losses > 2) {
        setInputs((prev) => ({
          ...prev,
          [opponent]: { ...prev[opponent], error: "Values must be 0, 1, or 2" },
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
        {opponents.map((opp) => (
          <MatchRow
            key={opp}
            opponent={opp}
            oppName={seatNames[String(opp)] || `Seat ${opp}`}
            input={inputs[opp]}
            onUpdate={updateInput}
            onSave={handleSave}
          />
        ))}
      </div>
    </div>
  );
}
