/**
 * Leave-one-draft-out (LODO) validation of the card worth model.
 *
 * For each stats-phase draft D: refit the worth model excluding D
 * (getWorthTable({ excludeDraftId: D })), score each of D's seats as the
 * sum of the top-23 worths of its picks, and correlate seat scores with
 * final match wins (Spearman). Aggregation is the seat-weighted average of
 * per-draft rhos; significance is a WITHIN-draft permutation test (seats
 * share opponents and a game pool — cross-draft permutation would inflate
 * significance). Coverage guards and the P1 first-pick diagnostic follow
 * the spec (docs/superpowers/specs/2026-08-01-card-worth-model-design.md §7).
 *
 * This is a measurement run, not a CI gate: it always exits 0 and prints a
 * recommended pinned gate (measured pooled rho minus a margin) plus the
 * draft set it was measured on.
 *
 * Usage: pnpm worth:validate
 */

import { getClient } from "../src/core/db/client";
import { statsPhaseFilter } from "../src/core/draftPhases";
import { getStandings } from "../src/core/db/queries/picks";
import { getWorthTable } from "../src/core/db/queries/stats/worth";
import { colorFlag, overdueDanger, type WorthCard } from "../src/core/worthModel";
import { loadEnv } from "../src/core/db/ingest/utils";

/** Seats covering less than this fraction of their picks are excluded. */
const COVERAGE_MINIMUM = 0.6;

/** Deck-sized slice of a seat's picks that counts toward its score. */
const TOP_PICKS_COUNTED = 23;

/** Deterministic PRNG seed for the permutation tests (noted in output). */
const PRNG_SEED = 42;

const PERMUTATION_ITERATIONS = 2000;

/**
 * Currently pinned gate: minPooledRho 0.0616 (measured pooled rho 0.1616,
 * p=0.0170, 257 seats over 27 stats-phase drafts). Re-measured 2026-08-09
 * after privacy redaction moved to ingest time: an opted-out seat now has no
 * stored picks, so it never becomes a key in picksBySeat and drops out of the
 * sample entirely rather than scoring as a zero-worth seat with real wins.
 * The sample fell from 266 seats to 257 and rho moved 0.1755 -> 0.1616.
 *
 * That drop is well inside the noise band — roughly 0.22 standard errors at
 * n=257 (SE ~ 1/sqrt(n-1) ~ 0.0625) — so the honest reading is that removing
 * those seats did NOT degrade the model, not that it hurt it. Do not read a
 * trend into it. The 257-seat sample is the new permanent baseline: those
 * seats can never be scored again, by design.
 *
 * Re-measure and re-pin whenever the worth model's fit changes.
 */

/** Margin subtracted from the measured pooled rho for the pinned gate. */
const GATE_MARGIN = 0.1;

/** Danger horizon for the P1 diagnostic: one full snake turn at 10 seats. */
const P1_DANGER_HORIZON = 20;

/** Coverage-vs-wins |rho| above this warrants investigation (spec §7). */
const COVERAGE_WINS_WARNING_THRESHOLD = 0.15;

// ============================================================================
// Statistics helpers
// ============================================================================

