/**
 * Export card table data as CSV to stdout.
 *
 * Usage:
 *   source .env.local && npx tsx scripts/export-card-csv.ts > cards.csv
 */

import { getCards } from "../src/core/getCards";

async function main() {
  const { cards } = await getCards({});

  const headers = [
    "Card Name",
    "Color Identity",
    "Pick Score",
    "Drafts Picked In",
    "Times Available",
  ];
  console.log(headers.join(","));

  const sorted = [...cards].sort((a, b) => a.weightedGeomean - b.weightedGeomean);

  for (const c of sorted) {
    const row = [
      csvEscape(c.cardName),
      c.colors.join("") || "C",
      c.weightedGeomean.toFixed(1),
      c.draftsPickedIn,
      c.timesAvailable,
    ];
    console.log(row.join(","));
  }
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
