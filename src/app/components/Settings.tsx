"use client";

import { useState, useRef, useEffect } from "react";
import { DraftSelector } from "./DraftSelector";

export interface SettingsProps {
  // Draft selection
  drafts: Array<{ id: string; name: string; date: string }>;
  selectedDrafts: Set<string>;
  onDraftsChange: (selected: Set<string>) => void;
  isDraftDataLoading?: boolean;
  // Win equity visibility
  showWinEquity: boolean;
  onToggleWinEquity: (enabled: boolean) => void;
  // Raw win rate visibility
  showRawWinRate: boolean;
  onToggleRawWinRate: (enabled: boolean) => void;
}

export function Settings({
  drafts,
  selectedDrafts,
  onDraftsChange,
  isDraftDataLoading = false,
  showWinEquity,
  onToggleWinEquity,
  showRawWinRate,
  onToggleRawWinRate,
}: SettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

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
        onClick={() => setIsOpen(true)}
        className="cursor-pointer rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
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
              {/* Drafts section */}
              <div className="mb-6">
                <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Drafts
                  {isDraftDataLoading && (
                    <span className="ml-2 text-xs text-zinc-500">(Loading...)</span>
                  )}
                </h3>
                <DraftSelector
                  drafts={drafts}
                  selectedDrafts={selectedDrafts}
                  onChange={onDraftsChange}
                  disabled={isDraftDataLoading}
                />
              </div>

              {/* Win Equity toggle */}
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={showWinEquity}
                  onChange={(e) => onToggleWinEquity(e.target.checked)}
                  className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-zinc-700 dark:text-zinc-300">
                  Show Win Equity column (experimental)
                </span>
              </label>

              {/* Raw Win Rate toggle */}
              <label className="mt-4 flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={showRawWinRate}
                  onChange={(e) => onToggleRawWinRate(e.target.checked)}
                  className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-zinc-700 dark:text-zinc-300">
                  Show Win Rate column (experimental)
                </span>
              </label>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
