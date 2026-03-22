// src/core/db/sync/batch.ts
import type { Client } from "@libsql/client";

export interface PickInsert {
  draftId: string;
  pickN: number;
  seat: number;
  cardId: number;
}

export interface MatchInsert {
  draftId: string;
  seat1: number;
  seat2: number;
  seat1GamesWon: number;
  seat2GamesWon: number;
}

export interface DeckCardInsert {
  draftId: string;
  seat: number;
  cardId: number;
  zone: "deck" | "sideboard";
  qty: number;
}

export async function batchInsertPicks(client: Client, picks: PickInsert[]): Promise<void> {
  if (picks.length === 0) return;
  await client.batch(
    picks.map((p) => ({
      sql: "INSERT INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)",
      args: [p.draftId, p.pickN, p.seat, p.cardId],
    })),
  );
}

export async function batchInsertMatches(client: Client, matches: MatchInsert[]): Promise<void> {
  if (matches.length === 0) return;
  await client.batch(
    matches.map((m) => ({
      sql: "INSERT INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins) VALUES (?, ?, ?, ?, ?)",
      args: [m.draftId, m.seat1, m.seat2, m.seat1GamesWon, m.seat2GamesWon],
    })),
  );
}

export async function batchInsertDeckCards(client: Client, cards: DeckCardInsert[]): Promise<void> {
  if (cards.length === 0) return;
  await client.batch(
    cards.map((c) => ({
      sql: "INSERT INTO deck_cards (draft_id, seat, card_id, zone, qty) VALUES (?, ?, ?, ?, ?)",
      args: [c.draftId, c.seat, c.cardId, c.zone, c.qty],
    })),
  );
}

export async function batchInsertCubeSnapshotCards(
  client: Client,
  snapshotId: number,
  cardEntries: Array<{ cardId: number; qty: number }>,
): Promise<void> {
  if (cardEntries.length === 0) return;
  await client.batch(
    cardEntries.map((c) => ({
      sql: "INSERT INTO cube_snapshot_cards (cube_snapshot_id, card_id, qty) VALUES (?, ?, ?)",
      args: [snapshotId, c.cardId, c.qty],
    })),
  );
}

export async function deleteDomainData(
  client: Client,
  draftId: string,
  domain: "picks" | "matches" | "decklists",
): Promise<void> {
  const table = {
    picks: "pick_events",
    matches: "match_events",
    decklists: "deck_cards",
  }[domain];
  await client.execute({ sql: `DELETE FROM ${table} WHERE draft_id = ?`, args: [draftId] });
  if (domain === "decklists") {
    await client.execute({ sql: "DELETE FROM deck_hashes WHERE draft_id = ?", args: [draftId] });
  }
}
