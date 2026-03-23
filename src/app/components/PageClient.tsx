"use client";

import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { track } from "@vercel/analytics/react";
import { ActiveDraftIndicator } from "./ActiveDraftIndicator";
import { CardTable } from "./CardTable";
import { ColorFilter } from "./ColorFilter";
import { Settings } from "./Settings";
import { StatsModal } from "./StatsModal";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useDraftSelection } from "../hooks/useDraftSelection";
import { useCardData } from "../hooks/useCardData";
import { useCardSearch } from "../hooks/useCardSearch";
import { useCardFiltering } from "../hooks/useCardFiltering";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import type { ScryCard, CardStats } from "@/core/types";
import { DeckBuilderPanel } from "./deck-builder/DeckBuilderPanel";
import { useDeckBuilder } from "../hooks/useDeckBuilder";


export interface PageClientProps {
  initialCardData: CardStatsResponse;
  initialDraftStats: DraftStatsResponse;
}

/**
 * Client-side page component with state management.
 *
 * Handles:
 * - Search query filtering
 * - Color filter selection
 * - Draft selection (fetches recalculated stats from API)
 */
export function PageClient({ initialCardData, initialDraftStats }: PageClientProps) {
  const draftSelection = useDraftSelection({
    completedDraftIds: initialCardData.completedDraftIds,
  });

  const [poolAsOfDraft, setPoolAsOfDraft] = useState<string | null>(null);

  // When an active draft is selected, lock the pool to that draft
  const effectivePoolAsOfDraft = draftSelection.activeDraft ?? poolAsOfDraft;

  const syncStatus = useSyncStatus(draftSelection.activeDraft !== null, draftSelection.activeDraft);

  // Clear active draft selection if it completed (skip until sync data has loaded)
  const syncHasLoaded = syncStatus.lastSyncedAt !== "0";
  useEffect(() => {
    if (!syncHasLoaded) return;
    if (draftSelection.activeDraft && !syncStatus.activeDrafts.some(d => d.id === draftSelection.activeDraft)) {
      draftSelection.setActiveDraft(null);
    }
  }, [draftSelection.activeDraft, syncStatus.activeDrafts, syncHasLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeDraftNumSeats = useMemo(() => {
    if (!draftSelection.activeDraft) return 0;
    const info = syncStatus.activeDrafts.find(
      (d) => d.id === draftSelection.activeDraft
    );
    return info?.numSeats ?? 10;
  }, [draftSelection.activeDraft, syncStatus.activeDrafts]);

  const { cardData, draftStats, isLoading, handleDraftsChange } = useCardData({
    initialCardData,
    initialDraftStats,
    selectedDrafts: draftSelection.selectedDrafts,
    activeDraft: draftSelection.activeDraft,
    poolAsOfDraft: effectivePoolAsOfDraft,
    syncDataChanged: syncStatus.dataChanged,
  });

  // Track page load performance
  const pageLoadTracked = useRef(false);
  useEffect(() => {
    if (!pageLoadTracked.current && cardData.cards.length > 0) {
      pageLoadTracked.current = true;
      const duration = performance.now();
      track("page_load", {
        duration_ms: Math.round(duration),
        card_count: cardData.cards.length,
      });
    }
  }, [cardData.cards.length]);

  const search = useCardSearch({ cards: cardData.cards });

  // Clear color filter when viewport drops below xl (color filter icons hidden)
  const clearColorFilter = search.setColorFilter;
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1280px)");
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) clearColorFilter([]);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [clearColorFilter]);

  const { displayCards, searchFilteredCards, availableCount, takenCardNamesSet, seatCardNames, seatCardList } =
    useCardFiltering({
      cardData,
      activeDraft: draftSelection.activeDraft,
      hideTaken: draftSelection.hideTaken,
      selectedSeat: draftSelection.selectedSeat,
      searchQuery: search.searchQuery,
      scryfallMatchNames: search.scryfallMatchNames,
    });

  const [deckBuilderActive, setDeckBuilderActive] = useState(false);
  const [deckBuilderModalOpen, setDeckBuilderModalOpen] = useState(false);

  // Restore modal open state from localStorage on mount
  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external storage (localStorage) */
  useEffect(() => {
    const stored = localStorage.getItem("deckBuilderOpen");
    if (stored === "true" && draftSelection.activeDraft && draftSelection.selectedSeat !== null) {
      setDeckBuilderActive(true);
      setDeckBuilderModalOpen(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist modal open state to localStorage
  useEffect(() => {
    localStorage.setItem("deckBuilderOpen", String(deckBuilderModalOpen));
  }, [deckBuilderModalOpen]);

  // Close modal and deactivate deck builder when draft/seat deselected
  /* eslint-disable react-hooks/set-state-in-effect -- resetting derived state when upstream selection changes */
  useEffect(() => {
    if (!draftSelection.activeDraft || draftSelection.selectedSeat === null) {
      setDeckBuilderActive(false);
      setDeckBuilderModalOpen(false);
    }
  }, [draftSelection.activeDraft, draftSelection.selectedSeat]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Close modal on Escape key + lock body scroll when open
  useEffect(() => {
    if (deckBuilderModalOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && deckBuilderModalOpen) {
        setDeckBuilderModalOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [deckBuilderModalOpen]);

  // Build Scryfall data map for the deck builder
  const scryfallDataMap = useMemo(() => {
    const map = new Map<string, ScryCard>();
    for (const card of cardData.cards) {
      if (card.scryfall) {
        map.set(card.cardName, card.scryfall);
      }
    }
    return map;
  }, [cardData.cards]);

  // Build card stats map for deck builder hover previews
  const cardStatsMap = useMemo(() => {
    const map = new Map<string, CardStats>();
    for (const card of cardData.cards) {
      map.set(card.cardName, card);
    }
    return map;
  }, [cardData.cards]);

  // Deck builder hook
  const deckBuilder = useDeckBuilder({
    draftId: draftSelection.activeDraft ?? "",
    seat: draftSelection.selectedSeat ?? 0,
  });

  const searchParams = useSearchParams();
  const sharedDeckId = searchParams.get("deck");

  // Load shared deck from query param
  useEffect(() => {
    if (!sharedDeckId) return;

    async function loadSharedDeck() {
      try {
        const res = await fetch(`/api/deck/${sharedDeckId}`);
        if (!res.ok) {
          console.error(`Failed to load shared deck ${sharedDeckId}: ${res.status}`);
          return;
        }
        const deckState = await res.json();

        // Set draft context to match the shared deck
        draftSelection.setActiveDraft(deckState.draftId);
        draftSelection.setSelectedSeat(deckState.seat);

        // Load the shared deck into the deck builder
        deckBuilder.dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: deckState });

        // Activate and open the deck builder modal
        setDeckBuilderActive(true);
        setDeckBuilderModalOpen(true);
      } catch (err) {
        console.error("Failed to load shared deck:", err);
      }
    }

    loadSharedDeck();
  }, [sharedDeckId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Collect card name counts in the deck builder for the table indicator
  const deckBuilderCardCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const zone of ["deck", "sideboard"] as const) {
      for (const cards of Object.values(deckBuilder.state.zones[zone])) {
        for (const name of cards) {
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
    }
    return counts;
  }, [deckBuilder.state.zones]);

  // Initialize deck builder from seat picks when first opened
  const deckBuilderInitialized = useRef(false);
  useEffect(() => {
    if (deckBuilderActive && seatCardList && seatCardList.length > 0 && !deckBuilderInitialized.current) {
      const isEmpty = Object.values(deckBuilder.state.zones.deck).flat().length === 0
        && Object.values(deckBuilder.state.zones.sideboard).flat().length === 0;
      if (isEmpty) {
        deckBuilder.dispatch({
          type: "INIT_FROM_PICKS",
          picks: seatCardList!,
          scryfallData: scryfallDataMap,
          draftId: draftSelection.activeDraft ?? "",
          seat: draftSelection.selectedSeat ?? 0,
        });
      }
      deckBuilderInitialized.current = true;
    }
    if (!deckBuilderActive) {
      deckBuilderInitialized.current = false;
    }
  }, [deckBuilderActive, seatCardList]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile picked cards with deck builder state on every data refresh
  useEffect(() => {
    if (!deckBuilderActive || !seatCardList || seatCardList.length === 0) return;
    deckBuilder.dispatch({
      type: "SYNC_PICKS",
      pickedCardNames: seatCardList,
      takenCardNames: takenCardNamesSet ? Array.from(takenCardNamesSet) : undefined,
      scryfallData: scryfallDataMap,
    });
  }, [seatCardList, deckBuilderActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handler for adding speculative picks from the card table
  const handleAddSpeculative = useCallback(
    (cardName: string) => {
      deckBuilder.dispatch({
        type: "ADD_SPECULATIVE",
        cardName,
        scryfallData: scryfallDataMap,
        maxCopies: cardData.cubeCopies[cardName] || 1,
      });
      track("deck_card_add", { zone: "deck", source: "table" });
    },
    [deckBuilder, scryfallDataMap, cardData.cubeCopies]
  );

  // Handler for removing speculative picks from the card table
  const handleRemoveSpeculative = useCallback(
    (cardName: string) => {
      deckBuilder.dispatch({
        type: "REMOVE_SPECULATIVE",
        cardName,
      });
    },
    [deckBuilder]
  );

  // Track speculative card names for the card table indicator
  const speculativeCardNames = useMemo(
    () => new Set(deckBuilder.state.speculativeCards),
    [deckBuilder.state.speculativeCards]
  );

  const handleActiveDraftChange = useCallback(
    (draftId: string | null) => {
      draftSelection.setActiveDraft(draftId);
      if (draftId) {
        track("active_draft_set", { draft: draftId });
      }
    },
    [draftSelection]
  );

  const handleSeatChange = useCallback(
    (seat: number | null) => {
      draftSelection.setSelectedSeat(seat);
      if (seat !== null && draftSelection.activeDraft) {
        track("seat_selected", { draft: draftSelection.activeDraft, seat });
      }
    },
    [draftSelection]
  );

  const handlePoolAsOfChange = useCallback(
    (draftId: string | null) => {
      setPoolAsOfDraft(draftId);
      if (draftId) {
        track("pool_as_of_changed", { draft: draftId });
      }
    },
    []
  );

  // Compose draft selection change with data fetching
  const onDraftsChange = async (newSelection: Set<string>) => {
    draftSelection.setSelectedDrafts(newSelection);
    await handleDraftsChange(newSelection);
  };

  // Build drafts array for selector
  const completedSet = useMemo(() => new Set(cardData.completedDraftIds), [cardData.completedDraftIds]);

  const drafts = useMemo(
    () =>
      cardData.draftIds.map((id) => ({
        id,
        name: cardData.draftMetadata[id]?.name || id,
        date: cardData.draftMetadata[id]?.date || "1970-01-01",
        isComplete: completedSet.has(id),
      })),
    [cardData.draftIds, cardData.draftMetadata, completedSet]
  );

  const displayedCubeCopies = cardData.cubeCopies;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        {/* Toolbar */}
        <div className="mb-3 flex flex-wrap items-center gap-3">
          {/* Left: Logo + Title */}
          <div className="flex shrink-0 items-center gap-3">
            <img
              src="/read-the-bones-art.jpg"
              alt="Read the Bones"
              title="The dead know lessons the living haven't learned."
              className="h-8 w-10 rounded object-cover shadow-sm"
            />
            <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              Read the Bones
            </h1>
          </div>

          {/* Right: Search + Filters + Actions */}
          <div className="flex flex-1 items-center justify-end gap-3">
            {/* Search Input */}
            <div className="min-w-0 flex-1">
              <label htmlFor="search" className="sr-only">
                Search cards
              </label>
              <div className="flex items-center gap-2">
                <div className="relative w-full max-w-md">
                  <input
                    id="search"
                    type="text"
                    placeholder="Search cards..."
                    value={search.searchQuery}
                    onChange={(e) => search.setSearchQuery(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-white py-1.5 pl-3 pr-8 text-sm text-zinc-900 placeholder-zinc-500 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-400"
                  />
                  {search.searchQuery && (
                    <button
                      type="button"
                      onClick={search.clearSearch}
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-zinc-500 dark:hover:text-zinc-300"
                      aria-label="Clear search"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                {/* Syntax help tooltip */}
                <div className="group relative hidden sm:block">
                  <button
                    type="button"
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 text-[10px] font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-300"
                    aria-label="Search syntax help"
                  >
                    ?
                  </button>
                  <div className="absolute left-1/2 top-full z-50 mt-2 hidden w-64 -translate-x-1/2 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg group-hover:block dark:border-zinc-700 dark:bg-zinc-800">
                    <div className="mb-2 font-medium text-zinc-900 dark:text-zinc-100">
                      Search Syntax
                    </div>
                    <ul className="space-y-1 text-zinc-600 dark:text-zinc-300">
                      <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">t:creature</code> type</li>
                      <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">o:flying</code> oracle text</li>
                      <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">o:&quot;draw a card&quot;</code> phrase</li>
                      <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">c:r</code> color (w/u/b/r/g)</li>
                      <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">c:ub</code> multicolor</li>
                      <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">mv=3</code> mana value</li>
                      <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">mv&lt;=2</code> comparison</li>
                    </ul>
                    <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                      Combine terms: <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">t:instant c:u</code>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Color Filter — hidden below xl, search syntax (c:r) covers the same ground */}
            <div className="hidden xl:block">
              <ColorFilter
                selected={search.colorFilter}
                onChange={search.setColorFilter}
                mode={search.colorFilterMode}
                onModeChange={search.setColorFilterMode}
              />
            </div>

            {/* Deck Builder Toggle */}
            {draftSelection.activeDraft && draftSelection.selectedSeat !== null && (
              <button
                onClick={() => {
                  const wasOpen = deckBuilderModalOpen;
                  if (!deckBuilderActive) setDeckBuilderActive(true);
                  setDeckBuilderModalOpen((prev) => !prev);
                  if (!wasOpen && draftSelection.activeDraft && draftSelection.selectedSeat !== null) {
                    track("deck_builder_open", {
                      draft: draftSelection.activeDraft,
                      seat: draftSelection.selectedSeat,
                    });
                  }
                }}
                aria-label="Deck Builder"
                className={`cursor-pointer rounded-lg p-2 transition-colors ${
                  deckBuilderModalOpen
                    ? "bg-blue-600 text-white shadow-sm shadow-blue-900/40 hover:bg-blue-500"
                    : deckBuilderActive
                      ? "text-blue-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-6 w-6">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m-15 0A2.247 2.247 0 0 0 3 12v6.75A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V12c0-.796-.413-1.496-1.035-1.896" />
                </svg>
              </button>
            )}

            {/* Active Draft Indicator — hidden below md to preserve search bar width */}
            {draftSelection.activeDraft && (
              <div className="hidden md:block">
                <ActiveDraftIndicator
                  draftName={draftSelection.activeDraft}
                  availableCount={availableCount}
                  bannedCardNames={cardData.bannedCardNames}
                  lastSyncedAt={syncStatus.lastSyncedAt}
                  syncInProgress={syncStatus.syncInProgress || syncStatus.manualSyncInFlight}
                  draftComplete={!syncStatus.activeDrafts.some(d => d.id === draftSelection.activeDraft)}
                  onSyncNow={syncStatus.triggerSync}
                  syncDisabled={syncStatus.manualSyncInFlight}
                />
              </div>
            )}

            {/* Divider */}
            <div className="hidden h-5 w-px bg-zinc-300 dark:bg-zinc-600 lg:block" />

            {/* Action Buttons */}
            <div className="flex items-center gap-1">
              <StatsModal data={draftStats} />
              <a
                href="https://github.com/strunkandwhite/read-the-bones"
                target="_blank"
                rel="noopener noreferrer"
                className="cursor-pointer rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label="GitHub repository"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-5 w-5">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
              </a>
              <Settings
                drafts={drafts}
                selectedDrafts={draftSelection.selectedDrafts}
                onDraftsChange={onDraftsChange}
                isLoading={isLoading}
                activeDrafts={syncStatus.activeDrafts}
                activeDraft={draftSelection.activeDraft}
                onActiveDraftChange={handleActiveDraftChange}
                hideTaken={draftSelection.hideTaken}
                onHideTakenChange={draftSelection.setHideTaken}
                poolAsOfDraft={effectivePoolAsOfDraft}
                onPoolAsOfDraftChange={handlePoolAsOfChange}
                poolLockedByActiveDraft={draftSelection.activeDraft !== null}
                selectedSeat={draftSelection.selectedSeat}
                onSelectedSeatChange={handleSeatChange}
                activeDraftNumSeats={activeDraftNumSeats}
              />
            </div>
          </div>
        </div>

        {/* Card Table */}
        {searchFilteredCards.length > 0 ? (
          <CardTable
            cards={searchFilteredCards}
            colorFilter={search.colorFilter}
            colorFilterMode={search.colorFilterMode}
            currentCubeCopies={displayedCubeCopies}
            takenCardNames={takenCardNamesSet}
            seatCardNames={seatCardNames}
            onAddSpeculative={deckBuilderActive ? handleAddSpeculative : undefined}
            onRemoveSpeculative={deckBuilderActive ? handleRemoveSpeculative : undefined}
            deckBuilderCardCounts={deckBuilderActive ? deckBuilderCardCounts : undefined}
            speculativeCardNames={deckBuilderActive ? speculativeCardNames : undefined}
          />
        ) : (
          <div className="rounded-lg border border-zinc-200 bg-white p-12 text-center dark:border-zinc-700 dark:bg-zinc-900">
            <p className="text-zinc-500 dark:text-zinc-400">
              {draftSelection.selectedDrafts.size === 0
                ? "No drafts selected. Open Settings to select drafts."
                : search.scryfallMatchNames
                  ? "No cards in your pool match that search."
                  : displayCards.length === 0
                    ? "No card data available."
                    : "No cards match your filters."}
            </p>
          </div>
        )}

        {/* Loading overlay */}
        {isLoading && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20">
            <div className="rounded-lg bg-white px-6 py-4 shadow-lg dark:bg-zinc-800">
              <p className="text-zinc-700 dark:text-zinc-300">
                Loading draft data...
              </p>
            </div>
          </div>
        )}

      </div>

      {/* Deck Builder Modal */}
      {deckBuilderModalOpen && draftSelection.activeDraft && draftSelection.selectedSeat !== null && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-[2px] sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeckBuilderModalOpen(false);
          }}
        >
          <div className="flex max-h-[95vh] w-full max-w-7xl flex-col rounded-t-xl shadow-[0_0_60px_-12px_rgba(0,0,0,0.8)] sm:mx-3 sm:rounded-xl">
            <DeckBuilderPanel
              state={deckBuilder.state}
              dispatch={deckBuilder.dispatch}
              scryfallData={scryfallDataMap}
              cardStats={cardStatsMap}
              draftName={cardData.draftMetadata[draftSelection.activeDraft]?.name ?? draftSelection.activeDraft}
              onClose={() => setDeckBuilderModalOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
