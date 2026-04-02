"use client";

import { useState, useCallback, useEffect, useRef } from "react";

export interface MatchResultData {
  mySeat: number;
  opponent: number;
  wins: number;
  losses: number;
}

interface MatchReportingProps {
  draftId: string;
  mySeat: number;
  token: string;
  numSeats: number;
  seatNames: Record<string, string>;
  onMatchReported: (data: MatchResultData) => void;
  onMatchReverted: () => void;
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

  const inputClassName = `w-10 px-1 py-0.5 text-[11px] border border-zinc-600 rounded text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield] ${
    input.saved ? "bg-zinc-900 text-zinc-500" : "bg-zinc-800 text-zinc-200"
  }`;

  return (
    <div
      ref={rowRef}
      className="flex items-center gap-2 text-xs"
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    >
      <span
        className={`min-w-[100px] overflow-hidden text-ellipsis whitespace-nowrap ${
          input.saved ? "text-zinc-600" : "text-zinc-400"
        }`}
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
        className={inputClassName}
      />
      <span className="text-zinc-600">-</span>
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
        className={inputClassName}
      />
      <div className="w-5 flex justify-center">
        {input.saving && (
          <span className="text-zinc-500 text-[11px]">...</span>
        )}
        {!input.saving && input.saved && (
          <button
            disabled
            className="cursor-default bg-zinc-800 border border-gray-700 rounded px-0.5 py-px flex items-center justify-center text-emerald-300"
            title="Match result saved"
            aria-label="Match result saved"
          >
            <CheckIcon className="h-4 w-4" />
          </button>
        )}
        {!input.saving && canSave && focused && (
          <button
            onClick={() => onSave(opponent)}
            className="cursor-pointer bg-zinc-700 border border-zinc-600 rounded px-0.5 py-px flex items-center justify-center text-zinc-200"
            title="Save match result"
            aria-label="Save match result"
          >
            <CheckIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      {input.error && (
        <span className="text-red-500 text-[11px]">{input.error}</span>
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
  onMatchReverted,
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

      // Optimistic: update standings immediately before the POST
      onMatchReported({ mySeat, opponent, wins, losses });

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
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setInputs((prev) => ({
          ...prev,
          [opponent]: { ...prev[opponent], saving: false, error: message },
        }));
        onMatchReverted();
      }
    },
    [inputs, draftId, mySeat, token, onMatchReported, onMatchReverted],
  );

  return (
    <div className="mt-4">
      <h3 className="text-[13px] font-semibold text-zinc-200 mb-2">
        Report Match Results
      </h3>
      <div className="flex flex-col gap-1.5">
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
