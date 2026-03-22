// src/core/db/sync/card-cache.ts
import type { Client } from "@libsql/client";

interface PendingCard {
  oracleId: string;
  name: string;
  scryfallJson: string | null;
}

/**
 * Cross-draft card resolution cache.
 * Bulk-loads all existing cards from Turso at startup,
 * then batch-inserts new cards discovered during sync.
 */
export class CardCache {
  private nameToId = new Map<string, number>();
  private missing: PendingCard[] = [];

  /** Bulk-load all existing cards from the database. */
  async loadAll(client: Client): Promise<void> {
    const result = await client.execute({ sql: "SELECT card_id, name FROM cards", args: [] });
    for (const row of result.rows) {
      this.nameToId.set((row.name as string).toLowerCase(), row.card_id as number);
    }
  }

  /** Look up a card_id by name (case-insensitive). */
  get(cardName: string): number | undefined {
    return this.nameToId.get(cardName.toLowerCase());
  }

  /** Manually set a card_id for a name. */
  set(cardName: string, cardId: number): void {
    this.nameToId.set(cardName.toLowerCase(), cardId);
  }

  /** Mark a card as missing (needs to be inserted). No-op if already known. */
  markMissing(name: string, oracleId: string, scryfallJson: string | null): void {
    if (!this.nameToId.has(name.toLowerCase())) {
      this.missing.push({ oracleId, name, scryfallJson });
    }
  }

  /** Batch-insert all missing cards and update the cache with their new IDs. */
  async flushMissing(client: Client): Promise<void> {
    if (this.missing.length === 0) return;

    // Insert all missing cards in a batch, using INSERT OR IGNORE for safety
    // (handles race conditions where another process inserted the same card)
    const statements = this.missing.map((c) => ({
      sql: "INSERT OR IGNORE INTO cards (oracle_id, name, scryfall_json) VALUES (?, ?, ?)",
      args: [c.oracleId, c.name, c.scryfallJson] as (string | null)[],
    }));
    await client.batch(statements);

    // Re-query to get card_ids for the newly inserted cards
    for (const card of this.missing) {
      const result = await client.execute({
        sql: "SELECT card_id FROM cards WHERE name = ?",
        args: [card.name],
      });
      if (result.rows.length > 0) {
        this.nameToId.set(card.name.toLowerCase(), result.rows[0].card_id as number);
      }
    }

    this.missing = [];
  }

  /** Number of cards in the cache. */
  get size(): number {
    return this.nameToId.size;
  }
}
