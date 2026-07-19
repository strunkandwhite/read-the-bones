/**
 * Cross-store wiring — import this module ONCE from the app entry point (PageClient).
 *
 * This module documents and triggers all import-time cross-store subscriptions so
 * initialization order is explicit and searchable. The subscriptions themselves live
 * at the bottom of their respective store modules (liveStore.ts, cardStore.ts) because
 * they reference module-scoped state (e.g. syncDeckTimer, deckDirty) that cannot be
 * cleanly separated without restructuring the stores themselves.
 *
 * Initialization order (left → right = earlier → later):
 *   draftStore  →  cardStore  →  liveStore  →  (this module)
 *
 *   - cardStore.ts subscriptions: cardStore subscribes to draftStore changes
 *     (selectedDrafts, pickVersion, dataVersion, poolAsOfDraft, activeDraft,
 *     hideTaken/selectedSeat). No liveStore dependency.
 *
 *   - liveStore.ts subscriptions:
 *       1. activeDraft       → reset/init all per-draft live state (token, queue, float, deck)
 *       2. nextSeat          → recomputePicking() (auto-pick trigger)
 *       3. seatCardList      → debouncedSyncDeckWithPicks()
 *       4. deckBuilderActive → debouncedSyncDeckWithPicks() on activation
 *       5. floatedCards      → debouncedSyncDeckWithPicks()
 *       6. queue             → debouncedSyncDeckWithPicks()
 *       7. mySeat            → debouncedSyncDeckWithPicks() (identity fix)
 *       8. activeDraft/board.isSheetDraft/selectedSeat → syncLocalDeck() (local deck mode load)
 *
 *   - liveStore.ts registrations:
 *       registerSeatTokenProvider — lets draftStore attach X-Seat-Token to /live polls
 *       registerApplyMeData       — lets draftStore apply per-seat /live responses
 *
 * All subscriptions fire at the moment their respective store module is first imported.
 * Importing liveStore.ts (directly or via this file) is sufficient to wire everything.
 */

// Importing liveStore triggers its module-scope subscriptions and provider registrations.
// cardStore is imported by liveStore, so it is also initialized at this point.
// draftStore is imported by both; it has no import-time subscriptions of its own.
import "./liveStore";
