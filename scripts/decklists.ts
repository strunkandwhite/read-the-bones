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
import { readFileSync, existsSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv, log, logIndent } from "../src/core/db/ingest/utils";
import { deckCardInsertStatements, type DeckCardInsert } from "../src/core/db/sync/batch";
import { CardCache } from "../src/core/db/sync/card-cache";
import { normalizeCardName } from "../src/core/parseSheetRows";
import { resolveCardNameToId } from "../src/core/db/sync/incremental";
import { slugify } from "./lib/slugify";
import { assertRecognizedFlags } from "./lib/cliFlags";
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

export interface MatchResult {
  assignments: Map<number, DecklistEntry>;
  /**
   * Decklists that never landed on a seat because matching rejected them —
   * either no seat cleared both thresholds, or more than one did (an
   * ambiguity rotisserie rules forbid). A decklist later superseded by a
   * newer submission for the same seat does NOT count here: it passed
   * matching, it was just replaced.
   */
  skippedBelowThreshold: number;
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
): MatchResult {
  const assignments = new Map<number, DecklistEntry>();
  let skippedBelowThreshold = 0;

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
      skippedBelowThreshold++;
      continue;
    }

    if (eligible.length > 1) {
      console.warn(
        `  WARNING: Skipping ${decklist.sealeddeckId} — ${eligible.length} seats are eligible ` +
          `(${eligible.map((e) => `seat ${e.seat} at ${formatPct(e.score.precision)} precision`).join(", ")}). ` +
          `Rotisserie gives every card one owner, so this means an assumption has broken.`,
      );
      skippedBelowThreshold++;
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

  return { assignments, skippedBelowThreshold };
}

export type SeatAction = "skip-recovered" | "unchanged" | "write";

/**
 * Decide what to do with a seat's freshly fetched deck, given what's already
 * stored for it. Pure so the two protective mechanisms it encodes — the
 * recovered-deck guard and the hash+provenance short-circuit — stay covered
 * by tests instead of living only inside `main()`'s `client.execute` calls.
 *
 * - A hand-recovered deck (`sealeddeckId` starting with `"recovered:"`)
 *   refuses to be overwritten unless `force` is set, regardless of hash.
 * - Otherwise, skip only when BOTH the hash and the recorded provenance
 *   already match this submission. Checking hash alone would leave a seat
 *   whose provenance is still `NULL` — the state every seat is in before
 *   this column existed — skipped forever, since its hash already matches;
 *   provenance would then never backfill and the later prune would have
 *   nothing to query.
 */
