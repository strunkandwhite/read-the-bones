/**
 * CSV parsing utilities for draft pick data.
 *
 * Parses the specific CSV format exported from the draft spreadsheet:
 * - Draft CSV: Contains pick-by-pick data for each drafter
 * - Cube/Pool CSV: Contains the full card pool with picked/unpicked status
 */

import Papa from "papaparse";
import type { CardPick } from "./types";

/**
 * Strips numeric suffix from card names (e.g., "Scalding Tarn 2" -> "Scalding Tarn")
 */
export function normalizeCardName(cardName: string): string {
  return cardName.trim().replace(/\s+\d+$/, "");
}

/**
 * Returns a lowercase key for case-insensitive card name matching.
 */
export function cardNameKey(cardName: string): string {
  return normalizeCardName(cardName).toLowerCase();
}

/**
 * Check if a value is an arrow character used in the draft CSV
 */
export function isArrow(value: string): boolean {
  return ["→", "↪", "↩", "✪"].includes(value.trim());
}

/**
 * Check if a draft is complete.
 *
 * Finds the row with ✪ marker (indicates last row of draft).
 * If that row has picks filled in, draft is complete.
 * If that row is empty, draft is incomplete.
 *
 * @param csvContent - Raw picks.csv content
 * @returns true if draft is complete, false if in-progress
 */
export function isDraftComplete(csvContent: string): boolean {
  const result = Papa.parse<string[]>(csvContent, {
    skipEmptyLines: false,
  });

  const rows = result.data;

  // Find the row containing ✪
  for (const row of rows) {
    if (row.some((cell) => cell?.includes("✪"))) {
      // Found the marker row - check if drafter columns have picks
      // Drafter columns start at index 2 (after pick# and arrow)
      // Check if column 2 (first drafter) has a pick
      const firstDrafterPick = row[2]?.trim();
      return !!firstDrafterPick && !isArrow(firstDrafterPick);
    }
  }

  // No ✪ marker found - assume complete (shouldn't happen in real data)
  return true;
}

/**
 * Parse a single draft's picks.csv file.
 *
 * CSV Format:
 * - Row 1-2: Headers/metadata (ignored)
 * - Row 3: Drafter names starting from column C (A=pick#, B=arrow)
 * - Row 4+: Pick data with colors in rightmost columns after the arrow marker
 *
 * @param csvContent - Raw CSV content as string
 * @param draftId - Identifier for this draft
 * @returns Object with picks array and number of drafters
 */
