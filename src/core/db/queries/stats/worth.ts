/**
 * Worth-table assembly: joins pick history, deck win data, and color
 * baselines across stats-phase drafts, fits the worth model
 * (src/core/worthModel.ts), and produces the per-card worth table.
 *
 * Model reference: docs/superpowers/specs/2026-08-01-card-worth-model-design.md
 * (worth redefined to the zero-prior quality estimate:
 * docs/superpowers/specs/2026-08-02-desire-metric-design.md)
 */

import type { Client } from "@libsql/client";
import { getClient } from "../../client";
import { statsPhaseFilter } from "../../../draftPhases";
import { inferSeatColors, parseScryfallJson, placeholders } from "../helpers";
import { pickScore, type DraftObservation } from "../../../pickScore";
import { sessionsAgoByDraft } from "../../../draftSessions";
import { DEFAULT_POOL_SIZE } from "../../../types";
import { computeIngestionHash } from "../../sync/domains";
import { normalizeColorIdentity } from "../../../manaColors";
import { isFrontFaceLand } from "../../../cardTypes";
import {
  actBy,
  estimateTau,
  estimateTauDL,
  fitPriceCurve,
  shrinkQuality,
  type WorthCard,
  type WorthModelFit,
} from "../../../worthModel";

/** Minimum games for a card to enter the fit and get a data-driven worth. */
const WORTH_MIN_GAMES = 100;

/** Commitment policy parameter κ — fixed by policy, echoed in the fit. */
const WORTH_KAPPA = 0.5;

/** Danger horizon (picks) for act_by: one full snake turn at 10 seats. */
const DEFAULT_ACT_BY_HORIZON = 20;

/** @public Consumed by the /api/cards/worth route (task A3). */
export interface WorthTableResult {
  cards: WorthCard[];
  model: WorthModelFit;
  computedAt: string;
  cardsFit: number;
}

interface StatsDraftRef {
  draftId: string;
  cubeSnapshotId: number;
  draftDate: string;
  sessionsAgo: number;
}

// Module-level memo keyed by the ingestion hash of the stats-phase drafts'
// domain hashes — the table only changes when a draft's synced data does.
let worthCache: { key: string; result: WorthTableResult } | null = null;
let worthPending: { key: string; promise: Promise<WorthTableResult> } | null = null;

/** @public Test hook: clears the module-level worth-table memo. */
export function _resetWorthCache(): void {
  worthCache = null;
  worthPending = null;
}

/**
 * Compute the full worth table across all stats-phase drafts.
 *
 * `excludeDraftId` (used by leave-one-draft-out validation) drops that draft
 * from the stats set before every aggregation and fit; such calls bypass the
 * module cache entirely — they neither read nor write it.
 * @public Consumed by the /api/cards/worth route (task A3).
 */
