/**
 * Draft state parsing for the CLI suggestion tool.
 *
 * Handles snake draft position math, parsing in-progress drafts,
 * and inferring opponent colors from their picks.
 */

import Papa from "papaparse";
import { normalizeCardName, cardNameKey, isArrow } from "../core/parseCsv";
import type { ScryCard } from "../core/types";
import type { DraftState } from "./types";

/** Get the user's drafter name from environment variable or default */
function getUserName(): string {
  return process.env.DRAFT_USER_NAME || "User";
}

/** Default round number after which double-pick mode starts */
const DEFAULT_DOUBLE_PICK_STARTS_AFTER_ROUND = 25;

/**
 * Calculate which drafter's turn it is for a given pick number.
 * Handles both standard snake draft and double-pick mode.
 *
 * Snake draft order (before double-pick threshold):
 * - Pick 1-N: forward (0 → N-1)
 * - Pick N+1 to 2N: reverse (N-1 → 0)
 * - Pick 2N+1 to 3N: forward again
 * - etc.
 *
 * Double-pick mode (after threshold):
 * - Each round has 2N picks (N drafters × 2 picks each)
 * - Round direction alternates (forward/reverse) continuing the snake pattern
 * - Each player picks twice consecutively before moving to the next
 *
 * @param pickNumber - 1-indexed pick number
 * @param numDrafters - Total number of drafters
 * @param doublePickStartsAfterRound - Round after which double-pick mode begins (default: 25)
 * @returns 0-indexed drafter index
 */
export function getDrafterForPick(
  pickNumber: number,
  numDrafters: number,
  doublePickStartsAfterRound: number = DEFAULT_DOUBLE_PICK_STARTS_AFTER_ROUND
): number {
  const doublePickStart = doublePickStartsAfterRound * numDrafters + 1;

  if (pickNumber < doublePickStart) {
    // Standard snake draft for rounds 1-25
    const zeroIndexed = pickNumber - 1;
    const round = Math.floor(zeroIndexed / numDrafters);
    const position = zeroIndexed % numDrafters;
    return round % 2 === 0 ? position : numDrafters - 1 - position;
  }

  // Double-pick mode (rounds 26+)
  // Each round has 20 picks (10 players × 2)
  const picksPerDoubleRound = numDrafters * 2;
  const pickInDoubleMode = pickNumber - doublePickStart; // 0-indexed from start of double mode
  const doubleRound = Math.floor(pickInDoubleMode / picksPerDoubleRound);
  const positionInRound = pickInDoubleMode % picksPerDoubleRound;

  // Each player takes 2 consecutive picks
  const drafterPosition = Math.floor(positionInRound / 2);

  // Round 26 (doubleRound=0) is reverse, round 27 (doubleRound=1) is forward, etc.
  // This continues from round 25 which was forward, so round 26 is reverse
  const isForwardRound = doubleRound % 2 === 1;

  return isForwardRound ? drafterPosition : numDrafters - 1 - drafterPosition;
}

/**
 * Extract metadata value from CSV rows by searching for a label.
 *
 * @param rows - Parsed CSV rows
 * @param label - Label to search for (e.g., "Picks Made:")
 * @returns The value in the cell after the label, or null if not found
 */
function extractMetadata(rows: string[][], label: string): string | null {
  for (const row of rows) {
    for (let i = 0; i < row.length - 1; i++) {
      if (row[i]?.trim() === label) {
        return row[i + 1]?.trim() || null;
      }
    }
  }
  return null;
}

/**
 * Parse an in-progress draft CSV to build DraftState.
 *
 * CSV Format:
 * - Row 1-2: Headers (ignored)
 * - Row 3: Drafter names starting from column C (index 2)
 * - Row 4+: Pick data (column A = pick number, columns C onwards = card names)
 * - Metadata columns on the right contain "Picks Made:", "Next Player:", etc.
 *
 * Note: This parser reads the "Picks Made" metadata from the spreadsheet rather than
 * calculating from empty cells, because the draft may use double-pick mode (after round 25)
 * which changes the pick order in ways that aren't captured by simple snake draft math.
 *
 * @param picksCsvContent - Raw CSV content from picks.csv
 * @param poolCsvContent - Raw CSV content from pool.csv
 * @returns DraftState object for use in suggestions
 * @throws Error if user is not found in drafter list or CSV format is invalid
 */
