/**
 * Fetch sealeddeck.tech decklists and write deck cards directly to Turso.
 *
 * Reads data/decklists.txt, fetches each sealeddeck URL,
 * matches to seats by card overlap with pick data from Turso, and writes
 * deck_cards + deck_hashes rows via batch operations.
 *
 * Usage: npx tsx scripts/decklists.ts [draft-label]
 */

import { createClient, type Client } from "@libsql/client";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv, log, logIndent } from "../src/core/db/ingest/utils";
import { batchInsertDeckCards, type DeckCardInsert } from "../src/core/db/sync/batch";
import { CardCache } from "../src/core/db/sync/card-cache";
import { normalizeCardName } from "../src/core/parseSheetRows";
import { resolveCardNameToId } from "../src/core/db/sync/incremental";
import { slugify } from "./lib/slugify";
import {
  scoreAgainstSeat,
  isEligibleSeat,
  formatPct,
  SEAT_MATCH_RECALL_THRESHOLD,
  SEAT_MATCH_PRECISION_THRESHOLD,
  type SeatScore,
} from "./lib/deckMatching";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECKLISTS_FILE = join(__dirname, "..", "data", "decklists.txt");

// Delay between sealeddeck.tech fetches (ms). sealeddeck.tech is a small site;
// be a considerate client.
const SEALEDDECK_RATE_LIMIT_MS = 200;

const BASIC_LANDS = new Set([
  "plains",
  "island",
  "swamp",
  "mountain",
  "forest",
  "wastes",
]);

// ============================================================================
// Types
// ============================================================================

interface SealedDeckCard {
  name: string;
  count: number;
}

interface SealedDeckResponse {
  poolId: string;
  deck: SealedDeckCard[];
  sideboard: SealedDeckCard[];
  hidden?: SealedDeckCard[];
}

interface DecklistEntry {
  sealeddeckId: string;
  url: string;
  deck: string[];
  sideboard: string[];
  /**
   * Exactly the cards this submission will store: deck + sideboard, minus
   * basics, normalized. Deliberately excludes sealeddeck's `hidden` zone —
   * matching against cards we never store is what misfiled three decklists.
   */
  storedCards: Set<string>;
}

// ============================================================================
// Parsing & Fetching (ported from match-decklists.ts)
// ============================================================================

/** Parse decklists.txt into draft groups: label -> URLs */
function parseDecklistsFile(content: string): Map<string, string[]> {
  const drafts = new Map<string, string[]>();
  let currentDraft: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("https://")) {
      if (currentDraft) {
        drafts.get(currentDraft)!.push(line);
      }
    } else {
      currentDraft = line;
      if (!drafts.has(currentDraft)) {
        drafts.set(currentDraft, []);
      }
    }
  }

  return drafts;
}

