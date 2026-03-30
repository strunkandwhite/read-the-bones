/**
 * Card play-rate statistics — how often a card is maindecked vs drafted.
 */

import { getClient } from "../client";
import { fetchOptOuts, getSeatsMatchingColors } from "./helpers";
import { resolveCard } from "./cards";
import { round3 } from "../../utils";


export interface GetCardPlayStatsParams {
  card_name: string;
  card_id?: number;
  draft_id?: string;
  exclude_draft_id?: string;
  deck_colors?: string;
  /** Pre-fetched opt-outs as "draftId:seat" pairs. When provided, skips the internal opt-outs query. */
  optedOutByDraft?: Set<string>;
}

export interface CardPlayStatsResult {
  card_name: string;
  times_drafted: number;
  times_maindecked: number;
  play_rate: number;
  drafts_with_decklists: number;
}

/**
 * Get play rate for a card: how often it's maindecked vs drafted,
 * across all drafts with decklist data.
 */
export async function getCardPlayStats(
  params: GetCardPlayStatsParams
): Promise<CardPlayStatsResult | null> {
  // Resolve the card (skip if card_id already provided)
  let card_id = params.card_id;
  let card_name = params.card_name;
  if (card_id === undefined) {
    const card = await resolveCard(params.card_name);
    if (!card) return null;
    card_id = card.card_id;
    card_name = card.name;
  }

  const client = await getClient();

  const draftFilter = params.draft_id
    ? "AND dc.draft_id = ?"
    : "";
  const excludeFilter = params.exclude_draft_id
    ? "AND dc.draft_id != ?"
    : "";
  const args: (string | number)[] = [card_id];
  if (params.draft_id) args.push(params.draft_id);
  if (params.exclude_draft_id) args.push(params.exclude_draft_id);

  const result = await client.execute({
    sql: `SELECT dc.draft_id, dc.seat, dc.zone
          FROM deck_cards dc
          WHERE dc.card_id = ? ${draftFilter} ${excludeFilter}`,
    args,
  });

  if (result.rows.length === 0) {
    return {
      card_name: card_name,
      times_drafted: 0,
      times_maindecked: 0,
      play_rate: 0,
      drafts_with_decklists: 0,
    };
  }

  // Load opt-outs for relevant drafts (skip if caller already fetched them)
  const draftIds = [...new Set(result.rows.map((r) => r.draft_id as string))];
  const optedOut = params.optedOutByDraft ?? await fetchOptOuts(client, draftIds);

  // If deck_colors filter is set, determine which seats match
  let matchingSeats: Set<string> | null = null;
  if (params.deck_colors) {
    matchingSeats = await getSeatsMatchingColors(draftIds, params.deck_colors);
  }

  const draftsWithDecklists = new Set<string>();
  let timesMaindecked = 0;
  let timesDrafted = 0;

  for (const row of result.rows) {
    const draftId = row.draft_id as string;
    const seat = row.seat as number;

    // Skip opted-out seats
    if (optedOut.has(`${draftId}:${seat}`)) continue;
    // Skip seats that don't match the color filter
    if (matchingSeats && !matchingSeats.has(`${draftId}:${seat}`)) continue;

    timesDrafted++;
    draftsWithDecklists.add(draftId);
    if ((row.zone as string) === "deck") {
      timesMaindecked++;
    }
  }

  const playRate = timesDrafted > 0 ? timesMaindecked / timesDrafted : 0;

  return {
    card_name: card_name,
    times_drafted: timesDrafted,
    times_maindecked: timesMaindecked,
    play_rate: round3(playRate),
    drafts_with_decklists: draftsWithDecklists.size,
  };
}
