/**
 * Export every card that has ever been in the cube as CSV.
 *
 * Rows come from the worth table, whose universe is the current cube plus the
 * cube snapshot of every stats-phase draft — so cards cut from the cube keep
 * their history instead of vanishing. The "In Cube" column separates the two.
 *
 * Columns mirror the main card table (name, mana value, type, colors, P#) and
 * add the two metrics the table only exposes elsewhere: GPWR (the stats
 * modal's game-play win rate) and PVI (the worth model's over/under-delivery
 * z-score, rendered both raw and as a plain-English rating).
 *
 * Writes to a file rather than stdout because dotenv logs to stdout during
 * startup, which corrupts a redirected CSV.
 *
 * Usage:
 *   npx tsx scripts/export-card-csv.ts [output-path]   # default: cards.csv
 */

import { writeFileSync } from "node:fs";
import { getCards } from "../src/core/getCards";
import { getClient, type Client } from "../src/core/db/client";
import { getAllCardWinStats } from "../src/core/db/queries/winStats";
import { getWorthTable } from "../src/core/db/queries/stats/worth";
import { transformScryfallJson } from "../src/core/db/queries/helpers";
import { loadEnv } from "../src/core/db/ingest/utils";
import { cardNameKey } from "../src/core/cardNames";
import { normalizeColorIdentity } from "../src/core/manaColors";
import { ciMarginPct } from "../src/core/wilsonInterval";
import type { ScryCard } from "../src/core/types";

/**
 * Rating bands, in standard deviations of the exported pool's own PVI spread.
 *
 * PVI is nominally a z-score, but its observed spread runs wider than 1
 * (2026-09-01: σ = 1.32 over the current cube) because real quality varies on
 * top of sampling noise — the same overdispersion the worth model estimates as
 * τ. Banding on a fixed ±1 would therefore call ordinary cards remarkable, so
 * the cuts are measured from the data each run rather than pinned, matching how
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

const HEADERS = [
  "Card Name",
  "MV",
  "Type",
  "Colors",
  "In Cube",
  "P#",
  "GPWR",
  "GPWR Seats",
  "PVI",
  "Rating",
];

async function main() {
  loadEnv();

  const outputPath = process.argv[2] ?? "cards.csv";

  const client = await getClient();
  const [{ cards }, winStats, worth, scryfall] = await Promise.all([
    getCards({}),
    getAllCardWinStats(client),
    getWorthTable(),
    loadScryfallByCardKey(client),
  ]);

  // P# comes from getCards where it can, because that is the number the card
  // table shows: it drops a draft's banned cards before scoring, while the
  // worth table's geomean does not (a known gap, recorded in todo.md), which
  // leaves a banned card carrying an unpicked penalty it never earned. The two
  // agree for all but a handful of cards, and only getCards covers the current
  // cube — cut cards necessarily fall back to the worth table's geomean.
  const tablePickScore = new Map(
    cards
      .filter((card) => isFinite(card.weightedGeomean))
      .map((card) => [card.cardName, card.weightedGeomean])
  );

  const pickScoreFor = (cardName: string, geomean: number | null): number | null =>
    tablePickScore.get(cardName) ?? geomean;

  // Best pick score first, like the card table's default sort. Cards with no
  // pick history at all (never in a stats-phase draft's pool) sort last.
  const sorted = [...worth.cards].sort(
    (a, b) =>
      (pickScoreFor(a.card_name, a.geomean) ?? Infinity) -
      (pickScoreFor(b.card_name, b.geomean) ?? Infinity)
  );

  const pviValues = sorted.map((card) => card.pvi).filter((pvi): pvi is number => pvi !== null);
  const pviSigma = standardDeviation(pviValues);

  const lines = [HEADERS.join(",")];

  for (const card of sorted) {
    const scry = scryfall.get(cardNameKey(card.card_name));
    const ws = winStats.get(cardNameKey(card.card_name));
    const pickScore = pickScoreFor(card.card_name, card.geomean);

    const row = [
      card.card_name,
      scry?.manaValue ?? "",
      scry?.typeLine ?? "",
      scry ? normalizeColorIdentity(scry.colorIdentity) : card.colors || "C",
      card.in_current_cube ? "Yes" : "No",
      pickScore !== null ? pickScore.toFixed(2) : "",
      ws ? `${(ws.win_rate * 100).toFixed(1)}% ±${ciMarginPct(ws.ci)}%` : "",
      ws ? ws.sample_size : "", // seats that maindecked it, not games
      card.pvi !== null ? formatSignedPvi(card.pvi) : "",
      rating(card.pvi, pviSigma),
    ];

    lines.push(row.map(csvEscape).join(","));
  }

  writeFileSync(outputPath, lines.join("\n") + "\n");

  const inCube = sorted.filter((card) => card.in_current_cube).length;
  console.log(
    `Wrote ${sorted.length} cards to ${outputPath} ` +
      `(${inCube} in the current cube, ${sorted.length - inCube} cut; ` +
      `PVI σ = ${pviSigma.toFixed(2)} over ${pviValues.length} rated cards)`
  );
}

/**
 * Scryfall metadata for every card the database knows, keyed the way the rest
 * of the codebase keys card lookups. Cards cut from the cube are still in the
 * table, so this covers the historical rows too.
 */
async function loadScryfallByCardKey(client: Client): Promise<Map<string, ScryCard>> {
  const result = await client.execute(`SELECT name, scryfall_json FROM cards`);

  const byKey = new Map<string, ScryCard>();
  for (const row of result.rows) {
    const name = row.name as string;
    const key = cardNameKey(name);
    if (byKey.has(key)) continue;
    const scry = transformScryfallJson(row.scryfall_json as string | null, name);
    if (scry) byKey.set(key, scry);
  }
  return byKey;
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
