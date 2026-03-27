"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { track } from "@vercel/analytics/react";
import { DraftSelector } from "./DraftSelector";
import { PoolSelector } from "./PoolSelector";
import type { ActiveDraftInfo } from "../hooks/useSyncStatus";

export interface SettingsProps {
  drafts: Array<{ id: string; name: string; date: string; numDrafters: number }>;
  selectedDrafts: Set<string>;
  onDraftsChange: (selected: Set<string>) => void;
  isLoading?: boolean;
  // Active draft filtering
  activeDrafts: ActiveDraftInfo[];
  activeDraft: string | null;
  onActiveDraftChange: (draftId: string | null) => void;
  hideTaken: boolean;
  onHideTakenChange: (hide: boolean) => void;
  // Seat selection
  selectedSeat: number | null;
  onSelectedSeatChange: (seat: number | null) => void;
  activeDraftNumSeats: number;
  // Pool as-of filtering
  poolAsOfDraft: string | null;
  onPoolAsOfDraftChange: (draftId: string | null) => void;
  poolLockedByActiveDraft: boolean;
}

export function Settings({
  drafts,
  selectedDrafts,
  onDraftsChange,
  isLoading = false,
  activeDrafts,
  activeDraft,
  onActiveDraftChange,
  hideTaken,
  onHideTakenChange,
  selectedSeat,
  onSelectedSeatChange,
  activeDraftNumSeats,
  poolAsOfDraft,
  onPoolAsOfDraftChange,
  poolLockedByActiveDraft,
}: SettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const activeDraftIds = useMemo(() => new Set(activeDrafts.map((d) => d.id)), [activeDrafts]);
  const completedDrafts = useMemo(() => drafts.filter((d) => !activeDraftIds.has(d.id)), [drafts, activeDraftIds]);

  // Close modal when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  return (
    <>
      {/* Gear icon button */}
      <button
        onClick={() => {
          setIsOpen(true);
          track("settings_open");
        }}
        className="cursor-pointer rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        title="Settings"
        aria-label="Settings"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-6 w-6"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
          />
        </svg>
      </button>

      {/* Modal overlay */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 py-8">
          <div
            ref={modalRef}
            className="mx-4 flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-800"
          >
            {/* Fixed header */}
            <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-700">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Settings</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="cursor-pointer text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="h-5 w-5"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Draft view section */}
              <div className="mb-6">
                <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Draft view
                </h3>
                <div className="flex gap-3">
                  <div className="relative flex-1">
                    <select
                      value={activeDraft ?? ""}
                      onChange={(e) => onActiveDraftChange(e.target.value || null)}
                      className="block w-full appearance-none rounded-lg border border-zinc-300 bg-white py-1.5 pl-3 pr-9 text-sm text-zinc-900 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="">None</option>
                      {activeDrafts.length > 0 ? (
                        <>
                          <optgroup label="Active">
                            {activeDrafts.map((d) => (
                              <option key={d.id} value={d.id}>{d.id}</option>
                            ))}
                          </optgroup>
                          {completedDrafts.length > 0 && (
                            <optgroup label="Completed">
                              {completedDrafts.map((d) => (
                                <option key={d.id} value={d.id}>{d.id}</option>
                              ))}
                            </optgroup>
                          )}
                        </>
                      ) : (
                        drafts.map((d) => (
                          <option key={d.id} value={d.id}>{d.id}</option>
                        ))
                      )}
                    </select>
                    <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                    </svg>
                  </div>

                  {activeDraft && (
                    <div className="relative flex-1">
                      <select
                        value={selectedSeat ?? ""}
                        onChange={(e) => onSelectedSeatChange(e.target.value ? Number(e.target.value) : null)}
                        className="block w-full appearance-none rounded-lg border border-zinc-300 bg-white py-1.5 pl-3 pr-9 text-sm text-zinc-900 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
                      >
                        <option value="">No seat</option>
                        {Array.from({ length: activeDraftNumSeats }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>Seat {n}</option>
                        ))}
                      </select>
                      <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                      </svg>
                    </div>
                  )}
                </div>

                {activeDraft && (
                  <label className="mt-2 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={hideTaken}
                      onChange={(e) => {
                        onHideTakenChange(e.target.checked);
                        track("hide_taken_toggled", { enabled: e.target.checked });
                      }}
                      className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                    />
                    Hide taken cards
                  </label>
                )}
              </div>

              {/* Pool as-of section */}
              <div className="mb-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
                <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Show pool as of...
                  {poolLockedByActiveDraft && (
                    <span className="ml-1 text-xs font-normal text-zinc-500 dark:text-zinc-400" title="Pool is locked to the active draft">
                      (locked to active draft)
                    </span>
                  )}
                </h3>
                <PoolSelector
                  drafts={drafts}
                  selectedDraftId={poolAsOfDraft}
                  onChange={onPoolAsOfDraftChange}
                  disabled={isLoading || poolLockedByActiveDraft}
                />
              </div>

              {/* Drafts section */}
              <div className="mb-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
                <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Collect pick data from...
                  {isLoading && (
                    <span className="ml-2 text-xs text-zinc-500">(Loading...)</span>
                  )}
                </h3>
                <DraftSelector
                  drafts={drafts}
                  selectedDrafts={selectedDrafts}
                  onChange={onDraftsChange}
                  disabled={isLoading}
                />
              </div>

              {/* Clear local state */}
              <div className="border-t border-zinc-200 pt-6 dark:border-zinc-700">
                <button
                  onClick={() => {
                    localStorage.clear();
                    track("clear_local_state");
                    window.location.reload();
                  }}
                  className="w-full cursor-pointer rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950"
                >
                  Clear local state
                </button>
                <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Resets draft selection, seat tokens, and deck builder data.
                </p>
              </div>

            </div>
          </div>
        </div>
      )}
    </>
  );
}
