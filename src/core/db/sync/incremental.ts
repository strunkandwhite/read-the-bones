/**
 * Incremental pick reconciliation for active Sheets-based drafts.
 *
 * Used exclusively by the serverless cron path (GET /api/sync → syncActiveDraft).
 * The CLI path (scripts/sync.ts → syncAll → syncDraft) does full-domain hash-replace
 * and does NOT go through this module — it owns the complete pool/picks/matches pipeline.
 *
 * Reconciliation = insert positions the DB is missing + update positions whose
 * card changed in the sheet (post-hoc edits). Removed/renumbered positions are
 * a divergence the cron refuses to touch — those need a CLI full sync.
 */

import type { Client } from "@libsql/client";
import type { CardPick } from "../../types";
import type { ParsedPicks } from "../../parseSheetRows";
import { normalizeCardName, getFrontFace } from "../../cardNames";
import { fetchCard, fetchCardFuzzy } from "../../scryfallApi";
import { sleep } from "../../utils";
import { placeholders } from "../queries/helpers";
import { hashPicks, updateDomainHashes } from "./domains";

/**
 * Given all picks parsed from CSV and the set of pick positions already in the
 * database, return only the new picks that need to be inserted.
 *
 * Compares full position sets rather than a high-water mark: a drafter who
 * back-fills a skipped pick in the sheet after later picks have synced leaves
 * a gap below the max, and those picks must still be inserted.
 */
export function detectNewPicks(
  allPicks: CardPick[],
  dbPositions: ReadonlySet<number>,
): CardPick[] {
  return allPicks.filter((pick) => !dbPositions.has(pick.pickPosition));
}

/** A stored pick row, keyed by pick position in getDbPicks' result. */
interface DbPick {
  seat: number;
  cardId: number;
  cardName: string;
}

/**
 * Load all stored picks for a draft, keyed by pick position, including the
 * canonical card name so reconciliation can compare against sheet names
 * without resolving every position.
 */
export async function getDbPicks(
  client: Client,
  draftId: string,
): Promise<Map<number, DbPick>> {
  const result = await client.execute({
    sql: `SELECT pe.pick_n, pe.seat, pe.card_id, c.name
          FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ?`,
    args: [draftId],
  });
  return new Map(
    result.rows.map((row) => [
      row.pick_n as number,
      {
        seat: row.seat as number,
        cardId: row.card_id as number,
        cardName: row.name as string,
      },
    ]),
  );
}

/**
 * DB positions that no longer exist in the sheet. Non-empty means picks were
 * removed or renumbered — a destructive change the incremental path must not
 * attempt; a CLI full sync (pnpm sync <draft-id>) is required.
 */
export function detectRemovedPicks(
  csvPositions: ReadonlySet<number>,
  dbPositions: Iterable<number>,
): number[] {
  return [...dbPositions].filter((n) => !csvPositions.has(n));
}

/**
 * Cheap name equivalence between a sheet pick and a stored canonical name:
 * exact (case-insensitive), or either face of a stored "Front // Back" DFC.
 * Anything else is a change *candidate* — applyChangedPicks resolves it
 * properly before touching the row, so alias spellings are not false updates.
 */
function namesMatch(sheetName: string, dbName: string): boolean {
  const s = sheetName.toLowerCase();
  const d = dbName.toLowerCase();
  return d === s || d.startsWith(`${s} // `) || d.endsWith(` // ${s}`);
}

interface PickChange {
  pick: CardPick;
  dbCardId: number;
  dbSeat: number;
}

/**
 * Positions present in both the sheet and the DB whose card or seat differ.
 * This is how a post-hoc sheet edit (e.g. correcting a duplicate pick) is
 * detected — the old insert-only path was blind to them.
 */
export function detectChangedPicks(
  sheetPicks: CardPick[],
  dbPicks: ReadonlyMap<number, DbPick>,
): PickChange[] {
  const changes: PickChange[] = [];
  for (const pick of sheetPicks) {
    const db = dbPicks.get(pick.pickPosition);
    if (!db) continue;
    const sheetSeat = pick.seat + 1; // 0-indexed → 1-indexed
    if (namesMatch(pick.cardName, db.cardName) && sheetSeat === db.seat) continue;
    changes.push({ pick, dbCardId: db.cardId, dbSeat: db.seat });
  }
  return changes;
}

/**
 * Resolve each change candidate and update the stored row when the card
 * actually differs. A candidate whose sheet name resolves to the stored
 * card_id is an alias spelling, not a change — skipped silently.
 */
export async function applyChangedPicks(
  client: Client,
  draftId: string,
  changes: PickChange[],
): Promise<{ updated: number; unresolved: number }> {
  let updated = 0;
  let unresolved = 0;
  for (const { pick, dbCardId, dbSeat } of changes) {
    const cardId = await resolveCardNameToId(client, pick.cardName);
    if (cardId === null) {
      console.warn(
        `[sync] Cannot resolve changed pick "${pick.cardName}" at position ${pick.pickPosition} for draft ${draftId}`,
      );
      unresolved++;
      continue;
    }
    const seat = pick.seat + 1;
    if (cardId === dbCardId && seat === dbSeat) continue;
    await client.execute({
      sql: "UPDATE pick_events SET card_id = ?, seat = ? WHERE draft_id = ? AND pick_n = ?",
      args: [cardId, seat, draftId, pick.pickPosition],
    });
    console.log(
      `[sync] Pick ${pick.pickPosition} in ${draftId} changed: card_id ${dbCardId} → ${cardId} ("${pick.cardName}")`,
    );
    updated++;
  }
  return { updated, unresolved };
}

