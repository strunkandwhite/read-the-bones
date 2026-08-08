/**
 * Drafts that ran on the same date are one session — parallel pods are a
 * single drafting occasion, and each drafter only played one of them.
 *
 * Recency is measured in sessions rather than days because what moves the
 * group's evaluation of a card is drafting it and seeing it play out, not the
 * calendar. A long gap between sessions therefore ages nothing.
 */

/**
 * Map each draft to how many sessions back it is, 0 being the most recent
 * session among the drafts given.
 */
export function sessionsAgoByDraft(
  drafts: Array<{ draftId: string; draftDate: string }>,
): Map<string, number> {
  // ISO dates sort lexicographically, so this is newest-first.
  const sessionDates = [...new Set(drafts.map((draft) => draft.draftDate))]
    .sort()
    .reverse();

  const ordinalByDate = new Map(sessionDates.map((date, index) => [date, index]));

  return new Map(
    drafts.map((draft) => [draft.draftId, ordinalByDate.get(draft.draftDate)!]),
  );
}