/** Fetch a sealeddeck.tech pool */
async function fetchDeck(id: string): Promise<SealedDeckResponse> {
  const url = `https://sealeddeck.tech/api/pools/${id}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return (await response.json()) as SealedDeckResponse;
}

/** Normalize a card name for matching (lowercase, strip numeric suffixes) */
function normalizeForMatch(name: string): string {
  return normalizeCardName(name).toLowerCase();
}

/**
 * The cards a submission will actually store: deck + sideboard, non-basics only.
 *
 * `hidden` is excluded on purpose. Some submitters pasted the entire remaining
 * cube into that zone; because it was included in matching but never written,
 * those lists overlapped every seat completely and evicted correct decks.
 */
export function extractStoredCards(response: SealedDeckResponse): Set<string> {
  const stored = new Set<string>();
  for (const card of [...response.deck, ...response.sideboard]) {
    const normalized = normalizeForMatch(card.name);
    if (!BASIC_LANDS.has(normalized)) {
      stored.add(normalized);
    }
  }
  return stored;
}

/**
 * Extract card names for a zone, expanding count > 1.
 * Filters out basic lands.
 */
function extractZoneCards(cards: SealedDeckCard[]): string[] {
  const result: string[] = [];
  for (const card of cards) {
    const normalized = normalizeForMatch(card.name);
    if (BASIC_LANDS.has(normalized)) continue;
    for (let i = 0; i < card.count; i++) {
      result.push(card.name);
    }
  }
  return result.sort();
}

/** Report why a decklist matched no seat, at a severity that fits the cause. */
function reportSkip(
  decklist: DecklistEntry,
  best: { seat: number; score: SeatScore } | null,
): void {
  if (!best || best.score.overlap === 0) {
    // No overlap with any seat at all. This is an opted-out player's list:
    // their picks were never ingested, so there is nothing to match against.
    // Seven of these occur every run. Warning on expected behaviour trains
    // everyone to ignore the log, which is how 27 overwrite lines went unread.
    logIndent(
      `Skipping ${decklist.sealeddeckId} — no overlap with any seat (expected for an opted-out player)`,
    );
    return;
  }

  console.warn(
    `  WARNING: Skipping ${decklist.sealeddeckId} — best candidate seat ${best.seat} ` +
      `scored recall ${formatPct(best.score.recall)} (need ${formatPct(SEAT_MATCH_RECALL_THRESHOLD)}), ` +
      `precision ${formatPct(best.score.precision)} (need ${formatPct(SEAT_MATCH_PRECISION_THRESHOLD)}). ` +
      `Low precision means the list holds cards that seat never drafted.`,
  );
}

/**
 * Match decklists to seats by overlap with each seat's picks.
 *
 * A seat is eligible only if it clears both thresholds. Exactly one eligible
 * seat assigns the list. More than one cannot happen under rotisserie rules —
 * a card belongs to one player — so that case skips rather than guessing:
 * a tie means an assumption has broken, and picking a winner buries the evidence.
 */
export function matchDecksToSeats(
  decklists: DecklistEntry[],
  seatPicks: Map<number, Set<string>>,
): Map<number, DecklistEntry> {
  const assignments = new Map<number, DecklistEntry>();

  for (const decklist of decklists) {
    const eligible: Array<{ seat: number; score: SeatScore }> = [];
    let best: { seat: number; score: SeatScore } | null = null;

    for (const [seat, picks] of seatPicks) {
      const score = scoreAgainstSeat(decklist.storedCards, picks);
      if (!best || score.overlap > best.score.overlap) {
        best = { seat, score };
      }
      if (isEligibleSeat(score)) {
        eligible.push({ seat, score });
      }
    }

    if (eligible.length === 0) {
      reportSkip(decklist, best);
      continue;
    }

    if (eligible.length > 1) {
      console.warn(
        `  WARNING: Skipping ${decklist.sealeddeckId} — ${eligible.length} seats are eligible ` +
          `(${eligible.map((e) => `seat ${e.seat} at ${formatPct(e.score.precision)} precision`).join(", ")}). ` +
          `Rotisserie gives every card one owner, so this means an assumption has broken.`,
      );
      continue;
    }

    const { seat, score } = eligible[0];

    // A genuine resubmission for the same seat should win. This overwrite was
    // never the defect — it was the symptom of matching on the wrong card set.
    const previous = assignments.get(seat);
    if (previous) {
      logIndent(
        `Seat ${seat}: ${previous.sealeddeckId} replaced by ${decklist.sealeddeckId} (later submission)`,
      );
    }

    logIndent(
      `Seat ${seat}: ${decklist.sealeddeckId} — recall ${formatPct(score.recall)}, precision ${formatPct(score.precision)}`,
    );
    assignments.set(seat, decklist);
  }

  return assignments;
}

// ============================================================================
// Turso integration (new in this script)
// ============================================================================

/** Get pick data from Turso for seat matching */
async function getSeatPicks(
  client: Client,
  draftId: string,
): Promise<Map<number, Set<string>>> {
  const result = await client.execute({
    sql: `SELECT pe.seat, c.name FROM pick_events pe
          JOIN cards c ON pe.card_id = c.card_id
          WHERE pe.draft_id = ?`,
    args: [draftId],
  });
  const seatPicks = new Map<number, Set<string>>();
  for (const row of result.rows) {
    const seat = row.seat as number;
    if (!seatPicks.has(seat)) seatPicks.set(seat, new Set());
    seatPicks.get(seat)!.add((row.name as string).toLowerCase());
  }
  return seatPicks;
}

/** Resolve a draft label to a draft_id in Turso */
async function resolveDraftId(
  client: Client,
  label: string,
): Promise<string | null> {
  // Try direct match
  let result = await client.execute({
    sql: "SELECT draft_id FROM drafts WHERE draft_id = ?",
    args: [label],
  });
  if (result.rows.length > 0) return result.rows[0].draft_id as string;

  // Try slugified version
  const slugified = slugify(label);
  result = await client.execute({
    sql: "SELECT draft_id FROM drafts WHERE draft_id = ?",
    args: [slugified],
  });
  if (result.rows.length > 0) return result.rows[0].draft_id as string;

  return null;
}

/** Fetch all decklists from sealeddeck.tech for a set of URLs */
async function fetchAllDecklists(urls: string[]): Promise<DecklistEntry[]> {
  const decklists: DecklistEntry[] = [];

  for (const url of urls) {
    const match = url.match(/sealeddeck\.tech\/(.+)$/);
    const id = match ? match[1] : url;

    try {
      logIndent(`Fetching ${id}...`);
      const response = await fetchDeck(id);
      const storedCards = extractStoredCards(response);

      decklists.push({
        sealeddeckId: id,
        url: `https://sealeddeck.tech/${id}`,
        deck: extractZoneCards(response.deck),
        sideboard: extractZoneCards(response.sideboard),
        storedCards,
      });

      // Rate limit: sealeddeck.tech is a small site
      await new Promise((r) => setTimeout(r, SEALEDDECK_RATE_LIMIT_MS));
    } catch (error) {
      console.error(`  ERROR fetching ${id}: ${error}`);
    }
  }

  return decklists;
}

