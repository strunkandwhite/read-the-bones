// src/core/db/sync/domains.ts
import { createHash } from "crypto";
import type { Client } from "@libsql/client";
import type { CardPick, MatchResult } from "../../parseSheetRows";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function hashPool(cardNames: string[]): string {
  const sorted = [...cardNames].sort();
  return sha256(sorted.join("\n"));
}

export function hashPicks(picks: CardPick[]): string {
  const sorted = [...picks].sort(
    (a, b) => a.pickPosition - b.pickPosition || a.seat - b.seat,
  );
  const lines = sorted.map((p) => `${p.pickPosition}:${p.seat}:${p.cardName}`);
  return sha256(lines.join("\n"));
}

export function hashMatches(matches: MatchResult[]): string {
  const sorted = [...matches].sort(
    (a, b) => a.seat1 - b.seat1 || a.seat2 - b.seat2,
  );
  const lines = sorted.map(
    (m) => `${m.seat1}:${m.seat2}:${m.seat1GamesWon}:${m.seat2GamesWon}`,
  );
  return sha256(lines.join("\n"));
}

export function compareDomainHash(
  newHash: string,
  storedHash: string | null,
): "skip" | "replace" {
  return newHash === storedHash ? "skip" : "replace";
}

export interface DomainHashes {
  poolHash: string | null;
  picksHash: string | null;
  matchesHash: string | null;
}

export async function getDomainHashes(
  client: Client,
  draftId: string,
): Promise<DomainHashes | null> {
  const result = await client.execute({
    sql: "SELECT pool_hash, picks_hash, matches_hash FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    poolHash: row.pool_hash as string | null,
    picksHash: row.picks_hash as string | null,
    matchesHash: row.matches_hash as string | null,
  };
}

export async function updateDomainHashes(
  client: Client,
  draftId: string,
  hashes: Partial<DomainHashes>,
): Promise<void> {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (hashes.poolHash !== undefined) {
    sets.push("pool_hash = ?");
    args.push(hashes.poolHash);
  }
  if (hashes.picksHash !== undefined) {
    sets.push("picks_hash = ?");
    args.push(hashes.picksHash);
  }
  if (hashes.matchesHash !== undefined) {
    sets.push("matches_hash = ?");
    args.push(hashes.matchesHash);
  }
  if (sets.length === 0) return;
  args.push(draftId);
  await client.execute({
    sql: `UPDATE drafts SET ${sets.join(", ")} WHERE draft_id = ?`,
    args,
  });
}
