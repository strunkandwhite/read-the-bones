/**
 * Row-based sheet parsing module.
 *
 * Operates on string[][] row arrays (the native format from Google Sheets API).
 * Parses pool, pick, and match rows from Google Sheets tab data.
 */

import type { CardPick, MatchResult } from "./types";
import { normalizeCardName } from "./cardNames";

// Re-export types so consumers can import from either location
export type { CardPick, MatchResult } from "./types";

// Re-export for backwards compatibility
export { normalizeCardName, cardNameKey } from "./cardNames";

/**
 * Parsed picks result with metadata about the draft.
 */
export interface ParsedPicks {
  picks: CardPick[];
  numDrafters: number;
  drafterNames: string[];
  isComplete: boolean;
  doublePickStartsAfterRound: number | null;
  picksPerPlayer: number;
}

/**
 * Check if a value is an arrow character used in the draft sheet.
 */
export function isArrow(value: string): boolean {
  return ["→", "↪", "↩", "✪"].includes(value.trim());
}

/**
 * Check if a draft is complete by examining the ✪ marker row.
 *
 * Finds the row with ✪ marker (indicates last row of draft).
 * If that row has picks filled in drafter columns, draft is complete.
 * If no ✪ row found, assume complete.
 */
export function isDraftComplete(rows: string[][]): boolean {
  for (const row of rows) {
    if (row.some((cell) => cell?.includes("✪"))) {
      // Found the marker row - check if drafter columns have picks
      // Drafter columns start at index 2 (after pick# and arrow)
      const firstDrafterPick = row[2]?.trim();
      return !!firstDrafterPick && !isArrow(firstDrafterPick);
    }
  }

  // No ✪ marker found - assume complete
  return true;
}

/**
 * Parse pool rows to get all card names.
 *
 * Row format:
 * - Column A (index 0): Checkmark (✓ if picked)
 * - Column B (index 1): Card name
 * - Row 0: Header (skipped)
 */
export function parsePoolRows(rows: string[][]): string[] {
  const allCards: string[] = [];

  // Skip header row (index 0)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const cardName = row[1]?.trim();
    if (!cardName) continue;

    const normalizedName = normalizeCardName(cardName);
    if (!normalizedName) continue;

    allCards.push(normalizedName);
  }

  return allCards;
}

/**
 * Parse pick rows from a draft sheet.
 *
 * Row format:
 * - Rows 0-1: Headers/metadata (ignored)
 * - Row 2: Drafter names starting from column C (index 2), ending at arrow marker
 * - Row 3+: Pick data with round number in column A, arrow in column B,
 *   card names in drafter columns, and colors in rightmost columns
 */
