"use client";

import { MTG_COLORS } from "../../core/colors";

export type ColorFilterMode = "inclusive" | "exclusive";

export interface ColorFilterProps {
  selected: string[];
  onChange: (colors: string[]) => void;
  mode: ColorFilterMode;
  onModeChange: (mode: ColorFilterMode) => void;
}

export function ColorFilter({ selected, onChange, mode, onModeChange }: ColorFilterProps) {
  const toggleColor = (code: string) => {
    if (selected.includes(code)) {
      onChange(selected.filter((c) => c !== code));
    } else {
      onChange([...selected, code]);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
        Filter by color:
      </span>
      {MTG_COLORS.map((color) => {
        const isSelected = selected.includes(color.code);
        return (
          <button
            key={color.code}
            onClick={() => toggleColor(color.code)}
            className={`cursor-pointer rounded-md p-1.5 transition-all ${isSelected ? "bg-zinc-200 ring-2 ring-blue-500 dark:bg-zinc-700" : "bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"} ${isSelected ? "" : "opacity-60 hover:opacity-100"} `}
            aria-pressed={isSelected}
            aria-label={`Filter by ${color.label}`}
          >
            <img
              src={`https://svgs.scryfall.io/card-symbols/${color.code}.svg`}
              alt={color.label}
              width={20}
              height={20}
              className="inline-block"
            />
          </button>
        );
      })}
      {selected.length > 0 && (
        <>
          <button
            onClick={() => onModeChange(mode === "inclusive" ? "exclusive" : "inclusive")}
            className="cursor-pointer rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            title={
              mode === "inclusive"
                ? "Inclusive: shows cards containing ANY selected color"
                : "Exclusive: shows cards with ONLY selected colors"
            }
          >
            {mode === "inclusive" ? "Any" : "Only"}
          </button>
          <button
            onClick={() => onChange([])}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Clear
          </button>
        </>
      )}
    </div>
  );
}
