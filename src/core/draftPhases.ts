/**
 * Draft-phase lifecycle constants and predicates.
 *
 * A draft moves through these phases:
 *   setup → drafting → playing → complete
 *
 * For stats purposes, drafts in 'playing' (drafting finished, matches ongoing)
 * count the same as 'complete' — both have all picks locked in.
 * Using 'complete' alone in stats queries omits live-match drafts and causes
 * Pick Score and pick history to disagree with the main card table.
 *
 * LEGAL PHASE TRANSITIONS (sync-driven):
 *   drafting → complete   (all picks done, detected by ✪ marker)
 *   drafting → drafting   (no-op, picks still in progress)
 *
 * Phases that syncDraft must NEVER overwrite:
 *   playing  (set by admin; indicates matches are in progress)
 *   complete (terminal)
 */

/** Phases that count as "completed for stats" — picks are fully locked in. */
export const STATS_COMPLETE_PHASES = ["complete", "playing"] as const;

/**
 * Returns true when a draft's picks should be counted in statistics.
 * Both 'complete' (post-match) and 'playing' (drafting done, matches ongoing)
 * qualify — all picks are finalised in both cases.
 */
export function isCompletedForStats(phase: string): boolean {
  return phase === "complete" || phase === "playing";
}

/**
 * Returns a SQL fragment and bound parameters for filtering drafts to
 * those that count toward stats, suitable for use in a WHERE clause.
 *
 * Usage:
 *   const { fragment, args } = statsPhaseFilter("d.phase");
 *   sql = `... WHERE ${fragment} AND ...`;
 *   queryArgs = [...args, ...otherArgs];
 *
 * Produces: `d.phase IN (?, ?)` with args `['complete', 'playing']`.
 */
export function statsPhaseFilter(column: string): { fragment: string; args: string[] } {
  const placeholders = STATS_COMPLETE_PHASES.map(() => "?").join(", ");
  return {
    fragment: `${column} IN (${placeholders})`,
    args: [...STATS_COMPLETE_PHASES],
  };
}

/**
 * Returns true when syncDraft is allowed to write the given target phase.
 *
 * The sync process only knows two outcomes: picks are complete ('complete')
 * or still in progress ('drafting'). It must never demote a draft that an
 * admin has manually advanced to 'playing' or 'complete' back to 'drafting'.
 *
 * Legal writes:
 *   any → complete       (picks finished — always safe to mark complete)
 *   setup → drafting     (first sync of a newly created Sheets draft)
 *   drafting → drafting  (no-op, harmless)
 *
 * Illegal (would clobber admin intent):
 *   playing → drafting
 *   complete → drafting
 */
export function isSyncPhaseTransitionLegal(
  currentPhase: string,
  targetPhase: string,
): boolean {
  // Always legal to mark complete (picks are done)
  if (targetPhase === "complete") return true;
  // Forward progress into (or within) drafting is fine
  if (targetPhase === "drafting") {
    return currentPhase === "setup" || currentPhase === "drafting";
  }
  // Anything else would demote playing/complete back to drafting — illegal
  return false;
}