export function parsePickRows(
  rows: string[][],
  draftId: string
): ParsedPicks {
  if (rows.length < 4) {
    return {
      picks: [],
      numDrafters: 0,
      drafterNames: [],
      isComplete: true,
      doublePickStartsAfterRound: null,
      picksPerPlayer: 0,
    };
  }

  // Row 2 (index 2) contains drafter names starting from column C (index 2)
  const drafterRow = rows[2];

  // Find where drafter names end by looking for the arrow marker
  const drafterNames: string[] = [];
  let drafterEndIndex = 2;

  // First pass: collect names up to arrow or empty gap
  for (let i = 2; i < drafterRow.length; i++) {
    const cell = drafterRow[i]?.trim();
    if (cell && !isArrow(cell)) {
      drafterNames.push(cell);
      drafterEndIndex = i + 1;
    } else if (isArrow(cell)) {
      break;
    } else if (!cell && drafterNames.length > 0) {
      break;
    }
  }

  // Refine: find the ↩ marker in the drafter row to determine the end of drafter columns
  const arrowIndexInDrafterRow = drafterRow.findIndex(
    (cell, idx) => idx > 1 && isArrow(cell?.trim())
  );

  if (arrowIndexInDrafterRow > 2) {
    drafterNames.length = 0;
    for (let i = 2; i < arrowIndexInDrafterRow; i++) {
      const name = drafterRow[i]?.trim();
      if (name) {
        drafterNames.push(name);
      }
    }
    drafterEndIndex = arrowIndexInDrafterRow;
  }

  const numDrafters = drafterNames.length;
  if (numDrafters === 0) {
    return {
      picks: [],
      numDrafters: 0,
      drafterNames: [],
      isComplete: true,
      doublePickStartsAfterRound: null,
      picksPerPlayer: 0,
    };
  }

  // Extract "Double Picks After:" metadata
  let doublePickStartsAfterRound: number | null = null;
  for (const row of rows) {
    for (let i = 0; i < row.length - 1; i++) {
      if (row[i]?.trim() === "Double Picks After:") {
        const val = parseInt(row[i + 1]?.trim(), 10);
        if (!isNaN(val)) {
          doublePickStartsAfterRound = val;
        }
        break;
      }
    }
    if (doublePickStartsAfterRound !== null) break;
  }

  // Check draft completion via ✪ marker
  const isComplete = isDraftComplete(rows);

  // Track copy numbers for each card name across the entire draft
  const copyNumberTracker = new Map<string, number>();

  const picks: CardPick[] = [];

  // Pre-scan the highest round number so the main loop can recognize a
  // trailing single round: when the row count past the double-pick threshold
  // is odd, the last row is a final single round, not half of a pair.
  let maxRound = 0;
  for (let rowIndex = 3; rowIndex < rows.length; rowIndex++) {
    const n = parseInt(rows[rowIndex]?.[0]?.trim(), 10);
    if (!isNaN(n) && n > maxRound) maxRound = n;
  }

  // Process pick rows starting from row 4 (index 3)
  for (let rowIndex = 3; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row || row.length < 3) continue;

    // Column A is round number
    const roundNumberStr = row[0]?.trim();
    const roundNumber = parseInt(roundNumberStr, 10);
    if (isNaN(roundNumber)) continue;

    // Find where color data starts by looking for single-letter color codes at the end
    const colorPattern = /^[WUBRGC]+$/;
    let firstColorIndex = -1;

    // Search backwards from the end to find color columns
    for (let i = row.length - 1; i >= 0; i--) {
      const cell = row[i]?.trim();
      if (cell && colorPattern.test(cell)) {
        firstColorIndex = i;
      } else if (firstColorIndex !== -1 && cell && !colorPattern.test(cell)) {
        break;
      }
    }

    // Fallback: count numDrafters from the end
    if (firstColorIndex === -1) {
      const potentialColorStart = row.length - numDrafters;
      if (potentialColorStart > drafterEndIndex) {
        firstColorIndex = potentialColorStart;
      }
    }

    // Process each drafter's pick
    for (let drafterIndex = 0; drafterIndex < numDrafters; drafterIndex++) {
      const cardColIndex = 2 + drafterIndex;
      const rawCardName = row[cardColIndex]?.trim();

      if (!rawCardName) continue;

      const normalizedName = normalizeCardName(rawCardName);
      if (!normalizedName) continue;

      // Track copy number
      const currentCopy = (copyNumberTracker.get(normalizedName) || 0) + 1;
      copyNumberTracker.set(normalizedName, currentCopy);

      // Get color for this pick
      let color = "";
      if (firstColorIndex !== -1) {
        const colorColIndex = firstColorIndex + drafterIndex;
        color = row[colorColIndex]?.trim() || "";
      }

      // Calculate actual pick position from round number and drafter index
      let pickPosition: number;
      if (
        doublePickStartsAfterRound === null ||
        roundNumber <= doublePickStartsAfterRound
      ) {
        // Standard snake draft: odd rounds left-to-right, even rounds right-to-left
        if (roundNumber % 2 === 1) {
          pickPosition = (roundNumber - 1) * numDrafters + (drafterIndex + 1);
        } else {
          pickPosition =
            (roundNumber - 1) * numDrafters + (numDrafters - drafterIndex);
        }
      } else {
        // Double-pick mode: pairs of rows form one "double round" with 2 picks per drafter
        const firstDoubleRound = doublePickStartsAfterRound + 1;
        const standardPickCount = doublePickStartsAfterRound * numDrafters;
        const doubleRoundPairIndex = Math.floor(
          (roundNumber - firstDoubleRound) / 2
        );
        const isSecondPickInPair =
          (roundNumber - firstDoubleRound) % 2;
        const basePosition =
          standardPickCount + doubleRoundPairIndex * numDrafters * 2 + 1;
        // Direction continues snake from last standard round
        const isReverse =
          doublePickStartsAfterRound % 2 === 1
            ? doubleRoundPairIndex % 2 === 0
            : doubleRoundPairIndex % 2 === 1;
        const drafterOrderIndex = isReverse
          ? numDrafters - 1 - drafterIndex
          : drafterIndex;
        // When an odd number of rows follows the threshold, the last row is a
        // trailing single round (one pick per drafter, contiguous numbering),
        // not the first half of a double pair.
        const isTrailingSingleRound =
          roundNumber === maxRound &&
          (maxRound - doublePickStartsAfterRound) % 2 === 1;
        pickPosition = isTrailingSingleRound
          ? basePosition + drafterOrderIndex
          : basePosition + drafterOrderIndex * 2 + isSecondPickInPair;
      }

      picks.push({
        cardName: normalizedName,
        pickPosition,
        copyNumber: currentCopy,
        wasPicked: true,
        draftId,
        seat: drafterIndex,
        color,
      });
    }
  }

  return {
    picks,
    numDrafters,
    drafterNames,
    isComplete,
    doublePickStartsAfterRound,
    picksPerPlayer: maxRound,
  };
}

