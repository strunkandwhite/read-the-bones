/**
 * Google Sheets integration utilities.
 * Fetches draft data (picks, pool, matches) from Google Sheets using the google-spreadsheet library.
 */

import { GoogleSpreadsheet } from "google-spreadsheet";

/** Standard tab names in draft spreadsheets */
export const TAB_NAMES = {
  picks: "Draft",
  pool: "Cube",
  matches: "Matches",
} as const;

/** Result of fetching raw row arrays from a draft Google Sheet */
export interface DraftSheetRawData {
  picks: string[][] | null;
  pool: string[][] | null;
  matches: string[][] | null;
}

/**
 * Fetch all data from a Google Sheet tab as a 2D array.
 * Returns raw cell values including empty cells.
 */
async function fetchSheetTab(
  doc: GoogleSpreadsheet,
  tabName: string
): Promise<string[][] | null> {
  const sheet = doc.sheetsByTitle[tabName];
  if (!sheet) {
    return null;
  }

  // Load all cells in the sheet
  await sheet.loadCells();

  const rows: string[][] = [];
  for (let r = 0; r < sheet.rowCount; r++) {
    const row: string[] = [];
    let hasContent = false;

    for (let c = 0; c < sheet.columnCount; c++) {
      const cell = sheet.getCell(r, c);
      const value = cell.formattedValue ?? "";
      row.push(value);
      if (value) hasContent = true;
    }

    // Stop at first completely empty row (optimization for large sheets)
    if (!hasContent && r > 0) {
      // Check if this is just a gap or the actual end
      // Look ahead a few rows to be sure
      let foundContent = false;
      for (let ahead = 1; ahead <= 5 && r + ahead < sheet.rowCount; ahead++) {
        for (let c = 0; c < Math.min(10, sheet.columnCount); c++) {
          if (sheet.getCell(r + ahead, c).formattedValue) {
            foundContent = true;
            break;
          }
        }
        if (foundContent) break;
      }
      if (!foundContent) break;
    }

    rows.push(row);
  }

  // Trim trailing empty columns
  const maxColWithContent = rows.reduce((max, row) => {
    const lastNonEmpty = row.reduce(
      (last, cell, i) => (cell ? i : last),
      -1
    );
    return Math.max(max, lastNonEmpty);
  }, -1);

  if (maxColWithContent >= 0) {
    return rows.map((row) => row.slice(0, maxColWithContent + 1));
  }

  return rows;
}

/**
 * Fetch draft data from a Google Sheet as raw row arrays.
 * Returns string[][] for each tab without CSV conversion.
 *
 * @public
 * @param sheetId - The Google Sheets document ID
 * @param apiKey - Google API key for authentication
 * @returns Object with raw row arrays for each tab (null if tab not found)
 */
export async function fetchDraftTabsRaw(
  sheetId: string,
  apiKey: string,
): Promise<DraftSheetRawData> {
  const doc = new GoogleSpreadsheet(sheetId, { apiKey });
  await doc.loadInfo();

  return {
    picks: await fetchSheetTab(doc, TAB_NAMES.picks),
    pool: await fetchSheetTab(doc, TAB_NAMES.pool),
    matches: await fetchSheetTab(doc, TAB_NAMES.matches),
  };
}