/** mulberry32: tiny deterministic PRNG (Math.random is banned here). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle into a fresh array, driven by the given PRNG. */
function shuffledCopy<T>(values: T[], nextRandom: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 1-based ranks with ties assigned the average rank of their run. */
function rankWithTies(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let runStart = 0;
  while (runStart < indexed.length) {
    let runEnd = runStart;
    while (
      runEnd + 1 < indexed.length &&
      indexed[runEnd + 1].value === indexed[runStart].value
    ) {
      runEnd++;
    }
    const averageRank = (runStart + runEnd + 2) / 2;
    for (let i = runStart; i <= runEnd; i++) {
      ranks[indexed[i].index] = averageRank;
    }
    runStart = runEnd + 1;
  }
  return ranks;
}

/** Pearson correlation; null when either variable has zero variance. */
function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX <= 0 || varianceY <= 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/**
 * Spearman rho with average-rank tie handling; null when fewer than 3
 * observations or either variable is constant.
 */
function spearmanRho(xs: number[], ys: number[]): number | null {
  if (xs.length < 3 || xs.length !== ys.length) return null;
  return pearsonCorrelation(rankWithTies(xs), rankWithTies(ys));
}

interface SeatScoreGroup {
  draftId: string;
  scores: number[];
  wins: number[];
}

/**
 * The pooled within-draft rank statistic: average of per-draft Spearman
 * rhos weighted by seat count. Drafts whose rho is undefined (too few
 * seats, constant scores or wins) are excluded from the pool.
 */
function pooledWeightedRho(groups: SeatScoreGroup[]): number | null {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const group of groups) {
    const rho = spearmanRho(group.scores, group.wins);
    if (rho === null) continue;
    weightedSum += rho * group.scores.length;
    weightTotal += group.scores.length;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : null;
}

/**
 * Within-draft permutation test: shuffle scores WITHIN each draft
 * independently, recompute the pooled statistic, and report the two-sided
 * p as the fraction of iterations with |stat| >= |observed|.
 */
function withinDraftPermutationPValue(
  groups: SeatScoreGroup[],
  observedStatistic: number,
  iterations: number,
  nextRandom: () => number,
): number {
  let atLeastAsExtreme = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const shuffledGroups = groups.map((group) => ({
      draftId: group.draftId,
      scores: shuffledCopy(group.scores, nextRandom),
      wins: group.wins,
    }));
    const statistic = pooledWeightedRho(shuffledGroups);
    if (statistic !== null && Math.abs(statistic) >= Math.abs(observedStatistic)) {
      atLeastAsExtreme++;
    }
  }
  return atLeastAsExtreme / iterations;
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const position = fraction * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function formatRho(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

// ============================================================================
// Per-draft LODO evaluation
// ============================================================================

interface SeatCoverageRecord {
  draftId: string;
  seat: number;
  coverage: number;
  wins: number;
  included: boolean;
}

interface DraftEvaluation {
  draftId: string;
  scoreGroup: SeatScoreGroup;
  p1Group: SeatScoreGroup;
  coverageRecords: SeatCoverageRecord[];
  excludedSeatCount: number;
}

interface SeatPick {
  pickN: number;
  cardName: string;
}

async function evaluateDraftLodo(
  client: Awaited<ReturnType<typeof getClient>>,
  draftId: string,
): Promise<DraftEvaluation> {
  const worthTable = await getWorthTable({ excludeDraftId: draftId });

  const cardByName = new Map<string, WorthCard>();
  const worthByName = new Map<string, number>();
  for (const card of worthTable.cards) {
    cardByName.set(card.card_name, card);
    if (card.worth !== null) worthByName.set(card.card_name, card.worth);
  }

  const picksResult = await client.execute({
    sql: `SELECT pe.seat, pe.pick_n, c.name FROM pick_events pe
          JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ? ORDER BY pe.seat, pe.pick_n`,
    args: [draftId],
  });
  const picksBySeat = new Map<number, SeatPick[]>();
  for (const row of picksResult.rows) {
    const seat = row.seat as number;
    if (!picksBySeat.has(seat)) picksBySeat.set(seat, []);
    picksBySeat.get(seat)!.push({
      pickN: row.pick_n as number,
      cardName: row.name as string,
    });
  }

  const standingsResult = await getStandings(client, draftId);
  const matchWinsBySeat = new Map<number, number>();
  for (const entry of standingsResult.standings) {
    matchWinsBySeat.set(entry.seat, entry.matchWins);
  }

  const scoreGroup: SeatScoreGroup = { draftId, scores: [], wins: [] };
  const p1Group: SeatScoreGroup = { draftId, scores: [], wins: [] };
  const coverageRecords: SeatCoverageRecord[] = [];
  let excludedSeatCount = 0;

  const { sigma, pairEdges, kappa } = worthTable.model;

  for (const [seat, seatPicks] of [...picksBySeat.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    const coveredWorths = seatPicks
      .map((pick) => worthByName.get(pick.cardName))
      .filter((worth): worth is number => worth !== undefined);
    const coverage =
      seatPicks.length > 0 ? coveredWorths.length / seatPicks.length : 0;
    const wins = matchWinsBySeat.get(seat) ?? 0;
    const included = coverage >= COVERAGE_MINIMUM;

    coverageRecords.push({ draftId, seat, coverage, wins, included });

    if (included) {
      const topWorthSum = coveredWorths
        .sort((a, b) => b - a)
        .slice(0, TOP_PICKS_COUNTED)
        .reduce((sum, worth) => sum + worth, 0);
      scoreGroup.scores.push(topWorthSum);
      scoreGroup.wins.push(wins);
    } else {
      excludedSeatCount++;
    }

    // P1 diagnostic: the seat's first pick, scored with this LODO fit's
    // model params. Seats whose first pick the excluded-fit cannot price
    // (no worth or no geomean) are simply left out of the diagnostic.
    const firstPick = seatPicks[0];
    const firstPickCard = firstPick
      ? cardByName.get(firstPick.cardName)
      : undefined;
    if (
      firstPick &&
      firstPickCard &&
      firstPickCard.worth !== null &&
      firstPickCard.geomean !== null &&
      firstPickCard.geomean > 0 &&
      sigma > 0
    ) {
      const firstPickScore =
        firstPickCard.worth *
          overdueDanger(firstPick.pickN, P1_DANGER_HORIZON, firstPickCard.geomean, sigma) +
        colorFlag(firstPickCard.colors, pairEdges, { committed: "" }, kappa);
      p1Group.scores.push(firstPickScore);
      p1Group.wins.push(wins);
    }
  }

  return { draftId, scoreGroup, p1Group, coverageRecords, excludedSeatCount };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  loadEnv();
  const startedAt = Date.now();
  const client = await getClient();

  const phaseFilter = statsPhaseFilter("phase");
  const draftsResult = await client.execute({
    sql: `SELECT draft_id FROM drafts WHERE ${phaseFilter.fragment} ORDER BY draft_id`,
    args: phaseFilter.args,
  });
  const statsDraftIds = draftsResult.rows.map((row) => row.draft_id as string);

  console.log("Worth model LODO validation");
  console.log(
    `Measurement run — exit code is always 0; this is not a CI gate yet.`,
  );
  console.log(
    `PRNG: mulberry32, seed ${PRNG_SEED}; permutations: ${PERMUTATION_ITERATIONS} (within-draft)`,
  );
  console.log(`Stats-phase drafts: ${statsDraftIds.length}\n`);

  const evaluations: DraftEvaluation[] = [];
  for (let i = 0; i < statsDraftIds.length; i++) {
    const draftId = statsDraftIds[i];
    const refitStartedAt = Date.now();
    process.stdout.write(
      `[${i + 1}/${statsDraftIds.length}] LODO refit excluding ${draftId} ... `,
    );
    const evaluation = await evaluateDraftLodo(client, draftId);
    const refitSeconds = ((Date.now() - refitStartedAt) / 1000).toFixed(1);
    const includedSeats = evaluation.scoreGroup.scores.length;
    console.log(
      `done in ${refitSeconds}s (${includedSeats} seats included, ${evaluation.excludedSeatCount} excluded)`,
    );
    evaluations.push(evaluation);
  }

  // --- Main result: per-draft rhos + pooled statistic + permutation p ---
  const scoreGroups = evaluations.map((e) => e.scoreGroup);

  console.log("\nPer-draft Spearman rho (top-23 worth sum vs match wins):");
  for (const group of scoreGroups) {
    const rho = spearmanRho(group.scores, group.wins);
    const note =
      rho === null ? "  (undefined: <3 seats or a constant variable)" : "";
    console.log(
      `  ${group.draftId.padEnd(30)} n=${String(group.scores.length).padStart(2)}  rho=${formatRho(rho)}${note}`,
    );
  }

  const observedPooledRho = pooledWeightedRho(scoreGroups);
  console.log(
    `\nPooled within-draft rho (seat-weighted): ${formatRho(observedPooledRho)}`,
  );

  let mainPValue: number | null = null;
  if (observedPooledRho !== null) {
    mainPValue = withinDraftPermutationPValue(
      scoreGroups,
      observedPooledRho,
      PERMUTATION_ITERATIONS,
      mulberry32(PRNG_SEED),
    );
    console.log(
      `Permutation p (two-sided, within-draft, ${PERMUTATION_ITERATIONS} iters, seed ${PRNG_SEED}): ${mainPValue.toFixed(4)}`,
    );
  } else {
    console.log("Permutation test skipped: pooled statistic is undefined.");
  }

  // --- Coverage guards ---
  const allCoverageRecords = evaluations.flatMap((e) => e.coverageRecords);
  const coverageValues = allCoverageRecords
    .map((record) => record.coverage)
    .sort((a, b) => a - b);
  const excludedSeatTotal = evaluations.reduce(
    (sum, e) => sum + e.excludedSeatCount,
    0,
  );

  console.log("\nCoverage:");
  if (coverageValues.length > 0) {
    const meanCoverage =
      coverageValues.reduce((sum, value) => sum + value, 0) /
      coverageValues.length;
    console.log(
      `  seats: ${allCoverageRecords.length} total, ${excludedSeatTotal} excluded (coverage < ${(COVERAGE_MINIMUM * 100).toFixed(0)}%)`,
    );
    console.log(
      `  distribution: min=${coverageValues[0].toFixed(3)}  p25=${percentile(coverageValues, 0.25).toFixed(3)}  median=${percentile(coverageValues, 0.5).toFixed(3)}  p75=${percentile(coverageValues, 0.75).toFixed(3)}  max=${coverageValues[coverageValues.length - 1].toFixed(3)}  mean=${meanCoverage.toFixed(3)}`,
    );

    const coverageWinsRho = spearmanRho(
      allCoverageRecords.map((record) => record.coverage),
      allCoverageRecords.map((record) => record.wins),
    );
    console.log(
      `  coverage-vs-wins Spearman (all seats, included + excluded): rho=${formatRho(coverageWinsRho)}`,
    );
    if (
      coverageWinsRho !== null &&
      Math.abs(coverageWinsRho) > COVERAGE_WINS_WARNING_THRESHOLD
    ) {
      console.log(
        `  WARNING: |rho| > ${COVERAGE_WINS_WARNING_THRESHOLD} — coverage correlates with wins; investigate before trusting the pooled statistic (expected driver is cube rotation, not deck quality).`,
      );
    }
  } else {
    console.log("  no seats found.");
  }

  // --- P1 diagnostic (reported, not gated) ---
  const p1Groups = evaluations.map((e) => e.p1Group);
  const p1SeatTotal = p1Groups.reduce((sum, g) => sum + g.scores.length, 0);
  const observedP1Rho = pooledWeightedRho(p1Groups);

  console.log("\nP1 diagnostic (underpowered by design — reported, NOT gated):");
  console.log(
    `  first-pick score = worth x overdueDanger(pickN, ${P1_DANGER_HORIZON}, geo, sigma) + colorFlag(colors, pairEdges, uncommitted, kappa)`,
  );
  console.log(
    `  seats scored: ${p1SeatTotal}; pooled within-draft rho: ${formatRho(observedP1Rho)}`,
  );
  if (observedP1Rho !== null) {
    const p1PValue = withinDraftPermutationPValue(
      p1Groups,
      observedP1Rho,
      PERMUTATION_ITERATIONS,
      mulberry32(PRNG_SEED),
    );
    console.log(
      `  permutation p (two-sided, within-draft, ${PERMUTATION_ITERATIONS} iters, seed ${PRNG_SEED}): ${p1PValue.toFixed(4)}`,
    );
  }

  // --- Gate recommendation ---
  console.log("\nGate recommendation (pin both the gate and the draft set):");
  if (observedPooledRho !== null) {
    const recommendedGate = observedPooledRho - GATE_MARGIN;
    console.log(`  measured pooled rho: ${observedPooledRho.toFixed(4)}`);
    console.log(
      `  recommended pinned gate (measured - ${GATE_MARGIN}): ${recommendedGate.toFixed(4)}`,
    );
    console.log("  measured on draft set (paste into a future config):");
    const pinnedConfig = {
      minPooledRho: Number(recommendedGate.toFixed(4)),
      measuredPooledRho: Number(observedPooledRho.toFixed(4)),
      margin: GATE_MARGIN,
      permutationP: mainPValue,
      prngSeed: PRNG_SEED,
      permutationIterations: PERMUTATION_ITERATIONS,
      draftIds: [...statsDraftIds].sort(),
    };
    console.log(JSON.stringify(pinnedConfig, null, 2));
  } else {
    console.log(
      "  pooled rho undefined — no gate recommendation (not enough drafts with rankable seats).",
    );
  }

  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone in ${totalSeconds}s. Exit 0 (measurement run).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
