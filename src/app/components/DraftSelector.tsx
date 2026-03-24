"use client";

import { track } from "@vercel/analytics/react";

export interface DraftSelectorProps {
  drafts: Array<{ id: string; name: string; date: string; isComplete?: boolean }>;
  selectedDrafts: Set<string>;
  onChange: (selected: Set<string>) => void;
  disabled?: boolean;
}

/**
 * Checkbox list for selecting which drafts to include in stats.
 * Sorted by date descending (most recent first).
 */
export function DraftSelector({
  drafts,
  selectedDrafts,
  onChange,
  disabled = false,
}: DraftSelectorProps) {
  // Sort by date descending
  const sortedDrafts = [...drafts].sort((a, b) => b.date.localeCompare(a.date));

  const toggleDraft = (draftId: string) => {
    const newSelection = new Set(selectedDrafts);
    if (newSelection.has(draftId)) {
      newSelection.delete(draftId);
    } else {
      newSelection.add(draftId);
    }
    onChange(newSelection);
    track("draft_filter_changed", { selected_count: newSelection.size, action: "toggle" });
  };

  const selectAll = () => {
    const all = new Set(drafts.map((d) => d.id));
    onChange(all);
    track("draft_filter_changed", { selected_count: all.size, action: "select_all" });
  };
  const selectNone = () => {
    onChange(new Set());
    track("draft_filter_changed", { selected_count: 0, action: "select_none" });
  };

  return (
    <div className={disabled ? "opacity-50" : ""}>
      <div className="mb-2 flex gap-2">
        <button
          onClick={selectAll}
          disabled={disabled}
          className="cursor-pointer px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:cursor-not-allowed dark:text-blue-400 dark:hover:text-blue-300"
        >
          Select all
        </button>
        <button
          onClick={selectNone}
          disabled={disabled}
          className="cursor-pointer px-2 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-700 disabled:cursor-not-allowed dark:text-zinc-400 dark:hover:text-zinc-300"
        >
          Select none
        </button>
      </div>

      <div className="max-h-48 space-y-1 overflow-y-auto">
        {sortedDrafts.map((draft) => (
          <label
            key={draft.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          >
            <input
              type="checkbox"
              checked={selectedDrafts.has(draft.id)}
              onChange={() => toggleDraft(draft.id)}
              disabled={disabled}
              className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed"
            />
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {draft.date}: {draft.name}
              {draft.isComplete === false && (
                <span className="ml-1.5 text-xs text-zinc-400 dark:text-zinc-500" title="Draft is still in progress">
                  (in progress)
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      {selectedDrafts.size === 0 && (
        <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">No drafts selected</p>
      )}
    </div>
  );
}
