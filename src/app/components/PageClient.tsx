"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { CardTable, ColorFilter, QueryBox, Settings } from "./index";
import type { ColorFilterMode } from "./ColorFilter";
import type { EnrichedCardStats, DraftDataFile, ScryCard, CardPick } from "@/core/types";
import { useLocalStorage, useIsHydrated } from "../hooks/useLocalStorage";
import { CardDataProvider } from "../hooks/CardDataContext";
import { calculateCardStats, metadataToMap, DISTRIBUTION_BUCKET_COUNT } from "@/core/calculateStats";
import { searchLocalCards } from "@/core/localSearch";
import { hasScryfallOperators } from "@/core/searchUtils";
import { calculateWinEquity, calculateRawWinRate } from "@/core/winEquity";
import { aggregatePlayerStats } from "@/core/parseMatches";
import { cardNameKey } from "@/core/parseCsv";

const STORAGE_KEY_SHOW_WIN_EQUITY = "rtb-show-win-equity";
const STORAGE_KEY_SHOW_RAW_WIN_RATE = "rtb-show-raw-win-rate";

export interface PageClientProps {
  initialCards: EnrichedCardStats[];
  draftCount: number;
  currentCubeCopies: Record<string, number>;
  draftIds: string[];
  draftMetadata: Record<string, { name: string; date: string }>;
  scryfallData: Record<string, ScryCard>;
}

/**
 * Client-side page component with state management.
 *
 * Handles:
 * - Search query filtering
 * - Color filter selection
 * - Draft selection (recalculates stats client-side)
 */
