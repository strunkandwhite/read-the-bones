"use client";

import { useState } from "react";
import { track } from "@vercel/analytics/react";
import type { BasicLandCounts } from "@/core/types";

const BASIC_LAND_NAMES: (keyof BasicLandCounts)[] = [
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
];

const LAND_MANA_SYMBOL: Record<string, string> = {
  Plains: "W",
  Island: "U",
  Swamp: "B",
  Mountain: "R",
  Forest: "G",
};

const LAND_COLORS: Record<string, string> = {
  Plains: "bg-amber-100 dark:bg-amber-900/30",
  Island: "bg-blue-100 dark:bg-blue-900/30",
  Swamp: "bg-zinc-300 dark:bg-zinc-700",
  Mountain: "bg-red-100 dark:bg-red-900/30",
  Forest: "bg-green-100 dark:bg-green-900/30",
};

interface BasicLandsDialogProps {
  basicLands: BasicLandCounts;
  onSave: (lands: BasicLandCounts) => void;
  onClose: () => void;
}

export function BasicLandsDialog({
  basicLands,
  onSave,
  onClose,
}: BasicLandsDialogProps) {
  const [counts, setCounts] = useState<BasicLandCounts>({ ...basicLands });

  const update = (land: keyof BasicLandCounts, delta: number) => {
    setCounts((prev) => ({
      ...prev,
      [land]: Math.max(0, prev[land] + delta),
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-72 rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-zinc-200">
            Add Basic Lands
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="space-y-2">
          {BASIC_LAND_NAMES.map((land) => (
            <div
              key={land}
              className={`flex items-center justify-between rounded-md px-3 py-1.5 ${LAND_COLORS[land]}`}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-200">
                <img
                  src={`/mana/${LAND_MANA_SYMBOL[land]}.svg`}
                  alt={LAND_MANA_SYMBOL[land]}
                  width={16}
                  height={16}
                  className="inline-block"
                />
                {land}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => update(land, -1)}
                  className="cursor-pointer flex h-6 w-6 items-center justify-center rounded bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
                >
                  -
                </button>
                <span className="w-4 text-center text-sm font-mono text-zinc-200">
                  {counts[land]}
                </span>
                <button
                  onClick={() => update(land, 1)}
                  className="cursor-pointer flex h-6 w-6 items-center justify-center rounded bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="cursor-pointer rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const totalLands = Object.values(counts).reduce((sum, n) => sum + n, 0);
              if (totalLands > 0) {
                track("deck_lands_added", { total_lands: totalLands });
              }
              onSave(counts);
              onClose();
            }}
            className="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
