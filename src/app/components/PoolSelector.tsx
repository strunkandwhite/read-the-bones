"use client";

import { useMemo } from "react";

export interface PoolSelectorProps {
  drafts: Array<{ id: string; name: string; date: string }>;
  selectedDraftId: string | null;
  onChange: (draftId: string | null) => void;
  disabled?: boolean;
}

/**
 * Dropdown for selecting which draft's card pool to display.
 * Groups drafts by date using <optgroup> elements.
 * Default ("Latest pool") uses the most recent draft's cube snapshot.
 */
export function PoolSelector({
  drafts,
  selectedDraftId,
  onChange,
  disabled = false,
}: PoolSelectorProps) {
  const groupedByDate = useMemo(() => {
    const sorted = [...drafts].sort((a, b) => b.date.localeCompare(a.date));
    const groups: Array<{ date: string; drafts: typeof sorted }> = [];
    for (const draft of sorted) {
      const last = groups[groups.length - 1];
      if (last && last.date === draft.date) {
        last.drafts.push(draft);
      } else {
        groups.push({ date: draft.date, drafts: [draft] });
      }
    }
    return groups;
  }, [drafts]);

  return (
    <div className={`relative${disabled ? "opacity-50" : ""}`}>
      <select
        id="pool-selector"
        value={selectedDraftId ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        className="block w-full appearance-none rounded-lg border border-zinc-300 bg-white py-1.5 pr-9 pl-3 text-sm text-zinc-900 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
      >
        <option value="">Latest pool</option>
        {groupedByDate.map((group) => (
          <optgroup key={group.date} label={group.date}>
            {group.drafts.map((draft) => (
              <option key={draft.id} value={draft.id}>
                {draft.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-zinc-400"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
          clipRule="evenodd"
        />
      </svg>
    </div>
  );
}
