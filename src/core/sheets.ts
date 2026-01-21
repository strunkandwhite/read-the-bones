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

/** Result of fetching a draft from Google Sheets */
export type DraftSheetData = {
  picks: string | null;
  pool: string | null;
  matches: string | null;
};

/**
 * Convert a 2D array of cell values to CSV format.
 * Handles proper escaping of commas and quotes.
 */
export function rowsToCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell?.toString() ?? "";
          // Escape quotes and wrap in quotes if contains comma, quote, or newline
          if (value.includes(",") || value.includes('"') || value.includes("\n")) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        })
        .join(",")
    )
    .join("\n");
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
 * Fetch draft data from a Google Sheet.
 * Returns CSV strings for picks, pool, and matches tabs.
 *
 * @param sheetId - The Google Sheets document ID
 * @param apiKey - Google API key for authentication
 * @returns Object with CSV strings for each tab (null if tab not found)
 */
export async function fetchDraftFromSheet(
  sheetId: string,
  apiKey: string
): Promise<DraftSheetData> {
  const doc = new GoogleSpreadsheet(sheetId, { apiKey });

  await doc.loadInfo();

  const result: DraftSheetData = {
    picks: null,
    pool: null,
    matches: null,
  };

  // Fetch each tab
  for (const [key, tabName] of Object.entries(TAB_NAMES)) {
    const rows = await fetchSheetTab(doc, tabName);
    if (rows) {
      result[key as keyof DraftSheetData] = rowsToCsv(rows);
    }
  }

  return result;
}

/**
 * Extract sheet ID from a Google Sheets URL.
 * @example
 * parseSheetIdFromUrl("https://docs.google.com/spreadsheets/d/1KRXt6DfuGHmJG8yYfgCjSNtMJbMKPQDo1UUsdsJGMKY/edit?gid=123")
 * // Returns "1KRXt6DfuGHmJG8yYfgCjSNtMJbMKPQDo1UUsdsJGMKY"
 */
export function parseSheetIdFromUrl(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? null;
}
