/**
 * Export card table data as CSV to stdout.
 *
 * Usage:
 *   source .env.local && npx tsx scripts/export-card-csv.ts > cards.csv
 */

import { getCards } from "../src/core/getCards";
import { wilsonInterval } from "../src/core/wilsonInterval";

async function main() {
  const { cards } = await getCards({ includeMatchData: true });

  const headers = [
    "Card Name",
    "Color Identity",
    "Pick Score",
    "Drafts Picked In",
    "Times Available",
    "Total Picks",
    "Times Unpicked",
    "Deck Win Rate",
    "Deck WR 95% CI Low",
    "Deck WR 95% CI High",
    "Deck WR Games",
  ];
  console.log(headers.join(","));

  const sorted = [...cards].sort((a, b) => a.weightedGeomean - b.weightedGeomean);

  for (const c of sorted) {
    let deckWR = "";
    let ciLow = "";
    let ciHigh = "";
    let deckGames = "";

    if (c.decklistWinRate) {
      const wr = c.decklistWinRate;
      const total = wr.gameWins + wr.gameLosses;
      deckWR = (wr.winRate * 100).toFixed(1) + "%";
      deckGames = String(total);

      const [lo, hi] = wilsonInterval(wr.gameWins, total);
      ciLow = (lo * 100).toFixed(1) + "%";
      ciHigh = (hi * 100).toFixed(1) + "%";
    }

    const row = [
      csvEscape(c.cardName),
      c.colors.join("") || "C",
      c.weightedGeomean.toFixed(1),
      c.draftsPickedIn,
      c.timesAvailable,
      c.totalPicks,
      c.timesUnpicked,
      deckWR,
      ciLow,
      ciHigh,
      deckGames,
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
