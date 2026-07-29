/**
 * Draft-phase lifecycle constants and predicates.
 *
 * A draft moves through these phases:
 *   setup → drafting → playing → complete
 *
 * For sheet drafts the sync process drives the lifecycle:
 *   drafting → playing   (every pick cell in the sheet is filled)
 *   playing  → complete  (full round robin recorded, or the 60-day age
 *                         backstop in completeAgedPlayingDrafts fires)
 *
 * 'playing' drafts keep syncing on the cron so late match entry and
 * post-hoc pick corrections in the sheet still reach the database.
 *
 * For stats purposes, drafts in 'playing' (drafting finished, matches ongoing)
 * count the same as 'complete' — both have all picks locked in.
 * Using 'complete' alone in stats queries omits live-match drafts and causes
 * Pick Score and pick history to disagree with the main card table.
 *
 * Sync must NEVER demote a phase (complete → playing, playing → drafting):
 * an admin may have advanced the phase manually, and demotion would clobber
 * that intent. pnpm draft:admin set-phase remains the manual override.
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

/** Number of matches in a full single round robin for a pod of numSeats. */
function expectedMatchCount(numSeats: number): number {
  return (numSeats * (numSeats - 1)) / 2;
}

/**
 * True when every round-robin match has been recorded. Extra matches
 * (double round robin) also count as complete. Never true for pods of
 * fewer than 2 seats — there is nothing meaningful to complete.
 */
export function isMatchesComplete(matchCount: number, numSeats: number): boolean {
  return numSeats >= 2 && matchCount >= expectedMatchCount(numSeats);
}

/**
 * The phase the sync process wants a sheet draft to be in, given what the
 * sheet currently shows. Matches entered before picks finish do not advance
 * the phase — picks completing is the gate into playing.
 */
export function computeSyncTargetPhase(
  picksComplete: boolean,
  matchesComplete: boolean,
): "drafting" | "playing" | "complete" {
  if (picksComplete && matchesComplete) return "complete";
  if (picksComplete) return "playing";
  return "drafting";
}

/**
 * Returns true when sync is allowed to write the given target phase.
 * Forward progress only — never demote a phase (see file header).
 */
export function isSyncPhaseTransitionLegal(
  currentPhase: string,
  targetPhase: string,
): boolean {
  if (targetPhase === "complete") return true;
  if (targetPhase === "playing") {
    return (
      currentPhase === "setup" ||
      currentPhase === "drafting" ||
      currentPhase === "playing"
    );
  }
  if (targetPhase === "drafting") {
    return currentPhase === "setup" || currentPhase === "drafting";
  }
  return false;
}
