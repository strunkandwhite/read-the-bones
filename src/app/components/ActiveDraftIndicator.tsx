"use client";

import { useState } from "react";
import { track } from "@vercel/analytics/react";

type ActiveDraftIndicatorProps = {
  draftName: string;
  availableCount: number;
  bannedCardNames?: string[];
  lastSyncedAt: string;
  syncInProgress: boolean;
  draftComplete: boolean;
  onSyncNow: () => void;
  syncDisabled: boolean;
};

export function ActiveDraftIndicator({
  draftName,
  availableCount,
  bannedCardNames,
  lastSyncedAt,
  syncInProgress,
  draftComplete,
  onSyncNow,
  syncDisabled,
}: ActiveDraftIndicatorProps) {
  const timeAgo = formatTimeAgo(lastSyncedAt);

  if (draftComplete) return null;

  const syncLabel = syncInProgress ? "Syncing…" : `Synced ${timeAgo}`;

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          syncInProgress ? "bg-amber-400 animate-pulse" : "bg-emerald-400"
        }`}
      />
      <span className="text-zinc-400" title={`${draftName} — ${availableCount} available`}>{availableCount}A</span>
      {bannedCardNames && bannedCardNames.length > 0 && (
        <>
          <span className="text-zinc-600">·</span>
          <BansTooltip bannedCardNames={bannedCardNames} />
        </>
      )}
      <button
        onClick={() => {
          const then = parseInt(lastSyncedAt, 10) * 1000;
          const secondsSinceLast = isNaN(then) || then === 0 ? -1 : Math.floor((Date.now() - then) / 1000);
          track("sync_manual", {
            draft: draftName,
            seconds_since_last: secondsSinceLast,
          });
          onSyncNow();
        }}
        disabled={syncDisabled || syncInProgress}
        title={syncLabel}
        className="ml-0.5 cursor-pointer rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
      >
        {syncInProgress ? "…" : "Sync"}
      </button>
    </div>
  );
}

function BansTooltip({ bannedCardNames }: { bannedCardNames: string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="text-zinc-500 cursor-default hover:text-zinc-400 transition-colors" title={`${bannedCardNames.length} banned`}>
        {bannedCardNames.length}B
      </span>
      {open && (
        <div className="absolute left-1/2 top-full z-50 mt-3 -translate-x-1/2 rounded border border-zinc-700 bg-zinc-800 px-3 py-2.5 shadow-lg">
          <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 h-2.5 w-2.5 rotate-45 border-l border-t border-zinc-700 bg-zinc-800" />
          <div className="text-xs font-medium text-zinc-500 mb-1.5">Banned</div>
          <ul className="text-sm text-zinc-300 whitespace-nowrap space-y-0.5">
            {bannedCardNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

function formatTimeAgo(unixSecondsStr: string): string {
  const then = parseInt(unixSecondsStr, 10) * 1000;
  if (isNaN(then) || then === 0) return "never";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