export function parseDraftPicks(
  csvContent: string,
  draftId: string
): { picks: CardPick[]; numDrafters: number; drafterNames: string[] } {
  const result = Papa.parse<string[]>(csvContent, {
    skipEmptyLines: false,
  });

  // Note: Papa Parse may report recoverable errors (e.g., missing quotes, field count mismatch).
  // These don't prevent parsing - the data is still usable, so we continue silently.

  const rows = result.data;
  if (rows.length < 4) {
    return { picks: [], numDrafters: 0, drafterNames: [] }; // Not enough rows for valid data
  }

  // Row 3 (index 2) contains drafter names starting from column C (index 2)
  const drafterRow = rows[2];

  // Find where drafter names end by looking for empty cells or the arrow marker column
  // Drafter names are in columns C onwards until we hit empty cells
  const drafterNames: string[] = [];
  let drafterEndIndex = 2; // Start after columns A and B

  for (let i = 2; i < drafterRow.length; i++) {
    const cell = drafterRow[i]?.trim();
    if (cell && !isArrow(cell)) {
      drafterNames.push(cell);
      drafterEndIndex = i + 1;
    } else if (isArrow(cell)) {
      // Hit the arrow marker, stop collecting drafter names
      break;
    } else if (!cell && drafterNames.length > 0) {
      // Empty cell after collecting names - drafter names are contiguous, so stop here
      break;
    }
  }

  // Actually, let's re-examine: the arrow in the drafter row marks where color data starts
  // Looking at the data, the drafter row has names, then "↩" marker, then additional metadata
  // Let's find the ↩ marker in the drafter row to determine the end of drafter columns

  const arrowIndexInDrafterRow = drafterRow.findIndex(
    (cell, idx) => idx > 1 && isArrow(cell?.trim())
  );

  if (arrowIndexInDrafterRow > 2) {
    // Re-collect drafter names up to the arrow
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
    return { picks: [], numDrafters: 0, drafterNames: [] };
  }

  // Track copy numbers for each card name across the entire draft
  const copyNumberTracker = new Map<string, number>();

  const picks: CardPick[] = [];

  // Process pick rows starting from row 4 (index 3)
  for (let rowIndex = 3; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row || row.length < 3) continue;

    // Column A is round number (not absolute pick position)
    const roundNumberStr = row[0]?.trim();
    const roundNumber = parseInt(roundNumberStr, 10);
    if (isNaN(roundNumber)) continue;

    // Column B is arrow (ignored)
    // Columns C onwards are card picks for each drafter

    // Find where color data starts by looking for single-letter color codes at the end
    // Row 4: 1,→,"Phelia...",Swords..., ..., Birds of Paradise,↩, ,,,Draft Status,,,,W,W,B,R,G,U,B,U,R,C,U,G
    // The colors W,W,B,R,G,U,B,U,R,C,U,G correspond to the 12 drafters

    // Let's find the color section by looking for single-letter color codes at the end
    const colorPattern = /^[WUBRGC]+$/;
    let firstColorIndex = -1;

    // Search backwards from the end to find color columns
    for (let i = row.length - 1; i >= 0; i--) {
      const cell = row[i]?.trim();
      if (cell && colorPattern.test(cell)) {
        firstColorIndex = i;
      } else if (firstColorIndex !== -1 && cell && !colorPattern.test(cell)) {
        // We've moved past the color section
        break;
      }
    }

    // Find the actual start of colors by counting back from the end
    // Colors should be numDrafters columns
    if (firstColorIndex === -1) {
      // No colors found, try another approach: count numDrafters from the end
      const potentialColorStart = row.length - numDrafters;
      if (potentialColorStart > drafterEndIndex) {
        firstColorIndex = potentialColorStart;
      }
    }

    // Process each drafter's pick
    for (let drafterIndex = 0; drafterIndex < numDrafters; drafterIndex++) {
      const cardColIndex = 2 + drafterIndex; // Columns C onwards
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
      // Snake draft: odd rounds go left-to-right, even rounds go right-to-left
      let pickPosition: number;
      if (roundNumber % 2 === 1) {
        // Odd rounds: drafter 0 picks first
        pickPosition = (roundNumber - 1) * numDrafters + (drafterIndex + 1);
      } else {
        // Even rounds: drafter 0 picks last (snake back)
        pickPosition = (roundNumber - 1) * numDrafters + (numDrafters - drafterIndex);
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

  return { picks, numDrafters, drafterNames };
}

/**
 * Parse a pool/cube CSV to get all available card names.
 *
 * CSV Format (Cube CSV):
 * - Column A: Check mark (✓ if picked, empty if not)
 * - Column B: Card name
 *
 * @param csvContent - Raw CSV content as string
 * @returns Array of all card names in the pool
 */
export function parsePool(csvContent: string): string[] {
  const result = Papa.parse<string[]>(csvContent, {
    skipEmptyLines: false,
  });

  // Note: Papa Parse may report recoverable errors (e.g., missing quotes, field count mismatch).
  // These don't prevent parsing - the data is still usable, so we continue silently.

  const rows = result.data;
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
 * Parse a pool/cube CSV to get unpicked cards with their colors.
 * Internal helper for parseDraft.
 *
 * CSV Format (Cube CSV):
 * - Column A: Check mark (✓ if picked, empty if not)
 * - Column B: Card name
 * - Column D: Color
 *
 * @param csvContent - Raw CSV content as string
 * @returns Array of unpicked cards with name and color
 */
function parseUnpickedCards(csvContent: string): Array<{ name: string; color: string }> {
  const result = Papa.parse<string[]>(csvContent, {
    skipEmptyLines: false,
  });

  // Note: Papa Parse may report recoverable errors (e.g., missing quotes, field count mismatch).
  // These don't prevent parsing - the data is still usable, so we continue silently.

  const rows = result.data;
  const unpickedCards: Array<{ name: string; color: string }> = [];

  // Skip header row (index 0)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const checkMark = row[0]?.trim();
    const cardName = row[1]?.trim();

    if (!cardName) continue;

    const normalizedName = normalizeCardName(cardName);
    if (!normalizedName) continue;

    // If not checked (no ✓), it's unpicked
    if (checkMark !== "✓") {
      const color = row[3]?.trim() || ""; // Color is in column D (index 3)
      unpickedCards.push({ name: normalizedName, color });
    }
  }

  return unpickedCards;
}

/**
 * Parse a complete draft folder containing picks and pool CSVs.
 *
 * Creates CardPick records for both picked cards (from picks CSV)
 * and unpicked cards (from pool CSV, with pickPosition = poolSize).
 *
 * @param picksCsv - Content of the draft picks CSV
 * @param poolCsv - Content of the pool/cube CSV
 * @param draftId - Identifier for this draft
 * @returns Object with all picks, the pool size, and number of drafters
 */
export function parseDraft(
  picksCsv: string,
  poolCsv: string,
  draftId: string
): { picks: CardPick[]; poolSize: number; numDrafters: number; drafterNames: string[] } {
  // Parse the picks first
  const { picks, numDrafters, drafterNames } = parseDraftPicks(picksCsv, draftId);

  // Parse the pool to get pool size
  const allCards = parsePool(poolCsv);
  const poolSize = allCards.length;

  // Parse unpicked cards with their colors
  const unpickedCards = parseUnpickedCards(poolCsv);

  // Track copy numbers for unpicked cards
  // Start from where the picked cards left off
  const copyTracker = new Map<string, number>();
  for (const pick of picks) {
    const current = copyTracker.get(pick.cardName) || 0;
    copyTracker.set(pick.cardName, Math.max(current, pick.copyNumber));
  }

  // Create CardPick records for unpicked cards
  // Each unpicked card gets pickPosition = poolSize (worst possible pick)
  for (const unpicked of unpickedCards) {
    const currentCopy = (copyTracker.get(unpicked.name) || 0) + 1;
    copyTracker.set(unpicked.name, currentCopy);

    picks.push({
      cardName: unpicked.name,
      pickPosition: poolSize,
      copyNumber: currentCopy,
      wasPicked: false,
      draftId,
      seat: -1, // Unpicked cards don't belong to any seat
      color: unpicked.color,
    });
  }

  return { picks, poolSize, numDrafters, drafterNames };
}
