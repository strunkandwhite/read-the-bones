import type { QueueGroupEntry } from "./liveStore";

/**
 * Canonical "my deck cards" union: picks + speculative (floats + queued),
 * auth-gated, deduplicated.
 *
 * This is a PURE function of explicit inputs — no store imports — so it can be
 * called from both selectors.ts (which imports liveStore) and liveStore.ts
 * (which must NOT import selectors) without creating a circular dependency.
 *
 * Rules (shared across PageClient mobile filter, syncDeckWithPicks, DeckBuilderPanel):
 * - Picks are authoritative.
 * - Floats are included when authed OR in local deck mode (sheet drafts); queued cards require auth.
 * - Speculative cards deduplicate against each other and against picks:
 *   queue first, then floats; a card that is both queued and floated counts once.
 * Returns an ordered array suitable for deckReducer's REBUILD canonicalCards.
 */
export function computeMyDeckCardNames({
  picks,
  isAuthed,
  localDeckMode,
  floatedCards,
  queue,
}: {
  picks: string[];
  isAuthed: boolean;
  /** Sheet-draft local mode: floats (local adds) are visible, queue is not. */
  localDeckMode: boolean;
  floatedCards: string[];
  queue: QueueGroupEntry[];
}): string[] {
  const authFloated = isAuthed || localDeckMode ? floatedCards : [];
  const authQueued = isAuthed
    ? queue.flatMap((entry) => entry.cards.map((c) => c.cardName))
    : [];

  const seen = new Set(picks);
  const speculative: string[] = [];
  for (const name of [...authQueued, ...authFloated]) {
    if (!seen.has(name)) {
      seen.add(name);
      speculative.push(name);
    }
  }
  return [...picks, ...speculative];
}