export function parseDraftState(picksCsvContent: string, poolCsvContent: string): DraftState {
  // Parse picks CSV
  const picksResult = Papa.parse<string[]>(picksCsvContent, {
    skipEmptyLines: false,
  });

  if (picksResult.errors.length > 0) {
    console.warn("CSV parsing warnings:", picksResult.errors);
  }

  const rows = picksResult.data;
  if (rows.length < 4) {
    throw new Error("Invalid picks CSV: not enough rows (expected at least 4 for headers + picks)");
  }

  // Row 3 (index 2) contains drafter names starting from column C (index 2)
  const drafterRow = rows[2];

  // Find where drafter names end by looking for the arrow marker
  const arrowIndex = drafterRow.findIndex((cell, idx) => idx > 1 && isArrow(cell?.trim() ?? ""));

  // Collect drafter names up to the arrow (or end of non-empty cells)
  const drafters: string[] = [];
  const endIndex = arrowIndex > 2 ? arrowIndex : drafterRow.length;

  for (let i = 2; i < endIndex; i++) {
    const name = drafterRow[i]?.trim();
    // Skip empty, arrow, and Excel error values
    if (name && !isArrow(name) && !name.startsWith("#")) {
      drafters.push(name);
    }
  }

  if (drafters.length === 0) {
    throw new Error("Invalid picks CSV: no drafter names found in row 3");
  }

  // Find the user in the drafter list
  // Matches the user name exactly, or decorated names like "◈  User  ◈" (name surrounded by non-letters)
  const userName = getUserName();
  const userIndex = drafters.findIndex((name) => {
    if (name === userName) return true;
    // Check if the user name appears as a standalone word
    const stripped = name.replace(/[^a-zA-Z]/g, "");
    return stripped === userName;
  });
  if (userIndex === -1) {
    throw new Error(
      `User "${userName}" not found in drafter list. ` +
        `Set DRAFT_USER_NAME environment variable to your drafter name. ` +
        `Found drafters: ${drafters.join(", ")}`
    );
  }

  const numDrafters = drafters.length;

  // Build allPicks map by collecting all cards from each drafter's column
  const allPicks = new Map<string, string[]>();
  for (const drafter of drafters) {
    allPicks.set(drafter, []);
  }

  const pickedCards = new Set<string>();

  // Track first empty cell in snake order (for fallback when no metadata)
  let firstEmptyPickNumber: number | null = null;

  // Process pick rows starting from row 4 (index 3)
  for (let rowIndex = 3; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row || row.length < 3) continue;

    // Column A is round number (1-indexed)
    const roundNumberStr = row[0]?.trim();
    const roundNumber = parseInt(roundNumberStr, 10);
    if (isNaN(roundNumber)) continue;

    // Determine pick order for this round based on snake draft
    // Note: This assumes standard snake order (rounds 1-25) for the fallback
    const isForwardRound = roundNumber % 2 === 1;

    // Process drafters in snake order to find first empty cell
    for (let i = 0; i < numDrafters; i++) {
      const drafterIndex = isForwardRound ? i : numDrafters - 1 - i;
      const cardColIndex = 2 + drafterIndex;
      const rawCardName = row[cardColIndex]?.trim();

      // Calculate actual pick number for this position
      const pickInRound = i + 1;
      const actualPickNumber = (roundNumber - 1) * numDrafters + pickInRound;

      if (rawCardName) {
        const normalizedName = normalizeCardName(rawCardName);
        if (normalizedName) {
          allPicks.get(drafters[drafterIndex])!.push(normalizedName);
          pickedCards.add(normalizedName);
        }
      } else if (firstEmptyPickNumber === null) {
        // Found the first empty cell in snake order
        firstEmptyPickNumber = actualPickNumber;
      }
    }
  }

  // Read double-pick threshold from spreadsheet metadata
  const doublePicksAfterStr = extractMetadata(rows, "Double Picks After:");
  const doublePickStartsAfterRound = doublePicksAfterStr
    ? parseInt(doublePicksAfterStr, 10) || DEFAULT_DOUBLE_PICK_STARTS_AFTER_ROUND
    : DEFAULT_DOUBLE_PICK_STARTS_AFTER_ROUND;

  // Read current pick number from spreadsheet metadata
  // The spreadsheet calculates this correctly even with double-pick mode
  const picksMadeStr = extractMetadata(rows, "Picks Made:");
  let currentPickNumber: number;

  if (picksMadeStr) {
    const picksMade = parseInt(picksMadeStr, 10);
    if (!isNaN(picksMade)) {
      currentPickNumber = picksMade + 1;
    } else if (firstEmptyPickNumber !== null) {
      // Fallback: use first empty cell in snake order
      currentPickNumber = firstEmptyPickNumber;
    } else {
      // No empty cells, draft is complete
      let totalPicks = 0;
      for (const picks of allPicks.values()) {
        totalPicks += picks.length;
      }
      currentPickNumber = totalPicks + 1;
    }
  } else if (firstEmptyPickNumber !== null) {
    // Fallback: use first empty cell in snake order
    currentPickNumber = firstEmptyPickNumber;
  } else {
    // No empty cells, draft is complete
    let totalPicks = 0;
    for (const picks of allPicks.values()) {
      totalPicks += picks.length;
    }
    currentPickNumber = totalPicks + 1;
  }

  // Parse pool CSV to get all available cards
  const poolResult = Papa.parse<string[]>(poolCsvContent, {
    skipEmptyLines: false,
  });

  if (poolResult.errors.length > 0) {
    console.warn("Pool CSV parsing warnings:", poolResult.errors);
  }

  const poolRows = poolResult.data;
  const allPoolCards: string[] = [];

  // Skip header row (index 0), column B (index 1) contains card names
  for (let i = 1; i < poolRows.length; i++) {
    const row = poolRows[i];
    if (!row || row.length < 2) continue;

    const cardName = row[1]?.trim();
    if (!cardName) continue;

    const normalizedName = normalizeCardName(cardName);
    if (normalizedName) {
      allPoolCards.push(normalizedName);
    }
  }

  // Calculate available cards (pool minus picked)
  const availableCards = allPoolCards.filter((card) => !pickedCards.has(card));

  // Read current drafter from spreadsheet metadata
  // "Next Player:" contains a 1-indexed player number
  const nextPlayerStr = extractMetadata(rows, "Next Player:");
  let currentDrafterIndex: number;

  if (nextPlayerStr) {
    const nextPlayer = parseInt(nextPlayerStr, 10);
    if (!isNaN(nextPlayer) && nextPlayer >= 1 && nextPlayer <= numDrafters) {
      // Convert from 1-indexed to 0-indexed
      currentDrafterIndex = nextPlayer - 1;
    } else {
      // Fallback to snake draft calculation
      currentDrafterIndex = getDrafterForPick(currentPickNumber, numDrafters, doublePickStartsAfterRound);
    }
  } else {
    // Fallback to snake draft calculation
    currentDrafterIndex = getDrafterForPick(currentPickNumber, numDrafters, doublePickStartsAfterRound);
  }

  const isUsersTurn = currentDrafterIndex === userIndex;

  // Calculate picks until user's turn by scanning forward with getDrafterForPick
  // This handles both standard snake and double-pick modes correctly
  let picksUntilUser = 0;
  if (!isUsersTurn) {
    // Scan forward up to 4 rounds worth of picks to find user's next turn
    const maxOffset = numDrafters * 4;
    for (let offset = 1; offset <= maxOffset; offset++) {
      const checkPick = currentPickNumber + offset;
      if (getDrafterForPick(checkPick, numDrafters, doublePickStartsAfterRound) === userIndex) {
        picksUntilUser = offset;
        break;
      }
    }
  }

  const userPicks = allPicks.get(drafters[userIndex]) ?? [];

  return {
    drafters,
    userIndex,
    currentPickNumber,
    currentDrafterIndex,
    isUsersTurn,
    picksUntilUser,
    userPicks,
    allPicks,
    availableCards,
    poolSize: allPoolCards.length,
    doublePickStartsAfterRound,
  };
}

