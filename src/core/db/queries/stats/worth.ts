/**
 * Worth-table assembly: joins pick history, deck win data, and color
 * baselines across stats-phase drafts, fits the worth model
 * (src/core/worthModel.ts), and produces the per-card worth table.
 *
 * Model reference: docs/superpowers/specs/2026-08-01-card-worth-model-design.md
 */

import type { Client } from "@libsql/client";
import { getClient } from "../../client";
import { statsPhaseFilter } from "../../../draftPhases";
import {
  fetchOptOuts,
  inferSeatColors,
  parseScryfallJson,
  placeholders,
} from "../helpers";
import { calculatePickWeight, weightedGeometricMean } from "../../../utils";
import { DEFAULT_POOL_SIZE } from "../../../types";
import { computeIngestionHash } from "../../sync/domains";
import { normalizeColorIdentity } from "../../../manaColors";
import {
  actBy,
  estimateTau,
  estimateTauDL,
  fitPriceCurve,
  shrinkWorth,
  type WorthCard,
  type WorthModelFit,
} from "../../../worthModel";

/** Minimum games for a card to enter the fit and get a data-driven worth. */
const WORTH_MIN_GAMES = 100;

/** Commitment policy parameter κ — fixed by policy, echoed in the fit. */
const WORTH_KAPPA = 0.5;

/** Danger horizon (picks) for act_by: one full snake turn at 10 seats. */
const ACT_BY_HORIZON = 20;

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
}

// Module-level memo keyed by the ingestion hash of the stats-phase drafts'
// domain hashes — the table only changes when a draft's synced data does.
let worthCache: { key: string; result: WorthTableResult } | null = null;

/** @public Test hook: clears the module-level worth-table memo. */
export function _resetWorthCache(): void {
  worthCache = null;
}

/**
 * Compute the full worth table across all stats-phase drafts.
 *
 * `excludeDraftId` (used by leave-one-draft-out validation) drops that draft
 * from the stats set before every aggregation and fit; such calls bypass the
 * module cache entirely — they neither read nor write it.
 * @public Consumed by the /api/cards/worth route (task A3).
 */
export async function getWorthTable(opts?: {
  excludeDraftId?: string;
}): Promise<WorthTableResult> {
  const client = await getClient();

  const phaseFilter = statsPhaseFilter("phase");
  const draftsResult = await client.execute({
    sql: `SELECT draft_id, cube_snapshot_id, pool_hash, picks_hash, matches_hash
          FROM drafts WHERE ${phaseFilter.fragment} ORDER BY draft_id`,
    args: phaseFilter.args,
  });

  const bypassCache = opts?.excludeDraftId !== undefined;
  const cacheKey = computeIngestionHash(
    draftsResult.rows as unknown as Array<{
      pool_hash: unknown;
      picks_hash: unknown;
      matches_hash: unknown;
    }>,
  );
  if (!bypassCache && worthCache?.key === cacheKey) {
    return worthCache.result;
  }

  const statsDrafts: StatsDraftRef[] = draftsResult.rows
    .map((row) => ({
      draftId: row.draft_id as string,
      cubeSnapshotId: row.cube_snapshot_id as number,
    }))
    .filter((draft) => draft.draftId !== opts?.excludeDraftId);

  const result = await assembleWorthTable(client, statsDrafts);
  if (!bypassCache) {
    worthCache = { key: cacheKey, result };
  }
  return result;
}

/**
 * Land test on the FRONT face's supertype/type segment only. DFC type lines
 * join faces with " // "; a card that is a spell on the front and a land on
 * the back (MDFC) is drafted and priced as the spell, so only the front face
 * decides land-ness. Matching the whole-word "Land" before the em-dash also
 * avoids false positives from subtype text (e.g. "Island" contains "land").
 */