/**
 * Resolve a card name to a card_id.
 * Uses in-memory CardCache first, then falls back to resolveCardNameToId
 * which handles DFC names and aliases.
 */
async function resolveCard(
  client: Client,
  cardCache: CardCache,
  cardName: string,
): Promise<number | null> {
  const normalized = normalizeCardName(cardName);
  const cached = cardCache.get(normalized);
  if (cached !== undefined) return cached;

  // Fallback: DFC front-face match, alias lookup, Scryfall fetch
  const cardId = await resolveCardNameToId(client, normalized);
  if (cardId !== null) {
    // Warm the cache for future lookups
    cardCache.set(normalized, cardId);
  }
  return cardId;
}

// ============================================================================
// Zone resolution helper
// ============================================================================

/**
 * Resolve a list of card names for one deck zone into qtyMap entries.
 *
 * @param warnOnMiss - deck zone warns on unresolved names (they indicate real
 *   data quality issues); sideboard silently ignores misses because basic lands
 *   and other filtered-out cards legitimately appear there.
 */
async function resolveZoneCards(
  client: Client,
  cardCache: CardCache,
  cardNames: string[],
  zone: "deck" | "sideboard",
  seat: number,
  qtyMap: Map<string, { cardId: number; zone: "deck" | "sideboard"; qty: number }>,
  warnOnMiss: boolean,
): Promise<number> {
  let warnings = 0;
  for (const cardName of cardNames) {
    const cardId = await resolveCard(client, cardCache, cardName);
    if (cardId !== null) {
      const key = `${cardId}:${zone}`;
      const existing = qtyMap.get(key);
      if (existing) {
        existing.qty++;
      } else {
        qtyMap.set(key, { cardId, zone, qty: 1 });
      }
    } else if (warnOnMiss) {
      warnings++;
      console.warn(`  Warning: Card not found: "${cardName}" (seat ${seat} ${zone})`);
    }
    // When warnOnMiss is false (sideboard), misses are intentionally silent —
    // basic lands and other filtered cards legitimately appear there.
  }
  return warnings;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  loadEnv();
  const filterDraft = process.argv[2]; // Optional: specific draft label

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  if (!existsSync(DECKLISTS_FILE)) {
    console.error("data/decklists.txt not found");
    process.exit(1);
  }

  const content = readFileSync(DECKLISTS_FILE, "utf-8");
  const drafts = parseDecklistsFile(content);

  log(`Found ${drafts.size} drafts in decklists.txt`);

  const cardCache = new CardCache();
  await cardCache.loadAll(client);
  log(`Card cache loaded: ${cardCache.size} cards`);

  for (const [label, urls] of drafts) {
    if (filterDraft && label !== filterDraft) continue;

    const draftId = await resolveDraftId(client, label);
    if (!draftId) {
      console.error(`Draft not found in Turso: "${label}"`);
      continue;
    }

    log(`${label} (${draftId}) — ${urls.length} links`);

    // Fetch decklists from sealeddeck.tech
    const decklists = await fetchAllDecklists(urls);
    if (decklists.length === 0) {
      logIndent("No decklists fetched, skipping");
      continue;
    }

    // Get seat picks from Turso
    const seatPicks = await getSeatPicks(client, draftId);
    logIndent(`${seatPicks.size} seats in database`);

    // Match decklists to seats
    const assignments = matchDecksToSeats(decklists, seatPicks);
    logIndent(`Matched ${assignments.size} decklists to seats`);

    // Write to Turso with per-seat hash diffing
    for (const [seat, entry] of [...assignments].sort(([a], [b]) => a - b)) {
      // Compute deck hash for incremental diffing
      const deckJson = JSON.stringify({
        deck: entry.deck,
        sideboard: entry.sideboard,
      });
      const hash = createHash("sha256")
        .update(deckJson)
        .digest("hex")
        .slice(0, 16);

      // Check stored hash — skip if unchanged
      const storedHash = await client.execute({
        sql: "SELECT hash FROM deck_hashes WHERE draft_id = ? AND seat = ?",
        args: [draftId, seat],
      });
      if (storedHash.rows.length > 0 && storedHash.rows[0].hash === hash) {
        logIndent(`Seat ${seat}: unchanged`);
        continue;
      }

      // Delete old deck cards for this seat before reinserting
      await client.execute({
        sql: "DELETE FROM deck_cards WHERE draft_id = ? AND seat = ?",
        args: [draftId, seat],
      });

      // Resolve card names and build insert batch, aggregating duplicates
      const qtyMap = new Map<string, { cardId: number; zone: "deck" | "sideboard"; qty: number }>();

      const warnings = await resolveZoneCards(client, cardCache, entry.deck, "deck", seat, qtyMap, true);
      await resolveZoneCards(client, cardCache, entry.sideboard, "sideboard", seat, qtyMap, false);

      const deckCards: DeckCardInsert[] = [...qtyMap.values()].map((e) => ({
        draftId,
        seat,
        cardId: e.cardId,
        zone: e.zone,
        qty: e.qty,
      }));

      // Skip malformed decks (unsorted pools, barely-sorted submissions)
      const maindeckQty = deckCards
        .filter((c) => c.zone === "deck")
        .reduce((sum, c) => sum + c.qty, 0);

      if (maindeckQty < 20) {
        logIndent(
          `Seat ${seat}: skipped — only ${maindeckQty} maindeck cards (minimum 20)`,
        );
        // Clean up any previously-stored data for this seat
        await client.execute({
          sql: "DELETE FROM deck_hashes WHERE draft_id = ? AND seat = ?",
          args: [draftId, seat],
        });
        continue;
      }

      await batchInsertDeckCards(client, deckCards);

      // Store/update deck hash
      await client.execute({
        sql: "INSERT OR REPLACE INTO deck_hashes (draft_id, seat, hash) VALUES (?, ?, ?)",
        args: [draftId, seat, hash],
      });

      const status = storedHash.rows.length > 0 ? "updated" : "new";
      logIndent(
        `Seat ${seat}: ${deckCards.length} cards written (${status})${warnings > 0 ? ` [${warnings} warnings]` : ""}`,
      );
    }
  }

  log("Done!");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