export function decideSeatWrite(
  existing: { hash: string; sealeddeckId: string | null } | undefined,
  hash: string,
  sealeddeckId: string,
  force: boolean,
): SeatAction {
  if (existing?.sealeddeckId?.startsWith("recovered:") && !force) {
    return "skip-recovered";
  }

  if (existing && existing.hash === hash && existing.sealeddeckId === sealeddeckId) {
    return "unchanged";
  }

  return "write";
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
 *
 * @param persistAlias - forwarded to resolveCardNameToId. Under a dry run
 *   this is `false`, so a Scryfall-resolved alternate name is still
 *   resolved (and reported) but never written to card_aliases.
 */
async function resolveCard(
  client: Client,
  cardCache: CardCache,
  cardName: string,
  persistAlias: boolean,
): Promise<number | null> {
  const normalized = normalizeCardName(cardName);
  const cached = cardCache.get(normalized);
  if (cached !== undefined) return cached;

  // Fallback: DFC front-face match, alias lookup, Scryfall fetch
  const cardId = await resolveCardNameToId(client, normalized, persistAlias);
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
  persistAlias: boolean,
): Promise<number> {
  let warnings = 0;
  for (const cardName of cardNames) {
    const cardId = await resolveCard(client, cardCache, cardName, persistAlias);
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

const RECOGNIZED_FLAGS = new Set(["--dry-run", "--force"]);

/**
 * Parse CLI args into the draft filter and flags. Pure so the "reject a
 * typo'd flag" behavior — the difference between a dry run and a full
 * destructive pass against the one production database — is covered by a
 * unit test instead of only by manually invoking the script.
 *
 * Throws on any `--`-prefixed argument that isn't a recognized flag, rather
 * than silently dropping it and falling through to a full run.
 */
export function parseDecklistArgs(
  args: string[],
): { filterDraft: string | undefined; force: boolean; dryRun: boolean } {
  assertRecognizedFlags(args, RECOGNIZED_FLAGS);

  return {
    // Skip flags so `pnpm decklists --dry-run` still works without a draft label.
    filterDraft: args.find((a) => !a.startsWith("--")),
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
  };
}

async function main() {
  loadEnv();

  let filterDraft: string | undefined;
  let force: boolean;
  let dryRun: boolean;
  try {
    ({ filterDraft, force, dryRun } = parseDecklistArgs(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

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

  if (dryRun) {
    log("DRY RUN — fetching and matching only, nothing will be written");
  }

  const cardCache = new CardCache();
  await cardCache.loadAll(client);
  log(`Card cache loaded: ${cardCache.size} cards`);

  // Outcome tally across every draft, printed as a dry-run summary before the
  // closing hint — a human has to read this before authorizing a run against
  // the one production database.
  const summary = {
    wouldCreate: 0,
    wouldUpdate: 0,
    unchanged: 0,
    skippedBelowThreshold: 0,
    skippedMalformed: 0,
    skippedRecovered: 0,
  };

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
    const { assignments, skippedBelowThreshold } = matchDecksToSeats(decklists, seatPicks);
    logIndent(`Matched ${assignments.size} decklists to seats`);
    summary.skippedBelowThreshold += skippedBelowThreshold;

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

      // Existing state for this seat, including where its deck came from.
      const existingRow = await client.execute({
        sql: "SELECT hash, sealeddeck_id FROM deck_hashes WHERE draft_id = ? AND seat = ?",
        args: [draftId, seat],
      });
      const existingRowData = existingRow.rows.at(0);
      const existing = existingRowData
        ? {
            hash: existingRowData.hash as string,
            sealeddeckId: existingRowData.sealeddeck_id as string | null,
          }
        : undefined;

      const action = decideSeatWrite(existing, hash, entry.sealeddeckId, force);

      // A hand-recovered deck outranks anything fetched. Recovery is expensive
      // and often the only copy that exists; silently reverting one would undo
      // work that cannot be redone from this file.
      if (action === "skip-recovered") {
        logIndent(
          `Seat ${seat}: skipped — hand-recovered deck (${existing?.sealeddeckId}). Pass --force to overwrite.`,
        );
        summary.skippedRecovered++;
        continue;
      }

      if (action === "unchanged") {
        logIndent(`Seat ${seat}: unchanged`);
        summary.unchanged++;
        continue;
      }

      // Resolve card names and build insert batch, aggregating duplicates
      const qtyMap = new Map<string, { cardId: number; zone: "deck" | "sideboard"; qty: number }>();

      const warnings = await resolveZoneCards(client, cardCache, entry.deck, "deck", seat, qtyMap, true, !dryRun);
      await resolveZoneCards(client, cardCache, entry.sideboard, "sideboard", seat, qtyMap, false, !dryRun);

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
      const sideboardQty = deckCards
        .filter((c) => c.zone === "sideboard")
        .reduce((sum, c) => sum + c.qty, 0);

      if (maindeckQty < 20) {
        logIndent(
          `Seat ${seat}: skipped — only ${maindeckQty} maindeck cards (minimum 20)`,
        );
        summary.skippedMalformed++;
        if (!dryRun) {
          // Clear the hash so a corrected resubmission is re-evaluated next run,
          // but keep sealeddeck_id: it is the only record that this seat's deck was
          // hand-recovered, and losing it disarms the overwrite guard permanently.
          await client.execute({
            sql: "UPDATE deck_hashes SET hash = '' WHERE draft_id = ? AND seat = ?",
            args: [draftId, seat],
          });
        }
        continue;
      }

      if (dryRun) {
        // Name what's being replaced, and make an in-flight overwrite of a
        // hand-recovered deck unmissable — this can only happen via --force,
        // since decideSeatWrite would otherwise have returned "skip-recovered"
        // above, and it is the highest-stakes event a reviewer can authorize.
        const existingSource = existing?.sealeddeckId ?? null;
        const isRecoveredOverwrite = existingSource?.startsWith("recovered:") ?? false;

        let status: string;
        if (isRecoveredOverwrite) {
          status = `would OVERWRITE hand-recovered deck (${existingSource})`;
        } else if (existing) {
          status = `would update (replacing ${existingSource ?? "unknown source"})`;
        } else {
          status = "would create";
        }
        if (existing) {
          summary.wouldUpdate++;
        } else {
          summary.wouldCreate++;
        }

        logIndent(
          `Seat ${seat}: ${status} — ${maindeckQty} maindeck + ${sideboardQty} sideboard cards from ${entry.sealeddeckId}` +
            `${warnings > 0 ? ` [${warnings} unresolved names]` : ""}`,
        );
        continue;
      }

      // Replace this seat's deck only once a valid one is ready to take its place,
      // and in one batch so the replacement cannot half-apply. Deleting earlier
      // meant a malformed resubmission destroyed a good deck and then declined to
      // write anything.
      await client.batch([
        {
          sql: "DELETE FROM deck_cards WHERE draft_id = ? AND seat = ?",
          args: [draftId, seat],
        },
        ...deckCardInsertStatements(deckCards),
        {
          sql: "INSERT OR REPLACE INTO deck_hashes (draft_id, seat, hash, sealeddeck_id) VALUES (?, ?, ?, ?)",
          args: [draftId, seat, hash, entry.sealeddeckId],
        },
      ]);

      const status = existing ? "updated" : "new";
      logIndent(
        `Seat ${seat}: ${deckCards.length} cards written (${status})${warnings > 0 ? ` [${warnings} warnings]` : ""}`,
      );
    }
  }

  if (dryRun) {
    log(
      `Summary — would create: ${summary.wouldCreate}, would update: ${summary.wouldUpdate}, ` +
        `unchanged: ${summary.unchanged}, skipped (below threshold): ${summary.skippedBelowThreshold}, ` +
        `skipped (malformed): ${summary.skippedMalformed}, skipped (recovered): ${summary.skippedRecovered}`,
    );
  }

  log(dryRun ? "Dry run complete — re-run without --dry-run to apply." : "Done!");
}

// Only run when invoked as a script. Importing this module — which the tests do,
// for the pure matching functions — must never start a fetch-and-write against
// production. `loadEnv` picks up real Turso credentials, so the guard is what
// stands between `pnpm test` and a write to deck_cards.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