/**
 * Parse match rows from a round robin tournament sheet.
 *
 * Row format:
 * - Rows 0-2: Headers (skipped)
 * - Row 3+: Match data
 *   - Column B (index 1): Player 1 name
 *   - Column C (index 2): Player 1 games won
 *   - Column D (index 3): "VS" marker
 *   - Column E (index 4): Player 2 games won
 *   - Column F (index 5): Player 2 name
 *
 * @param rows - Row data, or null if no match data available
 * @param drafterNames - Ordered drafter names (index = seat number)
 */
export function parseMatchRows(
  rows: string[][] | null,
  drafterNames: string[]
): MatchResult[] {
  if (!rows || rows.length < 4) {
    return [];
  }

  // Build name→seat map from drafterNames array
  const playerNameToSeat = new Map<string, number>();
  for (let i = 0; i < drafterNames.length; i++) {
    playerNameToSeat.set(drafterNames[i], i);
  }

  const matches: MatchResult[] = [];

  // Process match rows starting from row 4 (index 3)
  for (let rowIndex = 3; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row || row.length < 6) continue;

    const player1Name = row[1]?.trim();
    const player1GamesStr = row[2]?.trim();
    const vsMarker = row[3]?.trim();
    const player2GamesStr = row[4]?.trim();
    const player2Name = row[5]?.trim();

    // Validate row has required data
    if (!player1Name || !player2Name) continue;

    // Validate VS marker
    if (vsMarker !== "VS") continue;

    // Parse game counts
    const seat1GamesWon = parseInt(player1GamesStr, 10);
    const seat2GamesWon = parseInt(player2GamesStr, 10);

    if (isNaN(seat1GamesWon) || isNaN(seat2GamesWon)) continue;

    // Look up seat numbers
    const seat1 = playerNameToSeat.get(player1Name);
    const seat2 = playerNameToSeat.get(player2Name);

    if (seat1 === undefined || seat2 === undefined) continue;

    matches.push({
      seat1,
      seat2,
      seat1GamesWon,
      seat2GamesWon,
    });
  }

  return matches;
}