function isFrontFaceLand(typeLine: string | undefined): boolean {
  if (!typeLine) return false;
  const frontFace = typeLine.split(" // ")[0];
  const typesBeforeDash = frontFace.split("—")[0];
  return typesBeforeDash.split(/\s+/).includes("Land");
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function binomialStandardError(winRate: number, games: number): number {
  return Math.sqrt((winRate * (1 - winRate)) / games);
}

async function assembleWorthTable(
  client: Client,
  statsDrafts: StatsDraftRef[],
): Promise<WorthTableResult> {
  const statsDraftIds = statsDrafts.map((draft) => draft.draftId);

  // "Current cube" = the cube snapshot of the most recent draft by date,
  // regardless of phase — a drafting pod is exactly the live market that
  // act_by models. Deliberately not affected by excludeDraftId: cube
  // membership is not a fit input.
  const latestDraftResult = await client.execute({
    sql: `SELECT cube_snapshot_id FROM drafts ORDER BY draft_date DESC, draft_id DESC LIMIT 1`,
    args: [],
  });
  const currentCubeSnapshotId =
    latestDraftResult.rows.length > 0
      ? (latestDraftResult.rows[0].cube_snapshot_id as number)
      : null;

  const snapshotIds = new Set<number>(
    statsDrafts.map((draft) => draft.cubeSnapshotId),
  );
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
  const [picksResult, winsResult, matchesResult, optedOut, seatColors] =
    await Promise.all([
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
        ? fetchOptOuts(client, statsDraftIds)
        : Promise.resolve(new Set<string>()),
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
        isLand: isFrontFaceLand(scryfall?.type_line),
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
      (poolSizeBySnapshot.get(snapshotId) ?? 0) + (row.qty as number),
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

  // Win totals per name, honoring privacy opt-outs.
  const winsByName = new Map<string, { wins: number; losses: number }>();
  for (const row of winsResult.rows) {
    const name = cardIdToName.get(row.card_id as number);
    if (name === undefined) continue;
    if (optedOut.has(`${row.draft_id}:${row.seat}`)) continue;
    if (!winsByName.has(name)) winsByName.set(name, { wins: 0, losses: 0 });
    const totals = winsByName.get(name)!;
    totals.wins += Number(row.game_wins);
    totals.losses += Number(row.game_losses);
  }

  // Color baselines and pair records from inferred seat colors. A seat's
  // games count toward every color in its inferred identity. Opt-outs are
  // not applied here, matching the getDraftStats color-WR precedent:
  // these are pod-level aggregates that identify no individual seat.
  const colorTallies = new Map<string, { wins: number; losses: number }>();
  const pairTallies = new Map<string, { wins: number; losses: number }>();
  const tallySeat = (
    draftId: string,
    seat: number,
    wins: number,
    losses: number,
  ) => {
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

  // Per-card pick aggregates. Geomean uses the unpicked-penalty convention:
  // in a draft where the card sat in the pool unpicked, it contributes one
  // half-weight observation at the pool size (mirrors rankedAvailable.ts).
  const tableNames = new Set<string>(currentCubeNames);
  for (const draft of statsDrafts) {
    for (const name of snapshotCardNames.get(draft.cubeSnapshotId) ?? []) {
      tableNames.add(name);
    }
  }

  const geomeanByName = new Map<string, number | null>();
  for (const name of tableNames) {
    const byDraft = picksByName.get(name);
    const weightedItems: { value: number; weight: number }[] = [];
    for (const draft of statsDrafts) {
      const inPool = snapshotCardNames
        .get(draft.cubeSnapshotId)
        ?.has(name);
      if (!inPool) continue;
      const draftPicks = byDraft?.get(draft.draftId);
      if (draftPicks && draftPicks.length > 0) {
        for (let copyIndex = 0; copyIndex < draftPicks.length; copyIndex++) {
          weightedItems.push({
            value: draftPicks[copyIndex],
            weight: calculatePickWeight({
              copyNumber: copyIndex + 1,
              wasPicked: true,
            }),
          });
        }
      } else {
        weightedItems.push({
          value: poolSizeBySnapshot.get(draft.cubeSnapshotId) || DEFAULT_POOL_SIZE,
          weight: calculatePickWeight({ copyNumber: 1, wasPicked: false }),
        });
      }
    }
    geomeanByName.set(
      name,
      weightedItems.length > 0
        ? roundToTenth(weightedGeometricMean(weightedItems))
        : null,
    );
  }

  // Pooled σ: sd of ln(pickPosition) − ln(geomean of that card's picked
  // positions), over all picked events of non-land cards. Residuals are
  // centered per card, so the pooled sd is sqrt(mean of squared residuals).
  let residualSquaredSum = 0;
  let residualCount = 0;
  for (const [name, byDraft] of picksByName) {
    if (cardMeta.get(name)?.isLand) continue;
    const allPicks = [...byDraft.values()].flat();
    if (allPicks.length === 0) continue;
    const meanLogPick =
      allPicks.reduce((sum, pick) => sum + Math.log(pick), 0) / allPicks.length;
    for (const pick of allPicks) {
      const residual = Math.log(pick) - meanLogPick;
      residualSquaredSum += residual * residual;
      residualCount++;
    }
  }
  const sigma = residualCount > 0 ? Math.sqrt(residualSquaredSum / residualCount) : 0;

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
    })),
  );

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
      worth = shrinkWorth(delta!, expected!, tau, se!).worth;
    }

    const actByPick =
      inCurrentCube && priced && sigma > 0
        ? actBy(geomean, ACT_BY_HORIZON, sigma)
        : null;

    cards.push({
      card_name: name,
      colors: meta.colors,
      is_land: meta.isLand,
      in_current_cube: inCurrentCube,
      geomean,
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
