"use client";

import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { useSharedDeckLoader } from "../hooks/useSharedDeckLoader";
import { useDeckBuilderSync } from "../hooks/useDeckBuilderSync";
import { useModalManagement } from "../hooks/useModalManagement";
import { track } from "@vercel/analytics/react";
import { CardTable } from "./CardTable";
import { CardStatsModal } from "./CardStatsModal";
import { ColorFilter } from "./ColorFilter";
import { Settings } from "./Settings";
import { StatsModal } from "./StatsModal";
import { isLocalClient } from "@/core/isLocal";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import { DeckBuilderPanel } from "./deck-builder/DeckBuilderPanel";
import { useScrollLock } from "@/app/hooks/useScrollLock";
import { DraftBoardModal } from "./draft-board/DraftBoardModal";

import { useHydration } from "../stores/hydration";
import { useDraftStore } from "../stores/draftStore";
import { useCardStore } from "../stores/cardStore";
import { useLiveStore } from "../stores/liveStore";
import { getCardStatus, getImageUrl } from "../stores/selectors";


export interface PageClientProps {
  initialCardData: CardStatsResponse;
  initialDraftStats: DraftStatsResponse;
  initialDraftId?: string;
}

/**
 * Client-side page component with state management.
 *
 * Handles:
 * - Search query filtering
 * - Color filter selection
 * - Draft selection (fetches recalculated stats from API)
 */