export function PageClient({
  initialCards,
  draftCount,
  currentCubeCopies,
  draftIds,
  draftMetadata,
  scryfallData,
}: PageClientProps) {
  // UI state (not persisted)
  const [searchQuery, setSearchQuery] = useState("");
  const [colorFilter, setColorFilter] = useState<string[]>([]);
  const [colorFilterMode, setColorFilterMode] = useState<ColorFilterMode>("inclusive");

  // Local search state
  const [scryfallSearchResults, setScryfallSearchResults] = useState<ScryCard[] | null>(null);

  // Draft selection state
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(() => new Set(draftIds));
  const [draftData, setDraftData] = useState<DraftDataFile | null>(null);
  const [isDraftDataLoading, setIsDraftDataLoading] = useState(false);

  // Persisted state using localStorage
  const [showWinEquity, setShowWinEquity] = useLocalStorage<boolean>(
    STORAGE_KEY_SHOW_WIN_EQUITY,
    false
  );
  const [showRawWinRate, setShowRawWinRate] = useLocalStorage<boolean>(
    STORAGE_KEY_SHOW_RAW_WIN_RATE,
    false
  );

  // Check hydration status
  const isHydrated = useIsHydrated();

  // Build drafts array for selector
  const drafts = useMemo(
    () =>
      draftIds.map((id) => ({
        id,
        name: draftMetadata[id]?.name || id,
        date: draftMetadata[id]?.date || "1970-01-01",
      })),
    [draftIds, draftMetadata]
  );

  // Determine if using default selection (all drafts)
  const isDefaultSelection = selectedDrafts.size === draftIds.length;

  // Calculate displayed cards based on draft selection
  const { displayedCards, displayedCubeCopies, effectiveDraftCount } = useMemo(() => {
    // Empty selection - show nothing
    if (selectedDrafts.size === 0) {
      return { displayedCards: [], displayedCubeCopies: {}, effectiveDraftCount: 0 };
    }

    // Default selection - use precomputed data
    if (isDefaultSelection || !draftData) {
      return {
        displayedCards: initialCards,
        displayedCubeCopies: currentCubeCopies,
        effectiveDraftCount: draftCount,
      };
    }

    // Custom selection - recalculate from draft data
    const filteredPicks = draftData.picks.filter((p: CardPick) => selectedDrafts.has(p.draftId));

    // Find latest selected draft for cube filtering
    const selectedDraftsSorted = [...selectedDrafts].sort((a, b) => {
      const dateA = draftData.metadata[a]?.date || "1970-01-01";
      const dateB = draftData.metadata[b]?.date || "1970-01-01";
      return dateB.localeCompare(dateA);
    });
    const latestDraftId = selectedDraftsSorted[0];
    const latestPool = new Set(draftData.pools[latestDraftId] || []);

    // Build copy counts for latest pool
    const cubeCopies: Record<string, number> = {};
    for (const cardName of draftData.pools[latestDraftId] || []) {
      cubeCopies[cardName] = (cubeCopies[cardName] || 0) + 1;
    }

    // Calculate stats
    const metadataMap = metadataToMap(draftData.metadata);
    const stats = calculateCardStats(filteredPicks, metadataMap);

    // Build matchStats for selected drafts (seat-based)
    const matchStats = new Map<string, Map<number, { gamesWon: number; gamesLost: number }>>();
    for (const draftId of selectedDrafts) {
      const matches = draftData.matchResults?.[draftId];
      if (matches && matches.length > 0) {
        const playerStats = aggregatePlayerStats(matches);
        matchStats.set(draftId, playerStats);
      }
    }

    // Calculate win equity and raw win rate
    const scryfallMap = new Map(Object.entries(scryfallData));
    const winEquityResults = calculateWinEquity(filteredPicks, matchStats, scryfallMap);
    const rawWinRateResults = calculateRawWinRate(filteredPicks, matchStats);

    // Filter to latest pool and enrich with Scryfall data and win rates
    // Use cardNameKey for case-insensitive lookups
    const enriched: EnrichedCardStats[] = stats
      .filter((s) => latestPool.has(s.cardName))
      .map((s) => ({
        ...s,
        scryfall: scryfallData[cardNameKey(s.cardName)],
        winEquity: winEquityResults.get(cardNameKey(s.cardName)),
        rawWinRate: rawWinRateResults.get(cardNameKey(s.cardName)),
      }));

    // Add new cards (in pool but no picks)
    const cardsWithStats = new Set(stats.map((s) => s.cardName));
    const newCards: EnrichedCardStats[] = [...latestPool]
      .filter((name) => !cardsWithStats.has(name))
      .map((cardName) => ({
        cardName,
        weightedGeomean: Infinity,
        totalPicks: 0,
        timesAvailable: 0,
        draftsPickedIn: 0,
        timesUnpicked: 0,
        maxCopiesInDraft: 0,
        colors: [],
        scoreHistory: [],
        pickDistribution: new Array(DISTRIBUTION_BUCKET_COUNT).fill(0),
        scryfall: scryfallData[cardNameKey(cardName)],
      }));

    return {
      displayedCards: [...enriched, ...newCards],
      displayedCubeCopies: cubeCopies,
      effectiveDraftCount: selectedDrafts.size,
    };
  }, [
    selectedDrafts,
    isDefaultSelection,
    draftData,
    initialCards,
    currentCubeCopies,
    draftCount,
    scryfallData,
  ]);

  // Handle draft selection change
  const handleDraftsChange = useCallback(
    async (newSelection: Set<string>) => {
      setSelectedDrafts(newSelection);

      // If selecting all or none, no need to fetch
      if (newSelection.size === 0 || newSelection.size === draftIds.length) {
        return;
      }

      // Need draft data for custom selection
      if (!draftData) {
        setIsDraftDataLoading(true);
        try {
          const response = await fetch("/api/draft-data.json");
          const data: DraftDataFile = await response.json();
          setDraftData(data);
        } catch (error) {
          console.error("Failed to load draft data:", error);
        } finally {
          setIsDraftDataLoading(false);
        }
      }
    },
    [draftData, draftIds.length]
  );

  // Debounced search effect - runs local search after 300ms of inactivity
  useEffect(() => {
    const query = searchQuery.trim();

    // No query - clear results
    if (!query) {
      setScryfallSearchResults(null);
      return;
    }

    // Only run structured search for operator queries
    if (!hasScryfallOperators(query)) {
      setScryfallSearchResults(null);
      return;
    }

    // Debounce the search
    const timeoutId = setTimeout(() => {
      const results = searchLocalCards(query, Object.values(scryfallData));
      setScryfallSearchResults(results);
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [searchQuery, scryfallData]);

  // Clear search completely
  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setScryfallSearchResults(null);
  }, []);

  // Build a Set of matching card names from Scryfall results for efficient lookup
  // Handles double-faced cards by also adding the front face name
  const scryfallMatchNames = useMemo(() => {
    if (!scryfallSearchResults) return null;
    const names = new Set<string>();
    for (const card of scryfallSearchResults) {
      names.add(card.name);
      // Also add front face for double-faced cards
      // e.g., "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki" -> "Fable of the Mirror-Breaker"
      if (card.name.includes(" // ")) {
        names.add(card.name.split(" // ")[0]);
      }
    }
    return names;
  }, [scryfallSearchResults]);

  // Filter displayed cards by Scryfall results when available
  const filteredDisplayedCards = useMemo(() => {
    if (!scryfallMatchNames) return displayedCards;
    return displayedCards.filter((card) => scryfallMatchNames.has(card.cardName));
  }, [displayedCards, scryfallMatchNames]);

  // Apply client-side name filtering when not using Scryfall
  const searchFilteredCards = useMemo(() => {
    // If using Scryfall filtering, cards are already filtered
    if (scryfallMatchNames) return filteredDisplayedCards;
    // Otherwise, apply client-side name filter
    if (!searchQuery) return filteredDisplayedCards;
    const query = searchQuery.toLowerCase();
    return filteredDisplayedCards.filter((card) =>
      card.cardName.toLowerCase().includes(query)
    );
  }, [filteredDisplayedCards, scryfallMatchNames, searchQuery]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">Read the Bones</h1>
            <h2 className="mt-1 text-base text-zinc-500 dark:text-zinc-400">
              samp cube roto draft analysis
            </h2>
            <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
              {effectiveDraftCount > 0 ? (
                <>
                  {displayedCards.length} cards from {effectiveDraftCount} draft
                  {effectiveDraftCount !== 1 ? "s" : ""}
                  {!isDefaultSelection && selectedDrafts.size > 0 && (
                    <span className="ml-1 text-blue-500">(filtered)</span>
                  )}
                </>
              ) : selectedDrafts.size === 0 ? (
                "No drafts selected"
              ) : (
                "No draft data found. Add draft folders to the data/ directory."
              )}
            </p>
          </div>

          {/* Settings gear icon */}
          {isHydrated && (
            <Settings
              drafts={drafts}
              selectedDrafts={selectedDrafts}
              onDraftsChange={handleDraftsChange}
              isDraftDataLoading={isDraftDataLoading}
              showWinEquity={showWinEquity}
              onToggleWinEquity={setShowWinEquity}
              showRawWinRate={showRawWinRate}
              onToggleRawWinRate={setShowRawWinRate}
            />
          )}
        </header>

        {/* Dark Confidant Chat - disabled for now
        <div className="mb-6">
          <details className="group rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800">
              <span className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 text-zinc-500 dark:text-zinc-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                    />
                  </svg>
                  Dark Confidant
                </span>
                <svg
                  className="h-4 w-4 text-zinc-400 transition-transform group-open:rotate-180"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </span>
            </summary>
            <div className="border-t border-zinc-200 dark:border-zinc-700">
              <div className="h-96">
                <CardDataProvider cards={initialCards}>
                  <QueryBox />
                </CardDataProvider>
              </div>
            </div>
          </details>
        </div>
        */}

        {/* Controls */}
        <div className="mb-6 space-y-4">
          {/* Search Input */}
          <div>
            <label htmlFor="search" className="sr-only">
              Search cards
            </label>
            <div className="flex items-center gap-2">
              <div className="relative w-full max-w-md">
                <input
                  id="search"
                  type="text"
                  placeholder="Search cards..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-4 pr-10 text-zinc-900 placeholder-zinc-500 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-400"
                />
                {/* Clear button */}
                {searchQuery && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    className="absolute top-1/2 right-3 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-zinc-500 dark:hover:text-zinc-300"
                    aria-label="Clear search"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                )}
              </div>
              {/* Syntax help tooltip */}
              <div className="group relative">
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 text-xs font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-300"
                  aria-label="Search syntax help"
                >
                  ?
                </button>
                <div className="absolute left-1/2 top-full z-50 mt-2 hidden w-64 -translate-x-1/2 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg group-hover:block dark:border-zinc-700 dark:bg-zinc-800">
                  <div className="mb-2 font-medium text-zinc-900 dark:text-zinc-100">Search Syntax</div>
                  <ul className="space-y-1 text-zinc-600 dark:text-zinc-300">
                    <li><code className="text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">t:creature</code> type</li>
                    <li><code className="text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">o:flying</code> oracle text</li>
                    <li><code className="text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">o:&quot;draw a card&quot;</code> phrase</li>
                    <li><code className="text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">c:r</code> color (w/u/b/r/g)</li>
                    <li><code className="text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">c:ub</code> multicolor</li>
                    <li><code className="text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">cmc=3</code> mana value</li>
                    <li><code className="text-xs bg-zinc-100 dark:bg-zinc-700 px-1 rounded">cmc&lt;=2</code> comparison</li>
                  </ul>
                  <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    Combine terms: <code className="bg-zinc-100 dark:bg-zinc-700 px-1 rounded">t:instant c:u</code>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Color Filter */}
          <ColorFilter
            selected={colorFilter}
            onChange={setColorFilter}
            mode={colorFilterMode}
            onModeChange={setColorFilterMode}
          />
        </div>

        {/* Card Table */}
        {searchFilteredCards.length > 0 ? (
          <CardTable
            cards={searchFilteredCards}
            colorFilter={colorFilter}
            colorFilterMode={colorFilterMode}
            currentCubeCopies={displayedCubeCopies}
            showWinEquity={showWinEquity}
            showRawWinRate={showRawWinRate}
          />
        ) : (
          <div className="rounded-lg border border-zinc-200 bg-white p-12 text-center dark:border-zinc-700 dark:bg-zinc-900">
            <p className="text-zinc-500 dark:text-zinc-400">
              {selectedDrafts.size === 0
                ? "No drafts selected. Open Settings to select drafts."
                : scryfallMatchNames
                  ? "No cards in your pool match that search."
                  : displayedCards.length === 0
                    ? "No card data available. Make sure draft data exists in the data/ directory."
                    : "No cards match your filters."}
            </p>
          </div>
        )}

        {/* Loading overlay */}
        {isDraftDataLoading && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20">
            <div className="rounded-lg bg-white px-6 py-4 shadow-lg dark:bg-zinc-800">
              <p className="text-zinc-700 dark:text-zinc-300">Loading draft data...</p>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="mt-8 pb-4 text-center text-sm text-zinc-400 dark:text-zinc-500">
          Made by{" "}
          <a
            href="https://github.com/strunkandwhite"
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
          >
            Jack
          </a>
        </footer>
      </div>
    </div>
  );
}