/**
 * Infer a drafter's likely colors based on their picks.
 *
 * Counts color occurrences from Scryfall data and returns the top 1-2 colors
 * that appear most frequently in the drafter's picks.
 *
 * @param picks - Array of card names the drafter has picked
 * @param scryfallCache - Map of card names to Scryfall card data
 * @returns Array of 1-2 color letters (e.g., ["U", "R"] or ["G"])
 */
export function inferDrafterColors(
  picks: string[],
  scryfallCache: Map<string, ScryCard>
): string[] {
  // Count occurrences of each color
  const colorCounts = new Map<string, number>();

  for (const cardName of picks) {
    const card = scryfallCache.get(cardNameKey(cardName));
    if (!card) continue;

    // Use colorIdentity for better deck color detection (includes costs and text)
    // Fall back to colors if colorIdentity is empty
    const colors = card.colorIdentity.length > 0 ? card.colorIdentity : card.colors;

    for (const color of colors) {
      colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
    }
  }

  // Sort colors by frequency (descending)
  const sortedColors = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => color);

  // Return top 1-2 colors
  // If the second color has significantly fewer cards, only return the top color
  if (sortedColors.length === 0) {
    return [];
  }

  if (sortedColors.length === 1) {
    return [sortedColors[0]];
  }

  const topCount = colorCounts.get(sortedColors[0]) || 0;
  const secondCount = colorCounts.get(sortedColors[1]) || 0;

  // Only include second color if it's at least 30% as frequent as the first
  if (secondCount >= topCount * 0.3) {
    return [sortedColors[0], sortedColors[1]];
  }

  return [sortedColors[0]];
}