export async function getWorthTable(opts?: { excludeDraftId?: string }): Promise<WorthTableResult> {
  const client = await getClient();

  const phaseFilter = statsPhaseFilter("phase");
  const draftsResult = await client.execute({
    sql: `SELECT draft_id, cube_snapshot_id, draft_date, pool_hash, picks_hash, matches_hash
          FROM drafts WHERE ${phaseFilter.fragment} ORDER BY draft_id`,
    args: phaseFilter.args,
  });

  const bypassCache = opts?.excludeDraftId !== undefined;
  // The current cube (in_current_cube, act_by, pair supply inputs) comes from
  // the latest draft by date in ANY phase, so a freshly created live draft
  // must invalidate the cache even though no stats-phase hash changed.
  const latestResult = await client.execute({
    sql: `SELECT draft_id, cube_snapshot_id, num_seats
          FROM drafts ORDER BY draft_date DESC, draft_id DESC LIMIT 1`,
    args: [],
  });
  const latestRow = latestResult.rows[0];
  const latestFingerprint = latestRow
    ? `${latestRow.draft_id}:${latestRow.cube_snapshot_id}:${latestRow.num_seats}`
    : "none";
  // Session ordinals (sessionsAgo) are derived from draft_date, but
  // computeIngestionHash only covers the pool/picks/matches domain hashes —
  // correcting a draft's date with no other data change would otherwise
  // serve a stale cache with wrong ordinals. draftsResult.rows is already
  // ORDER BY draft_id, so this join is a deterministic, cheap stand-in for a
  // real hash.
  const datesFingerprint = draftsResult.rows
    .map((row) => `${row.draft_id}:${row.draft_date}`)
    .join(",");
  const cacheKey = `${computeIngestionHash(
    draftsResult.rows as unknown as Array<{
      pool_hash: unknown;
      picks_hash: unknown;
      matches_hash: unknown;
    }>
  )}|${latestFingerprint}|${datesFingerprint}`;
  if (!bypassCache && worthCache?.key === cacheKey) {
    return worthCache.result;
  }
  if (!bypassCache && worthPending?.key === cacheKey) {
    return worthPending.promise;
  }

  const allStatsDrafts = draftsResult.rows.map((row) => ({
    draftId: row.draft_id as string,
    cubeSnapshotId: row.cube_snapshot_id as number,
    draftDate: row.draft_date as string,
  }));

  // Ordinals come from the full set so a leave-one-out fold that removes the
  // only pod of a session does not renumber every older session.
  const sessionsAgo = sessionsAgoByDraft(allStatsDrafts);

  const statsDrafts: StatsDraftRef[] = allStatsDrafts
    .map((draft) => ({ ...draft, sessionsAgo: sessionsAgo.get(draft.draftId)! }))
    .filter((draft) => draft.draftId !== opts?.excludeDraftId);

  const assembly = assembleWorthTable(client, statsDrafts);
  if (!bypassCache) {
    // Share one in-flight assembly between concurrent cold callers (UI fetch
    // and MCP tool typically race on dev-server start).
    worthPending = { key: cacheKey, promise: assembly };
    try {
      const result = await assembly;
      worthCache = { key: cacheKey, result };
      return result;
    } finally {
      worthPending = null;
    }
  }
  return assembly;
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function binomialStandardError(winRate: number, games: number): number {
  return Math.sqrt((winRate * (1 - winRate)) / games);
}

async function assembleWorthTable(
  client: Client,
  statsDrafts: StatsDraftRef[]
): Promise<WorthTableResult> {
  const statsDraftIds = statsDrafts.map((draft) => draft.draftId);

  // "Current cube" = the cube snapshot of the most recent draft by date,
  // regardless of phase — a drafting pod is exactly the live market that
  // act_by models. Deliberately not affected by excludeDraftId: cube
  // membership is not a fit input.
  const latestDraftResult = await client.execute({
    sql: `SELECT cube_snapshot_id, num_seats FROM drafts ORDER BY draft_date DESC, draft_id DESC LIMIT 1`,
    args: [],
  });
  const currentCubeSnapshotId =
    latestDraftResult.rows.length > 0
      ? (latestDraftResult.rows[0].cube_snapshot_id as number)
      : null;
  // act_by's "gone within your next h picks" horizon is one snake turn of the
  // live pod, not a hardcoded ten-seat assumption.
  const actByHorizon =
    latestDraftResult.rows.length > 0
      ? 2 * (latestDraftResult.rows[0].num_seats as number)
      : DEFAULT_ACT_BY_HORIZON;

  const snapshotIds = new Set<number>(statsDrafts.map((draft) => draft.cubeSnapshotId));
  if (currentCubeSnapshotId !== null) snapshotIds.add(currentCubeSnapshotId);

  const snapshotIdList = [...snapshotIds];
  const [cubeCardsResult, cardsResult] = await Promise.all([
    snapshotIdList.length > 0
      ? client.execute({
          sql: `SELECT cube_snapshot_id, card_id, qty FROM cube_snapshot_cards
                WHERE cube_snapshot_id IN (${placeholders(snapshotIdList.length)})`,
          args: snapshotIdList,
        })
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    client.execute({
      sql: `SELECT card_id, name, scryfall_json FROM cards`,
      args: [],
    }),
  ]);

  const hasStatsDrafts = statsDraftIds.length > 0;
  const draftIdPlaceholders = placeholders(statsDraftIds.length);
  const [picksResult, winsResult, matchesResult, seatColors] = await Promise.all([
    hasStatsDrafts
      ? client.execute({
          sql: `SELECT draft_id, card_id, pick_n FROM pick_events
                  WHERE draft_id IN (${draftIdPlaceholders})
                  ORDER BY draft_id, pick_n`,
          args: statsDraftIds,
        })
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    hasStatsDrafts
      ? client.execute({
          sql: `SELECT dc.card_id, dc.draft_id, dc.seat,
                    SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat1_wins
                             WHEN me.seat2 = dc.seat THEN me.seat2_wins
                             ELSE 0 END) AS game_wins,
                    SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat2_wins
                             WHEN me.seat2 = dc.seat THEN me.seat1_wins
                             ELSE 0 END) AS game_losses
                  FROM deck_cards dc
                  JOIN match_events me ON me.draft_id = dc.draft_id
                    AND (me.seat1 = dc.seat OR me.seat2 = dc.seat)
                  WHERE dc.zone = 'deck' AND dc.draft_id IN (${draftIdPlaceholders})
                  GROUP BY dc.card_id, dc.draft_id, dc.seat`,
          args: statsDraftIds,
        })
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    hasStatsDrafts
      ? client.execute({
          sql: `SELECT draft_id, seat1, seat2, seat1_wins, seat2_wins
                  FROM match_events WHERE draft_id IN (${draftIdPlaceholders})`,
          args: statsDraftIds,
        })
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    hasStatsDrafts
      ? inferSeatColors(client, statsDraftIds)
      : Promise.resolve(new Map<string, string>()),
  ]);

  // Card metadata keyed by normalized name (names in the cards table are
  // already suffix-stripped at ingestion, so name is the multi-copy key).
  const cardIdToName = new Map<number, string>();
  const cardMeta = new Map<string, { colors: string; isLand: boolean }>();
  for (const row of cardsResult.rows) {
    const name = row.name as string;
    cardIdToName.set(row.card_id as number, name);
    if (!cardMeta.has(name)) {
      const scryfall = parseScryfallJson(row.scryfall_json as string | null);
      const normalized = normalizeColorIdentity(scryfall?.color_identity ?? []);
      cardMeta.set(name, {
        // WorthCard uses "" for colorless where normalizeColorIdentity uses "C".
        colors: normalized === "C" ? "" : normalized,
        isLand: isFrontFaceLand(scryfall?.type_line ?? ""),
      });
    }
  }

  // Pool membership + pool sizes per snapshot.
  const snapshotCardNames = new Map<number, Set<string>>();
  const poolSizeBySnapshot = new Map<number, number>();
  for (const row of cubeCardsResult.rows) {
    const snapshotId = row.cube_snapshot_id as number;
    const name = cardIdToName.get(row.card_id as number);
    if (name === undefined) continue;
    if (!snapshotCardNames.has(snapshotId)) {
      snapshotCardNames.set(snapshotId, new Set());
    }
    snapshotCardNames.get(snapshotId)!.add(name);
    poolSizeBySnapshot.set(
      snapshotId,
      (poolSizeBySnapshot.get(snapshotId) ?? 0) + (row.qty as number)
    );
  }

  const currentCubeNames =
    currentCubeSnapshotId !== null
      ? (snapshotCardNames.get(currentCubeSnapshotId) ?? new Set<string>())
      : new Set<string>();

  // name -> draftId -> pick positions (ascending, from the ORDER BY).
  const picksByName = new Map<string, Map<string, number[]>>();
  for (const row of picksResult.rows) {
    const name = cardIdToName.get(row.card_id as number);
    if (name === undefined) continue;
    const draftId = row.draft_id as string;
    if (!picksByName.has(name)) picksByName.set(name, new Map());
    const byDraft = picksByName.get(name)!;
    if (!byDraft.has(draftId)) byDraft.set(draftId, []);
    byDraft.get(draftId)!.push(row.pick_n as number);
  }

  // Win totals per name.
  const winsByName = new Map<string, { wins: number; losses: number }>();
  for (const row of winsResult.rows) {
    const name = cardIdToName.get(row.card_id as number);
    if (name === undefined) continue;
    if (!winsByName.has(name)) winsByName.set(name, { wins: 0, losses: 0 });
    const totals = winsByName.get(name)!;
    totals.wins += Number(row.game_wins);
    totals.losses += Number(row.game_losses);
  }

  // Color baselines and pair records from inferred seat colors. A seat's
  // games count toward every color in its inferred identity.
  const colorTallies = new Map<string, { wins: number; losses: number }>();
  const pairTallies = new Map<string, { wins: number; losses: number }>();
  const tallySeat = (draftId: string, seat: number, wins: number, losses: number) => {
    const seatColor = seatColors.get(`${draftId}:${seat}`);
    if (!seatColor || seatColor === "C") return;
    for (const colorLetter of seatColor) {
      if (!colorTallies.has(colorLetter)) {
        colorTallies.set(colorLetter, { wins: 0, losses: 0 });
      }
      const tally = colorTallies.get(colorLetter)!;
      tally.wins += wins;
      tally.losses += losses;
    }
    if (seatColor.length === 2) {
      if (!pairTallies.has(seatColor)) {
        pairTallies.set(seatColor, { wins: 0, losses: 0 });
      }
      const tally = pairTallies.get(seatColor)!;
      tally.wins += wins;
      tally.losses += losses;
    }
  };
  for (const row of matchesResult.rows) {
    const draftId = row.draft_id as string;
    const seat1Wins = Number(row.seat1_wins);
    const seat2Wins = Number(row.seat2_wins);
    tallySeat(draftId, Number(row.seat1), seat1Wins, seat2Wins);
    tallySeat(draftId, Number(row.seat2), seat2Wins, seat1Wins);
  }

  const baselines: Record<string, number> = {};
  for (const [colorLetter, { wins, losses }] of colorTallies) {
    if (wins + losses > 0) baselines[colorLetter] = wins / (wins + losses);
  }

  // Pair edges: DL-shrunk pair win rates, centered on 0.5 (spec §7).
  // Pairs with a zero-count side have se = 0, which the DL weights (1/se²)
  // cannot take — such degenerate pairs are dropped from the estimate.
  const pairItems: { pair: string; delta: number; se: number }[] = [];
  for (const [pair, { wins, losses }] of pairTallies) {
    if (wins === 0 || losses === 0) continue;
    const games = wins + losses;
    const winRate = wins / games;
    pairItems.push({ pair, delta: winRate, se: binomialStandardError(winRate, games) });
  }
  const { tauA, grandMean } = estimateTauDL(pairItems);
  const pairEdges: Record<string, number> = {};
  for (const { pair, delta, se } of pairItems) {
    const shrinkFactor = (tauA * tauA) / (tauA * tauA + se * se);
    pairEdges[pair] = shrinkFactor * (delta - grandMean) + grandMean - 0.5;
  }

  // Per-card pick aggregates. A draft in which the card sat in the pool
  // untaken contributes one half-weight observation at the pool size.
  const tableNames = new Set<string>(currentCubeNames);
  for (const draft of statsDrafts) {
    for (const name of snapshotCardNames.get(draft.cubeSnapshotId) ?? []) {
      tableNames.add(name);
    }
  }

  const geomeanByName = new Map<string, number | null>();
  for (const name of tableNames) {
    const byDraft = picksByName.get(name);
    const observations: DraftObservation[] = [];
    for (const draft of statsDrafts) {
      if (!snapshotCardNames.get(draft.cubeSnapshotId)?.has(name)) continue;
      observations.push({
        sessionsAgo: draft.sessionsAgo,
        pickPositions: byDraft?.get(draft.draftId) ?? [],
        poolSize: poolSizeBySnapshot.get(draft.cubeSnapshotId) || DEFAULT_POOL_SIZE,
      });
    }
    geomeanByName.set(name, observations.length > 0 ? pickScore(observations) : null);
  }

  // Pooled σ: sd of ln(pickPosition) − ln(geomean of that card's picked
  // positions), over all picked events of non-land cards. Centering per card
  // consumes one degree of freedom per card, so the unbiased pooled estimator
  // divides by (events − cards); a card picked once contributes a guaranteed
  // zero residual and zero degrees of freedom, dropping out naturally.
  let residualSquaredSum = 0;
  let residualCount = 0;
  let centeredCardCount = 0;
  for (const [name, byDraft] of picksByName) {
    if (cardMeta.get(name)?.isLand) continue;
    const allPicks = [...byDraft.values()].flat();
    if (allPicks.length === 0) continue;
    centeredCardCount++;
    const meanLogPick = allPicks.reduce((sum, pick) => sum + Math.log(pick), 0) / allPicks.length;
    for (const pick of allPicks) {
      const residual = Math.log(pick) - meanLogPick;
      residualSquaredSum += residual * residual;
      residualCount++;
    }
  }
  const sigmaDegreesOfFreedom = residualCount - centeredCardCount;
  const sigma =
    sigmaDegreesOfFreedom > 0 ? Math.sqrt(residualSquaredSum / sigmaDegreesOfFreedom) : 0;

  const baselineMeanFor = (colors: string): number => {
    if (colors === "") return 0.5;
    let sum = 0;
    for (const colorLetter of colors) {
      sum += baselines[colorLetter] ?? 0.5;
    }
    return sum / colors.length;
  };

  // Price curve + τ over eligible cards: enough games, non-land, priced
  // (geomean present), and se > 0 (fitPriceCurve's precondition).
  const fitPoints: { lnGeo: number; delta: number; se: number }[] = [];
  for (const name of tableNames) {
    const meta = cardMeta.get(name);
    const geomean = geomeanByName.get(name) ?? null;
    const totals = winsByName.get(name);
    if (!meta || meta.isLand || geomean === null || geomean <= 0 || !totals) {
      continue;
    }
    const games = totals.wins + totals.losses;
    if (games < WORTH_MIN_GAMES) continue;
    const winRate = totals.wins / games;
    const se = binomialStandardError(winRate, games);
    if (se <= 0) continue;
    fitPoints.push({
      lnGeo: Math.log(geomean),
      delta: winRate - baselineMeanFor(meta.colors),
      se,
    });
  }
  const { a, b } = fitPriceCurve(fitPoints);
  const tau = estimateTau(
    fitPoints.map(({ lnGeo, delta, se }) => ({
      resid: delta - (a + b * lnGeo),
      se,
    }))
  );
  // Quality spread around the ZERO prior (raw deltas, not curve residuals):
  // worth shrinks toward zero, so its weight must use total spread or the
  // shrinkage understates true quality variance.
  const tau0 = estimateTau(fitPoints.map(({ delta, se }) => ({ resid: delta, se })));

  const cards: WorthCard[] = [];
  for (const name of [...tableNames].sort()) {
    const meta = cardMeta.get(name) ?? { colors: "", isLand: false };
    const geomean = geomeanByName.get(name) ?? null;
    const totals = winsByName.get(name) ?? { wins: 0, losses: 0 };
    const games = totals.wins + totals.losses;
    const winRate = games > 0 ? totals.wins / games : null;
    const se = winRate !== null ? binomialStandardError(winRate, games) : null;
    const delta = winRate !== null ? winRate - baselineMeanFor(meta.colors) : null;
    const priced = geomean !== null && geomean > 0;
    const expected = priced ? a + b * Math.log(geomean) : null;
    const inCurrentCube = currentCubeNames.has(name);

    const noData = !priced;
    const priorOnly = priced && games < WORTH_MIN_GAMES;

    let pvi: number | null = null;
    let worth: number | null = null;
    if (priorOnly) {
      worth = expected;
    } else if (!noData) {
      // Full state: games ≥ WORTH_MIN_GAMES guarantees delta/se/expected.
      // se = 0 (all-win or all-loss record) leaves pvi undefined; shrinkage
      // then puts full weight on the observation, which is the se→0 limit.
      pvi = se !== null && se > 0 ? (delta! - expected!) / se : null;
      worth = shrinkQuality(delta!, tau0, se!).worth;
    }

    const actByPick =
      inCurrentCube && priced && sigma > 0 ? actBy(geomean, actByHorizon, sigma) : null;

    cards.push({
      card_name: name,
      colors: meta.colors,
      is_land: meta.isLand,
      in_current_cube: inCurrentCube,
      geomean: geomean !== null ? roundToTenth(geomean) : null,
      games,
      wins: totals.wins,
      losses: totals.losses,
      wr: winRate,
      se,
      delta,
      expected,
      pvi,
      worth,
      prior_only: priorOnly,
      no_data: noData,
      act_by: actByPick,
    });
  }

  const model: WorthModelFit = {
    a,
    b,
    tau,
    tau0,
    sigma,
    tauA,
    grandMean,
    kappa: WORTH_KAPPA,
    baselines,
    pairEdges,
  };

  return {
    cards,
    model,
    computedAt: new Date().toISOString(),
    cardsFit: fitPoints.length,
  };
}
