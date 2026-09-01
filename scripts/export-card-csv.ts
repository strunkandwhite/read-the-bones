/**
 * Export the current card pool as CSV.
 *
 * Columns mirror the main card table (name, mana value, type, colors, P#) and add
 * the two metrics the table only exposes elsewhere: GPWR (the stats modal's
 * game-play win rate) and PVI (the worth model's over/under-delivery z-score,
 * rendered both raw and as a plain-English rating).
 *
 * Rows are the current cube — getCards already filters to the latest cube
 * snapshot and stubs in cards too new to have pick history.
 *
 * Writes to a file rather than stdout because dotenv and getCards both log to
 * stdout during startup, which corrupts a redirected CSV.
 *
 * Usage:
 *   npx tsx scripts/export-card-csv.ts [output-path]   # default: cards.csv
 */

import { writeFileSync } from "node:fs";
import { getCards } from "../src/core/getCards";
import { getClient } from "../src/core/db/client";
import { getAllCardWinStats } from "../src/core/db/queries/winStats";
import { getWorthTable } from "../src/core/db/queries/stats/worth";
import { loadEnv } from "../src/core/db/ingest/utils";
import { cardNameKey } from "../src/core/cardNames";
import { normalizeColorIdentity } from "../src/core/manaColors";
import { ciMarginPct } from "../src/core/wilsonInterval";

/**
 * Rating bands, in standard deviations of the exported pool's own PVI spread.
 *
 * PVI is nominally a z-score, but its observed spread runs wider than 1
 * (2026-09-01: σ = 1.32 over 412 cards) because real quality varies on top of
 * sampling noise — the same overdispersion the worth model estimates as τ.
 * Banding on a fixed ±1 would therefore call ordinary cards remarkable, so the
 * cuts are measured from the data each run rather than pinned, matching how
 * the worth model recomputes every parameter on demand.
 *
 * Bands are centered on zero, not on the observed mean: PVI is already
 * centered on the price curve by construction (measured mean −0.06,
 * median 0.00), so re-centering would only add noise.
 */
const RATING_BANDS: { sigmas: number; over: string; under: string }[] = [
  { sigmas: 2, over: "Very overrated", under: "Very underrated" },
  { sigmas: 1, over: "Overrated", under: "Underrated" },
];

const HEADERS = ["Card Name", "MV", "Type", "Colors", "P#", "GPWR", "GPWR Seats", "PVI", "Rating"];

async function main() {
  loadEnv();

  const outputPath = process.argv[2] ?? "cards.csv";

  const client = await getClient();
  const [{ cards }, winStats, worth] = await Promise.all([
    getCards({}),
    getAllCardWinStats(client),
    getWorthTable(),
  ]);

  // Mirrors how the client keys each source: worth by raw card name,
  // win stats by the normalized key.
  const worthByName = new Map(worth.cards.map((card) => [card.card_name, card]));

  // The table's default sort: best pick score first. New cards carry
  // Infinity, so they land at the bottom on their own.
  const sorted = [...cards].sort((a, b) => a.weightedGeomean - b.weightedGeomean);

  // Measured over the exported pool only: the bands describe how this cube's
  // cards spread against each other, not how every card ever drafted does.
  const pviValues = sorted
    .map((card) => worthByName.get(card.cardName)?.pvi ?? null)
    .filter((pvi): pvi is number => pvi !== null);
  const pviSigma = standardDeviation(pviValues);

  const lines = [HEADERS.join(",")];

  for (const card of sorted) {
    const ws = winStats.get(cardNameKey(card.cardName));
    const pvi = worthByName.get(card.cardName)?.pvi ?? null;
    // card.colors holds already-joined identities ("UB"), so it can only be
    // normalized when Scryfall gave us the per-letter array.
    const colors = card.scryfall
      ? normalizeColorIdentity(card.scryfall.colorIdentity)
      : (card.colors[0] ?? "C");

    const row = [
      card.cardName,
      card.scryfall?.manaValue ?? "",
      card.scryfall?.typeLine ?? "",
      colors,
      isFinite(card.weightedGeomean) ? card.weightedGeomean.toFixed(2) : "",
      ws ? `${(ws.win_rate * 100).toFixed(1)}% ±${ciMarginPct(ws.ci)}%` : "",
      ws ? ws.sample_size : "", // seats that maindecked it, not games
      pvi !== null ? formatSignedPvi(pvi) : "",
      rating(pvi, pviSigma),
    ];

    lines.push(row.map(csvEscape).join(","));
  }

  writeFileSync(outputPath, lines.join("\n") + "\n");
  console.log(
    `Wrote ${sorted.length} cards to ${outputPath} ` +
      `(PVI σ = ${pviSigma.toFixed(2)} over ${pviValues.length} rated cards)`
  );
}

/** Sample standard deviation; 0 for fewer than two values. */
function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function formatSignedPvi(pvi: number): string {
  return `${pvi >= 0 ? "+" : ""}${pvi.toFixed(1)}`;
}

/**
 * Positive PVI means the card wins more than its pick position predicts —
 * the table is underrating it.
 */
function rating(pvi: number | null, sigma: number): string {
  if (pvi === null) return "(no data)";
  if (sigma <= 0) return "Fair";

  for (const band of RATING_BANDS) {
    if (pvi >= band.sigmas * sigma) return band.under;
    if (pvi <= -band.sigmas * sigma) return band.over;
  }
  return "Fair";
}

function csvEscape(value: string | number): string {
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
