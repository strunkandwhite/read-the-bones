"use client";

import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { useLiveDraftPicking } from "../hooks/useLiveDraftPicking";
import { useSharedDeckLoader } from "../hooks/useSharedDeckLoader";
import { useDeckBuilderSync } from "../hooks/useDeckBuilderSync";
import { useModalManagement } from "../hooks/useModalManagement";
import { track } from "@vercel/analytics/react";
import { CardTable } from "./CardTable";
import { CardStatsModal } from "./CardStatsModal";
import { ColorFilter } from "./ColorFilter";
import { Settings } from "./Settings";
import { StatsModal } from "./StatsModal";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useDraftSelection } from "../hooks/useDraftSelection";
import { useCardData } from "../hooks/useCardData";
import { useCardSearch } from "../hooks/useCardSearch";
import { useCardFiltering } from "../hooks/useCardFiltering";
import { useFloatedCards } from "../hooks/useFloatedCards";
import { isLocalClient } from "@/core/isLocal";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import type { ScryCard, CardStats } from "@/core/types";
import { DeckBuilderPanel } from "./deck-builder/DeckBuilderPanel";
import { useDeckBuilder } from "../hooks/useDeckBuilder";
import { useScrollLock } from "@/app/hooks/useScrollLock";
import { useLiveDraftStatus, useDraftBoard } from "../hooks/useLiveDraftStatus";
import { useSeatToken } from "../hooks/useSeatToken";
import { usePickQueue } from "../hooks/usePickQueue";
import { DraftBoardModal } from "./draft-board/DraftBoardModal";
import { useMySeat } from "../hooks/useMySeat";
import { getFrontFace } from "@/core/cardNames";


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
  const draftSelection = useDraftSelection({
    completedDraftIds: initialCardData.completedDraftIds,
    initialDraftId,
  });

  const [poolAsOfDraft, setPoolAsOfDraft] = useState<string | null>(null);

  // When an active draft is selected, lock the pool to that draft
  const effectivePoolAsOfDraft = draftSelection.activeDraft ?? poolAsOfDraft;

  const syncStatus = useSyncStatus(draftSelection.activeDraft !== null, draftSelection.activeDraft);

  // Live draft polling (must be before useCardData so dataChanged can flow to it)
  const liveDraftStatus = useLiveDraftStatus(
    draftSelection.activeDraft,
    draftSelection.activeDraft !== null,
  );

  const { cardData, draftStats, isLoading, handleDraftsChange } = useCardData({
    initialCardData,
    initialDraftStats,
    selectedDrafts: draftSelection.selectedDrafts,
    activeDraft: draftSelection.activeDraft,
    poolAsOfDraft: effectivePoolAsOfDraft,
    syncDataChanged: syncStatus.dataChanged,
    liveDraftDataChanged: liveDraftStatus.dataChanged,
  });

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

  const search = useCardSearch({ cards: cardData.cards });

  // Clear color filter when viewport drops below sm (color filter icons hidden)
  const clearColorFilter = search.setColorFilter;
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) clearColorFilter([]);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [clearColorFilter]);

  const { displayCards, searchFilteredCards, takenCardNamesSet, seatCardNames, seatCardList } =
    useCardFiltering({
      cardData,
      activeDraft: draftSelection.activeDraft,
      hideTaken: draftSelection.hideTaken,
      selectedSeat: draftSelection.selectedSeat,
      searchQuery: search.searchQuery,
      scryfallMatchNames: search.scryfallMatchNames,
    });

  const {
    deckBuilderActive,
    setDeckBuilderActive,
    deckBuilderModalOpen,
    setDeckBuilderModalOpen,
    draftBoardOpen,
    setDraftBoardOpen,
  } = useModalManagement({
    activeDraft: draftSelection.activeDraft,
    selectedSeat: draftSelection.selectedSeat,
  });

  useScrollLock(deckBuilderModalOpen);

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

  // Live draft hooks
  const seatToken = useSeatToken(draftSelection.activeDraft);

  // Deck builder hook
  const deckBuilder = useDeckBuilder({
    draftId: draftSelection.activeDraft ?? "",
    seat: draftSelection.selectedSeat ?? 0,
    token: seatToken.token,
  });

  const draftBoard = useDraftBoard(
    draftSelection.activeDraft,
    liveDraftStatus.dataChanged,
  );
  const pickQueue = usePickQueue(
    draftSelection.activeDraft,
    seatToken.token,
    liveDraftStatus.dataChanged,
  );

  const { mySeat, autoPick, autoPickMode, toggleAutoPick, updateDisplayName, updateAutoPickMode, refreshSettings } = useMySeat(draftSelection.activeDraft, seatToken.token);

  // Float state (server-side speculative cards)
  const { floatedCards, addFloat, removeFloat } = useFloatedCards(
    draftSelection.activeDraft,
    seatToken.token,
  );

  // Card stats modal
  const [selectedCard, setSelectedCard] = useState<string | null>(null);

  const isLocal = useMemo(() => isLocalClient(), []);

  const { handlePick: submitPick, pickError, setPickError, isMyTurn } = useLiveDraftPicking({
    activeDraft: draftSelection.activeDraft,
    token: seatToken.token,
    mySeat,
    liveDraftStatus: liveDraftStatus.status,
    refreshDraftStatus: liveDraftStatus.refresh,
    autoPick,
    queuedCards: pickQueue.queuedCards,
    refreshSettings,
  });

  // Card status helper: determines whether a card is picked, queued, floated, taken, or none
  const getCardStatus = useCallback(
    (cardName: string): { status: "picked" | "queued" | "floated" | "none" | "taken"; queuePosition?: number } => {
      // Picked by the current seat
      if (seatCardNames?.has(cardName)) {
        return { status: "picked" };
      }
      // In the pick queue
      const queuePriority = pickQueue.queuedCards.get(cardName);
      if (queuePriority != null) {
        return { status: "queued", queuePosition: queuePriority };
      }
      // Floated (server-side speculative)
      if (floatedCards.includes(cardName)) {
        return { status: "floated" };
      }
      // Taken by someone else
      if (takenCardNamesSet?.has(cardName)) {
        return { status: "taken" };
      }
      return { status: "none" };
    },
    [seatCardNames, pickQueue.queuedCards, floatedCards, takenCardNamesSet],
  );

  // Get Scryfall image URL for a card
  const getImageUrl = useCallback(
    (cardName: string | null): string | undefined => {
      if (!cardName) return undefined;
      const card = cardData.cards.find((c) => c.cardName === cardName);
      return card?.scryfall?.imageUri;
    },
    [cardData.cards],
  );

  // Wrap submitPick to also close the card stats modal after a successful pick
  const handlePick = useCallback(
    async (cardName: string) => {
      await submitPick(cardName);
      setSelectedCard(null);
    },
    [submitPick],
  );

  // When mySeat resolves from token auth, auto-select that seat
  useEffect(() => {
    if (mySeat !== null && draftSelection.selectedSeat === null) {
      draftSelection.setSelectedSeat(mySeat);
    }
  }, [mySeat, draftSelection.selectedSeat]); // eslint-disable-line react-hooks/exhaustive-deps

  useSharedDeckLoader({
    setActiveDraft: draftSelection.setActiveDraft,
    setSelectedSeat: draftSelection.setSelectedSeat,
    dispatch: deckBuilder.dispatch,
    setDeckBuilderActive,
    setDeckBuilderModalOpen,
  });

  useDeckBuilderSync({
    deckBuilderActive,
    seatCardList,
    deckBuilderState: deckBuilder.state,
    dispatch: deckBuilder.dispatch,
    scryfallDataMap,
    activeDraft: draftSelection.activeDraft,
    selectedSeat: draftSelection.selectedSeat,
    ready: deckBuilder.ready,
  });

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

  const handleUpdateDisplayName = useCallback(async (name: string) => {
    if (mySeat !== null) draftBoard.patchSeatName(mySeat, name || `Seat ${mySeat}`);
    await updateDisplayName(name);
    draftBoard.refresh();
  }, [updateDisplayName, draftBoard, mySeat]);

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
        numDrafters: cardData.draftMetadata[id]?.numDrafters || 10,
      })),
    [cardData.draftIds, cardData.draftMetadata, completedSet]
  );

  const activeDraftNumSeats = useMemo(() => {
    if (!draftSelection.activeDraft) return 0;
    const draft = drafts.find((d) => d.id === draftSelection.activeDraft);
    return draft?.numDrafters ?? 10;
  }, [draftSelection.activeDraft, drafts]);

  const availableCount = useMemo(() => {
    if (!draftSelection.activeDraft || !takenCardNamesSet) return 0;
    const bannedSet = new Set(cardData.bannedCardNames ?? []);
    return cardData.cards.filter((c) => {
      if (takenCardNamesSet.has(c.cardName)) return false;
      if (bannedSet.has(c.cardName)) return false;
      const frontFace = getFrontFace(c.cardName);
      return frontFace ? !bannedSet.has(frontFace) : true;
    }).length;
  }, [draftSelection.activeDraft, cardData.cards, cardData.bannedCardNames, takenCardNamesSet]);

  const displayedCubeCopies = cardData.cubeCopies;

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
              selected={search.colorFilter}
              onChange={search.setColorFilter}
              mode={search.colorFilterMode}
              onModeChange={search.setColorFilterMode}
            />
          </div>

          {/* Divider — visible when color filters are */}
          <div className="hidden h-5 w-px bg-zinc-300 dark:bg-zinc-600 lg:block" />

          {/* Action Buttons */}
          <div className="flex shrink-0 items-center gap-1">
            {draftSelection.activeDraft && draftSelection.selectedSeat !== null && (
              <button
                onClick={() => setDraftBoardOpen(!draftBoardOpen)}
                className={`cursor-pointer rounded-md p-2 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                  mySeat !== null && isMyTurn
                    ? "text-emerald-400 animate-pulse"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
                title={isMyTurn ? "Your Pick!" : `${draftSelection.activeDraft}, Seat ${draftSelection.selectedSeat}`}
                aria-label={isMyTurn ? "Your Pick!" : `Pod View — ${draftSelection.activeDraft}, Seat ${draftSelection.selectedSeat}`}
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="1" y="1" width="6" height="6" rx="1" />
                  <rect x="9" y="1" width="6" height="6" rx="1" />
                  <rect x="1" y="9" width="6" height="6" rx="1" />
                  <rect x="9" y="9" width="6" height="6" rx="1" />
                </svg>
              </button>
            )}
            {draftSelection.activeDraft && draftSelection.selectedSeat !== null && (
              <button
                onClick={() => {
                  const wasOpen = deckBuilderModalOpen;
                  if (!deckBuilderActive) setDeckBuilderActive(true);
                  setDeckBuilderModalOpen(!wasOpen);
                  if (!wasOpen && draftSelection.activeDraft && draftSelection.selectedSeat !== null) {
                    track("deck_builder_open", {
                      draft: draftSelection.activeDraft,
                      seat: draftSelection.selectedSeat,
                    });
                  }
                }}
                title="Deck Builder"
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
            <StatsModal data={draftStats} />
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
        {searchFilteredCards.length > 0 ? (
          <CardTable
            cards={searchFilteredCards}
            colorFilter={search.colorFilter}
            colorFilterMode={search.colorFilterMode}
            currentCubeCopies={displayedCubeCopies}
            takenCardNames={takenCardNamesSet}
            seatCardNames={seatCardNames}
            onCardClick={setSelectedCard}
            getCardStatus={getCardStatus}
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
      {draftBoardOpen && draftSelection.activeDraft && (
        <DraftBoardModal
          board={draftBoard.board}
          status={liveDraftStatus.status}
          mySeat={mySeat}
          token={seatToken.token}
          draftId={draftSelection.activeDraft}
          draftName={cardData.draftMetadata[draftSelection.activeDraft]?.name}
          availableCount={availableCount}
          bannedCardNames={cardData.bannedCardNames}
          isOpen={draftBoardOpen}
          onClose={() => setDraftBoardOpen(false)}
          onMatchReported={() => draftBoard.refresh()}
          onUpdateDisplayName={handleUpdateDisplayName}
          pickQueue={pickQueue.queue.map((e) => ({ cardName: e.cardName, position: e.priority }))}
          autoPick={autoPick}
          autoPickMode={autoPickMode}
          onQueueReorder={pickQueue.reorderQueue}
          onQueueRemove={pickQueue.removeFromQueue}
          onToggleAutoPick={toggleAutoPick}
          onChangeAutoPickMode={updateAutoPickMode}
          handlePick={submitPick}
          isMyTurn={isMyTurn}
          pickError={pickError}
        />
      )}

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
              floatedCards={floatedCards}
              onRemoveFloat={removeFloat}
              saveStatus={deckBuilder.saveStatus}
            />
          </div>
        </div>
      )}

      {/* Card Stats Modal */}
      <CardStatsModal
        cardName={selectedCard}
        scryfallImageUrl={getImageUrl(selectedCard)}
        isOpen={!!selectedCard}
        onClose={() => setSelectedCard(null)}
        draftId={draftSelection.activeDraft && liveDraftStatus.status?.phase !== "drafting" ? draftSelection.activeDraft : undefined}
        isLiveDraft={!!draftSelection.activeDraft && liveDraftStatus.status?.phase === "drafting"}
        isMyTurn={isMyTurn}
        cardStatus={selectedCard ? getCardStatus(selectedCard).status : "none"}
        queuePosition={selectedCard ? getCardStatus(selectedCard).queuePosition : undefined}
        onPick={selectedCard ? () => handlePick(selectedCard) : undefined}
        onQueue={selectedCard && !(isMyTurn && pickQueue.queue.length === 0 && autoPick) ? () => pickQueue.addToQueue(selectedCard) : undefined}
        onUnqueue={selectedCard ? () => pickQueue.removeFromQueue(selectedCard) : undefined}
        onFloat={selectedCard ? () => addFloat(selectedCard) : undefined}
        onUnfloat={selectedCard ? () => removeFloat(selectedCard) : undefined}
        isLocal={isLocal}
        excludeDraftId={liveDraftStatus.status?.phase === "drafting" ? draftSelection.activeDraft ?? undefined : undefined}
      />
    </div>
  );
}