/**
 * Resolve a card name to its card_id for Sheet-ingestion pick appends.
 *
 * Matching rule: fuzzy, case-insensitive, with progressive fallbacks:
 *   1. Exact match (case-insensitive)
 *   2. Front-face DFC ("Brazen Borrower" → "Brazen Borrower // Petty Theft")
 *   3. Back-face DFC ("Petty Theft" → "Brazen Borrower // Petty Theft")
 *   4. Alias table (diacritics, Omen-Paths digital names)
 *   5. Scryfall API fuzzy search — auto-populates the alias table on hit
 *
 * Use this ONLY for Sheet ingestion where players type card names by hand.
 * Typos, abbreviations, and digital-set alternate names are expected and
 * handled gracefully.
 *
 * Do NOT use this for live-draft mutations (pick/queue/float routes).  Those
 * routes receive canonical names from the server and must use resolveCardId /
 * resolveCardIds in core/db/queries/cards.ts — fuzzy matching there would risk
 * silently recording the wrong card_id in pick_events.
 *
 * For bulk CLI sync where per-name round-trips are too slow, use CardCache in
 * core/db/sync/card-cache.ts instead.
 *
 * Returns null if the card is not found even via Scryfall (unrecognised name).
 *
 * @param persistAlias - When the Scryfall fallback (step 5) resolves a name,
 *   it caches the mapping in `card_aliases` for future lookups. Pass `false`
 *   to suppress that write — e.g. under a dry run, where resolution must
 *   still work so unresolved names can be reported, but nothing may persist.
 *   Defaults to `true` so every existing caller is unaffected.
 */
export async function resolveCardNameToId(
  client: Client,
  cardName: string,
  persistAlias: boolean = true,
): Promise<number | null> {
  const normalized = normalizeCardName(cardName);

  // 1. Exact match
  const result = await client.execute({
    sql: "SELECT card_id FROM cards WHERE LOWER(name) = LOWER(?)",
    args: [normalized],
  });
  if (result.rows.length > 0) return result.rows[0].card_id as number;

  // 2. Front-face DFC match (name stored as "Front // Back")
  const dfcFrontResult = await client.execute({
    sql: "SELECT card_id FROM cards WHERE LOWER(name) LIKE LOWER(? || ' // %')",
    args: [normalized],
  });
  if (dfcFrontResult.rows.length > 0) return dfcFrontResult.rows[0].card_id as number;

  // 3. Back-face DFC match
  const dfcBackResult = await client.execute({
    sql: "SELECT card_id FROM cards WHERE LOWER(name) LIKE LOWER('% // ' || ?)",
    args: [normalized],
  });
  if (dfcBackResult.rows.length > 0) return dfcBackResult.rows[0].card_id as number;

  // 4. Alias table lookup (diacritics, Omen Paths digital names)
  const aliasResult = await client.execute({
    sql: "SELECT card_id FROM card_aliases WHERE alias = LOWER(?)",
    args: [normalized],
  });
  if (aliasResult.rows.length > 0) return aliasResult.rows[0].card_id as number;

  // 5. Scryfall API fallback — auto-discover and cache as alias
  return resolveViaScryfall(client, normalized, persistAlias);
}

/** Rate limit delay between Scryfall API requests (ms) */
const SCRYFALL_RATE_LIMIT_MS = 75;

async function resolveViaScryfall(
  client: Client,
  cardName: string,
  persistAlias: boolean,
): Promise<number | null> {
  await sleep(SCRYFALL_RATE_LIMIT_MS);
  // Try exact match first, then fuzzy (handles Omen Paths digital names)
  const scryfallCard = await fetchCard(cardName) ?? await fetchCardFuzzy(cardName);
  if (!scryfallCard) return null;

  // Scryfall resolved the name — find the canonical card in our DB
  const scryfallName = scryfallCard.name;
  const frontFace = getFrontFace(scryfallName);
  const namesToTry = frontFace ? [scryfallName, frontFace] : [scryfallName];

  for (const name of namesToTry) {
    const match = await client.execute({
      sql: "SELECT card_id FROM cards WHERE LOWER(name) = LOWER(?)",
      args: [name],
    });
    if (match.rows.length > 0) {
      const cardId = match.rows[0].card_id as number;
      // Cache the alias for future lookups, unless the caller asked us not
      // to persist (e.g. a dry run that must not write anything).
      if (persistAlias) {
        await client.execute({
          sql: "INSERT OR IGNORE INTO card_aliases (alias, card_id) VALUES (LOWER(?), ?)",
          args: [cardName, cardId],
        });
      }
      console.log(`[alias] "${cardName}" → "${scryfallName}" (card_id: ${cardId})`);
      return cardId;
    }
  }

  return null;
}