export function PageClient({ initialCardData, initialDraftStats, initialDraftId }: PageClientProps) {
  // Hydrate stores from SSR props
  useHydration({
    cardData: initialCardData,
    draftStats: initialDraftStats,
    completedDraftIds: initialCardData.completedDraftIds,
    initialDraftId,
  });

  // Draft store reads
  const activeDraft = useDraftStore((s) => s.activeDraft);
  const selectedDrafts = useDraftStore((s) => s.selectedDrafts);
  const selectedSeat = useDraftStore((s) => s.selectedSeat);
  const hideTaken = useDraftStore((s) => s.hideTaken);
  const liveDraftStatus = useDraftStore((s) => s.liveDraftStatus);
  const board = useDraftStore((s) => s.board);
  const syncStatus = useDraftStore((s) => s.syncStatus);
  const poolAsOfDraft = useDraftStore((s) => s.poolAsOfDraft);

  // Draft store actions
  const setActiveDraft = useDraftStore((s) => s.setActiveDraft);
  const setSelectedDrafts = useDraftStore((s) => s.setSelectedDrafts);
  const setSelectedSeat = useDraftStore((s) => s.setSelectedSeat);
  const setHideTaken = useDraftStore((s) => s.setHideTaken);
  const setPoolAsOfDraft = useDraftStore((s) => s.setPoolAsOfDraft);
  const patchSeatName = useDraftStore((s) => s.patchSeatName);

  // Card store reads
  const cardData = useCardStore((s) => s.cardData);
  const draftStats = useCardStore((s) => s.draftStats);
  const isLoading = useCardStore((s) => s.isLoading);
  const searchQuery = useCardStore((s) => s.searchQuery);
  const colorFilter = useCardStore((s) => s.colorFilter);
  const colorFilterMode = useCardStore((s) => s.colorFilterMode);
  const scryfallMatchNames = useCardStore((s) => s.scryfallMatchNames);
  const displayCards = useCardStore((s) => s.displayCards);
  const searchFilteredCards = useCardStore((s) => s.searchFilteredCards);
  const takenCardNamesSet = useCardStore((s) => s.takenCardNamesSet);
  const takenCardCounts = useCardStore((s) => s.takenCardCounts);
  const seatCardNames = useCardStore((s) => s.seatCardNames);
  const seatCardList = useCardStore((s) => s.seatCardList);
  const availableCount = useCardStore((s) => s.availableCount);
  const drafts = useCardStore((s) => s.drafts);
  const scryfallDataMap = useCardStore((s) => s.scryfallDataMap);
  const cardStatsMap = useCardStore((s) => s.cardStatsMap);
  const selectedCard = useCardStore((s) => s.selectedCard);

  // Card store actions
  const setSearchQuery = useCardStore((s) => s.setSearchQuery);
  const setColorFilter = useCardStore((s) => s.setColorFilter);
  const setColorFilterMode = useCardStore((s) => s.setColorFilterMode);
  const clearSearch = useCardStore((s) => s.clearSearch);
  const selectCard = useCardStore((s) => s.selectCard);
  const clearSelectedCard = useCardStore((s) => s.clearSelectedCard);
  const fetchCardData = useCardStore((s) => s.fetchCardData);

  // Live store reads
  const mySeat = useLiveStore((s) => s.mySeat);
  const autoPick = useLiveStore((s) => s.autoPick);
  const autoPickMode = useLiveStore((s) => s.autoPickMode);
  const pickError = useLiveStore((s) => s.pickError);
  const isMyTurn = useLiveStore((s) => s.isMyTurn);
  const queue = useLiveStore((s) => s.queue);
  const queuedCards = useLiveStore((s) => s.queuedCards);
  const floatedCards = useLiveStore((s) => s.floatedCards);
  const deckState = useLiveStore((s) => s.deckState);
  const deckSaveStatus = useLiveStore((s) => s.deckSaveStatus);
  const seatToken = useLiveStore((s) => s.seatToken);

  // Live store actions
  const submitPick = useLiveStore((s) => s.handlePick);
  const setPickError = useLiveStore((s) => s.setPickError);
  const toggleAutoPick = useLiveStore((s) => s.toggleAutoPick);
  const updateAutoPickMode = useLiveStore((s) => s.updateAutoPickMode);
  const addToQueue = useLiveStore((s) => s.addToQueue);
  const removeFromQueue = useLiveStore((s) => s.removeFromQueue);
  const reorderQueue = useLiveStore((s) => s.reorderQueue);
  const addFloat = useLiveStore((s) => s.addFloat);
  const removeFloat = useLiveStore((s) => s.removeFloat);
  const dispatchDeck = useLiveStore((s) => s.dispatchDeck);
  const setDeckBuilderActive = useLiveStore((s) => s.setDeckBuilderActive);

  const isAuthed = mySeat !== null && mySeat === selectedSeat;

  const {
    deckBuilderActive,
    setDeckBuilderActive: setDeckBuilderActiveModal,
    deckBuilderModalOpen,
    setDeckBuilderModalOpen,
    draftBoardOpen,
    setDraftBoardOpen,
  } = useModalManagement({
    activeDraft,
    selectedSeat,
  });

  useScrollLock(deckBuilderModalOpen);

  const searchHelpTrackedRef = useRef(false);

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

  // Clear color filter when viewport drops below lg (color filter icons hidden)
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) setColorFilter([]);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [setColorFilter]);

  // Mobile deck filter: shows only picked/queued/floated cards in card table
  const [deckFilterActive, setDeckFilterActive] = useState(false);

  const isLocal = useMemo(() => isLocalClient(), []);

  // When mySeat resolves from token auth, auto-select that seat
  useEffect(() => {
    if (mySeat !== null && selectedSeat === null) {
      setSelectedSeat(mySeat);
    }
  }, [mySeat, selectedSeat]); // eslint-disable-line react-hooks/exhaustive-deps

  useSharedDeckLoader({
    setActiveDraft,
    setSelectedSeat,
    dispatch: dispatchDeck,
    setDeckBuilderActive: (active: boolean) => {
      setDeckBuilderActive(active);
      setDeckBuilderActiveModal(active);
    },
    setDeckBuilderModalOpen,
  });

  const queuedCardNames = useMemo(
    () => Array.from(queuedCards.keys()),
    [queuedCards],
  );

  // Card status helper using store selector
  const getCardStatusCb = useCallback(
    (cardName: string) => getCardStatus(cardName),
    // Re-derive when the inputs to getCardStatus change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seatCardNames, queuedCards, floatedCards, takenCardNamesSet, isAuthed],
  );

  // Get Scryfall image URL using store selector
  const getImageUrlCb = useCallback(
    (cardName: string | null) => getImageUrl(cardName),
    [scryfallDataMap], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const selectedCardStatus = useMemo(
    () => selectedCard ? getCardStatusCb(selectedCard) : null,
    [selectedCard, getCardStatusCb],
  );

  // Wrap submitPick to also close the card stats modal after a successful pick
  const handlePick = useCallback(
    async (cardName: string) => {
      await submitPick(cardName);
      clearSelectedCard();
    },
    [submitPick, clearSelectedCard],
  );

  // Handle card click — opens card stats modal
  const handleCardClick = useCallback((cardName: string) => {
    const excludeId = liveDraftStatus?.phase === "drafting" ? activeDraft ?? undefined : undefined;
    selectCard(cardName, excludeId);
  }, [liveDraftStatus?.phase, activeDraft, selectCard]);

  // When deck filter is active (mobile), show only picked/queued/floated cards
  // Automatically deactivates when not authed (e.g., switching seats)
  const deckFilteredCards = useMemo(() => {
    if (!deckFilterActive || !isAuthed) return searchFilteredCards;
    const myCards = new Set([
      ...(seatCardList ?? []),
      ...floatedCards,
      ...queuedCardNames,
    ]);
    return searchFilteredCards.filter((c) => myCards.has(c.cardName));
  }, [deckFilterActive, isAuthed, searchFilteredCards, seatCardList, floatedCards, queuedCardNames]);

  useDeckBuilderSync({
    deckBuilderActive,
    seatCardList,
    deckBuilderState: deckState,
    dispatch: dispatchDeck,
    scryfallDataMap,
    activeDraft,
    selectedSeat,
    ready: useLiveStore.getState().deckReady,
    floatedCards: isAuthed ? floatedCards : [],
    queuedCardNames: isAuthed ? queuedCardNames : [],
  });

  const handleActiveDraftChange = useCallback(
    (draftId: string | null) => {
      setActiveDraft(draftId);
      setDeckFilterActive(false);
      if (draftId) {
        track("active_draft_set", { draft: draftId });
      }
    },
    [setActiveDraft]
  );

  const handleSeatChange = useCallback(
    (seat: number | null) => {
      setSelectedSeat(seat);
      setDeckFilterActive(false);
      if (seat !== null && activeDraft) {
        track("seat_selected", { draft: activeDraft, seat });
      }
    },
    [setSelectedSeat, activeDraft]
  );

  const handlePoolAsOfChange = useCallback(
    (draftId: string | null) => {
      setPoolAsOfDraft(draftId);
      if (draftId) {
        track("pool_as_of_changed", { draft: draftId });
      }
    },
    [setPoolAsOfDraft]
  );

  const handleUpdateDisplayName = useCallback(async (name: string) => {
    if (mySeat !== null) patchSeatName(mySeat, name || `Seat ${mySeat}`);
    await useLiveStore.getState().updateDisplayName(name);
    await useDraftStore.getState().refreshNow();
  }, [mySeat, patchSeatName]);

  // Compose draft selection change with data fetching
  const onDraftsChange = useCallback(async (newSelection: Set<string>) => {
    setSelectedDrafts(newSelection);
    await fetchCardData();
  }, [setSelectedDrafts, fetchCardData]);

  const activeDraftNumSeats = useMemo(() => {
    if (!activeDraft) return 0;
    const draft = drafts.find((d) => d.id === activeDraft);
    return draft?.numDrafters ?? 10;
  }, [activeDraft, drafts]);

  // effectivePoolAsOfDraft: when an active draft is selected, lock the pool to that draft
  const effectivePoolAsOfDraft = activeDraft ?? poolAsOfDraft;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl px-4 pb-0 pt-4 sm:px-6 lg:px-8">
        {/* Toolbar — single row: Logo | Search | Color Filters | Actions */}
        <div className="mb-3 flex items-center gap-3">
          {/* Logo + Title */}
          <div className="flex shrink-0 items-center gap-3">
            <img
              src="/read-the-bones-art.jpg"
              alt="Read the Bones"
              title="The dead know lessons the living haven't learned."
              className="h-8 w-10 rounded object-cover shadow-sm"
            />
            <h1 className="hidden text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100 sm:block">
              Read the Bones
            </h1>
          </div>

          {/* Search — fills available space */}
          <div className="relative min-w-0 flex-1">
            <label htmlFor="search" className="sr-only">
              Search cards
            </label>
            <input
              id="search"
              type="text"
              placeholder="Search cards..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white py-1.5 pl-3 pr-8 text-sm text-zinc-900 placeholder-zinc-500 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-400"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={clearSearch}
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
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-300 text-[10px] font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-300"
              aria-label="Search syntax help"
              onMouseEnter={() => {
                if (!searchHelpTrackedRef.current) {
                  searchHelpTrackedRef.current = true;
                  track("search_help_viewed");
                }
              }}
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
                <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">c:r</code> color (w/u/b/r/g/c/m)</li>
                <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">c=ub</code> exact colors</li>
                <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">id:ubr</code> color identity</li>
                <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">m:GG</code> mana cost</li>
                <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">mv=3</code> <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">mv&lt;=2</code> mana value</li>
                <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">-t:land</code> negation</li>
                <li><code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">or</code> <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-700">( )</code> logic</li>
              </ul>
              <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">t:instant c:u</code> = AND, <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">(t:instant or t:sorcery) c:u</code> = grouped OR
              </div>
            </div>
          </div>

          {/* Color Filter — hidden below lg */}
          <div className="hidden shrink-0 lg:block">
            <ColorFilter
              selected={colorFilter}
              onChange={setColorFilter}
              mode={colorFilterMode}
              onModeChange={setColorFilterMode}
            />
          </div>

          {/* Divider — visible when color filters are */}
          <div className="hidden h-5 w-px bg-zinc-300 dark:bg-zinc-600 lg:block" />

          {/* Action Buttons */}
          <div className="flex shrink-0 items-center gap-1">
            {activeDraft && selectedSeat !== null && (
              <button
                onClick={() => setDraftBoardOpen(!draftBoardOpen)}
                className={`cursor-pointer rounded-md p-2 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                  mySeat !== null && isMyTurn
                    ? "text-emerald-400 animate-pulse"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
                title={isMyTurn ? "Your Pick!" : `${activeDraft}, Seat ${selectedSeat}`}
                aria-label={isMyTurn ? "Your Pick!" : `Pod View — ${activeDraft}, Seat ${selectedSeat}`}
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="1" y="1" width="6" height="6" rx="1" />
                  <rect x="9" y="1" width="6" height="6" rx="1" />
                  <rect x="1" y="9" width="6" height="6" rx="1" />
                  <rect x="9" y="9" width="6" height="6" rx="1" />
                </svg>
              </button>
            )}
            {isAuthed && activeDraft && selectedSeat !== null && (
              <button
                onClick={() => {
                  // On mobile (< 640px), toggle card table filter instead of modal
                  const isMobile = window.innerWidth < 640;
                  if (isMobile) {
                    setDeckFilterActive((prev) => !prev);
                    return;
                  }
                  const wasOpen = deckBuilderModalOpen;
                  if (!deckBuilderActive) {
                    setDeckBuilderActive(true);
                    setDeckBuilderActiveModal(true);
                  }
                  setDeckBuilderModalOpen(!wasOpen);
                  if (!wasOpen && activeDraft && selectedSeat !== null) {
                    track("deck_builder_open", {
                      draft: activeDraft,
                      seat: selectedSeat,
                    });
                  }
                }}
                title="Deck Builder"
                aria-label="Deck Builder"
                className={`cursor-pointer rounded-lg p-2 transition-colors ${
                  deckBuilderModalOpen || deckFilterActive
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
            <StatsModal data={draftStats} />
            <Settings
              drafts={drafts}
              selectedDrafts={selectedDrafts}
              onDraftsChange={onDraftsChange}
              isLoading={isLoading}
              activeDrafts={syncStatus.activeDrafts}
              activeDraft={activeDraft}
              onActiveDraftChange={handleActiveDraftChange}
              hideTaken={hideTaken}
              onHideTakenChange={setHideTaken}
              poolAsOfDraft={effectivePoolAsOfDraft}
              onPoolAsOfDraftChange={handlePoolAsOfChange}
              poolLockedByActiveDraft={activeDraft !== null}
              selectedSeat={selectedSeat}
              onSelectedSeatChange={handleSeatChange}
              activeDraftNumSeats={activeDraftNumSeats}
              isAuthed={isAuthed}
              mySeat={mySeat}
              seatNames={board?.seatNames}
            />
          </div>
        </div>

        {pickError && (
          <div className="mb-2 flex items-center justify-between rounded-md border border-red-800/50 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            <span>{pickError}</span>
            <button
              onClick={() => setPickError(null)}
              className="ml-2 text-red-400 hover:text-red-200"
            >
              &times;
            </button>
          </div>
        )}

        {/* Card Table */}
        {deckFilteredCards.length > 0 ? (
          <CardTable
            cards={deckFilteredCards}
            colorFilter={colorFilter}
            colorFilterMode={colorFilterMode}
            currentCubeCopies={cardData.cubeCopies}
            takenCardNames={takenCardNamesSet}
            takenCardCounts={takenCardCounts}
            seatCardNames={seatCardNames}
            onCardClick={handleCardClick}
            getCardStatus={getCardStatusCb}
          />
        ) : (
          <div className="rounded-lg border border-zinc-200 bg-white p-12 text-center dark:border-zinc-700 dark:bg-zinc-900">
            <p className="text-zinc-500 dark:text-zinc-400">
              {selectedDrafts.size === 0
                ? "No drafts selected. Open Settings to select drafts."
                : scryfallMatchNames
                  ? "No cards in your pool match that search."
                  : displayCards.length === 0
                    ? "No card data available."
                    : "No cards match your filters."}
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="flex h-10 items-center justify-center gap-1.5 text-xs text-zinc-500">
          <a
            href="https://github.com/strunkandwhite/read-the-bones"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-zinc-700 dark:hover:text-zinc-400"
            aria-label="GitHub repository"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
          <span>made by <a href="https://github.com/strunkandwhite" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-zinc-700 dark:hover:text-zinc-400">jack</a></span>
        </div>

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

      {/* Draft Board Modal */}
      {draftBoardOpen && activeDraft && (
        <DraftBoardModal
          board={board}
          status={liveDraftStatus}
          mySeat={mySeat}
          token={seatToken}
          draftId={activeDraft}
          draftName={cardData.draftMetadata[activeDraft]?.name}
          availableCount={availableCount}
          bannedCardNames={cardData.bannedCardNames}
          isOpen={draftBoardOpen}
          onClose={() => setDraftBoardOpen(false)}
          onMatchReported={() => useDraftStore.getState().refreshNow()}
          onUpdateDisplayName={handleUpdateDisplayName}
          pickQueue={queue.map((e) => ({ cardName: e.cardName, position: e.priority }))}
          autoPick={autoPick}
          autoPickMode={autoPickMode}
          onQueueReorder={reorderQueue}
          onQueueRemove={removeFromQueue}
          onToggleAutoPick={toggleAutoPick}
          onChangeAutoPickMode={updateAutoPickMode}
          handlePick={isAuthed ? submitPick : undefined}
          isMyTurn={isAuthed && isMyTurn}
          pickError={pickError}
        />
      )}

      {/* Deck Builder Modal */}
      {deckBuilderModalOpen && activeDraft && selectedSeat !== null && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-[2px] sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeckBuilderModalOpen(false);
          }}
        >
          <div className="flex max-h-[95vh] w-full max-w-7xl flex-col rounded-t-xl shadow-[0_0_60px_-12px_rgba(0,0,0,0.8)] sm:mx-3 sm:rounded-xl">
            <DeckBuilderPanel
              state={deckState}
              dispatch={dispatchDeck}
              scryfallData={scryfallDataMap}
              cardStats={cardStatsMap}
              draftName={cardData.draftMetadata[activeDraft]?.name ?? activeDraft}
              onClose={() => setDeckBuilderModalOpen(false)}
              floatedCards={isAuthed ? floatedCards : []}
              onRemoveFloat={isAuthed ? removeFloat : undefined}
              saveStatus={deckSaveStatus}
            />
          </div>
        </div>
      )}

      {/* Card Stats Modal */}
      <CardStatsModal
        cardName={selectedCard}
        scryfallImageUrl={getImageUrlCb(selectedCard)}
        isOpen={!!selectedCard}
        onClose={clearSelectedCard}
        isLiveDraft={!!activeDraft && liveDraftStatus?.phase === "drafting"}
        isMyTurn={isAuthed && isMyTurn}
        cardStatus={selectedCardStatus?.status ?? "none"}
        queuePosition={selectedCardStatus?.queuePosition}
        onPick={isAuthed && selectedCard ? () => handlePick(selectedCard) : undefined}
        onQueue={isAuthed && selectedCard && !(isMyTurn && queue.length === 0 && autoPick) ? () => addToQueue(selectedCard) : undefined}
        onUnqueue={isAuthed && selectedCard ? () => removeFromQueue(selectedCard) : undefined}
        onFloat={isAuthed && selectedCard ? () => addFloat(selectedCard) : undefined}
        onUnfloat={isAuthed && selectedCard ? () => removeFloat(selectedCard) : undefined}
        isLocal={isLocal}
      />
    </div>
  );
}