/**
 * Insert new picks into pick_events for an active draft.
 * Card names are batch-resolved by exact match first; misses fall back to
 * resolveCardNameToId (DFC faces, aliases, Scryfall). Picks that still fail
 * to resolve are counted so the caller can keep the picks hash stale and
 * retry on the next run.
 */
export async function insertNewPicks(
  client: Client,
  draftId: string,
  newPicks: CardPick[],
): Promise<{ inserted: number; unresolved: number }> {
  if (newPicks.length === 0) return { inserted: 0, unresolved: 0 };

  // Batch-resolve all card names in a single query
  const uniqueNames = [
    ...new Set(newPicks.map((p) => normalizeCardName(p.cardName))),
  ];
  const result = await client.execute({
    sql: `SELECT card_id, name FROM cards WHERE LOWER(name) IN (${placeholders(uniqueNames.length)})`,
    args: uniqueNames.map((n) => n.toLowerCase()),
  });
  const nameToId = new Map<string, number>();
  for (const row of result.rows) {
    nameToId.set((row.name as string).toLowerCase(), row.card_id as number);
  }

  let unresolved = 0;
  const statements: Array<{ sql: string; args: (string | number)[] }> = [];
  for (const pick of newPicks) {
    const normalized = normalizeCardName(pick.cardName).toLowerCase();
    let cardId = nameToId.get(normalized);
    if (cardId === undefined) {
      const fuzzy = await resolveCardNameToId(client, pick.cardName);
      if (fuzzy === null) {
        console.warn(
          `[sync] Warning: Card "${pick.cardName}" not found for draft ${draftId}, skipping pick ${pick.pickPosition}`,
        );
        unresolved++;
        continue;
      }
      cardId = fuzzy;
      nameToId.set(normalized, fuzzy);
    }
    // pick.seat is 0-indexed from parsePickRows, convert to 1-indexed
    statements.push({
      sql: "INSERT OR IGNORE INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)",
      args: [draftId, pick.pickPosition, pick.seat + 1, cardId],
    });
  }

  if (statements.length > 0) {
    await client.batch(statements);
  }

  return { inserted: statements.length, unresolved };
}

/**
 * Write a draft's phase. Callers are responsible for checking
 * isSyncPhaseTransitionLegal first — this is a raw write.
 */
export async function setDraftPhase(
  client: Client,
  draftId: string,
  phase: "drafting" | "playing" | "complete",
): Promise<void> {
  await client.execute({
    sql: "UPDATE drafts SET phase = ? WHERE draft_id = ?",
    args: [phase, draftId],
  });
}

/**
 * Reconcile a single active draft's picks against the sheet.
 *
 * Short-circuits on the stored picks hash, then:
 *   - diverged: the DB holds positions the sheet lost → CLI full sync needed
 *   - inserts positions missing from the DB
 *   - updates positions whose card (or seat) changed in the sheet
 *
 * The picks hash is persisted only when every sheet pick is reflected in the
 * DB — an unresolved card name keeps the hash stale so the next run retries.
 */
export async function incrementalIngest(
  client: Client,
  draftId: string,
  parsedPicks: ParsedPicks,
  storedPicksHash: string | null,
): Promise<{
  status: "no_change" | "updated" | "diverged";
  picksInserted: number;
  picksUpdated: number;
}> {
  const { picks } = parsedPicks;
  if (picks.length === 0) {
    return { status: "no_change", picksInserted: 0, picksUpdated: 0 };
  }

  const newHash = hashPicks(picks.filter((p) => p.wasPicked));
  if (newHash === storedPicksHash) {
    return { status: "no_change", picksInserted: 0, picksUpdated: 0 };
  }

  const dbPicks = await getDbPicks(client, draftId);

  const csvPositions = new Set(picks.map((p) => p.pickPosition));
  const removed = detectRemovedPicks(csvPositions, dbPicks.keys());
  if (removed.length > 0) {
    console.warn(
      `[sync] Divergence detected for draft ${draftId}: DB positions [${removed.join(", ")}] are missing from the sheet. Skipping — run pnpm sync to resolve.`,
    );
    return { status: "diverged", picksInserted: 0, picksUpdated: 0 };
  }

  const newPicks = detectNewPicks(picks, new Set(dbPicks.keys()));
  const { inserted, unresolved: insertUnresolved } = await insertNewPicks(
    client,
    draftId,
    newPicks,
  );
  if (inserted > 0) {
    console.log(`[sync] Inserted ${inserted} new picks for draft ${draftId}`);
  }

  const changes = detectChangedPicks(picks, dbPicks);
  const { updated, unresolved: changeUnresolved } = await applyChangedPicks(
    client,
    draftId,
    changes,
  );

  if (insertUnresolved === 0 && changeUnresolved === 0) {
    await updateDomainHashes(client, draftId, { picksHash: newHash });
  }

  if (inserted === 0 && updated === 0) {
    return { status: "no_change", picksInserted: 0, picksUpdated: 0 };
  }
  return { status: "updated", picksInserted: inserted, picksUpdated: updated };
}
