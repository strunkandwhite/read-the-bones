/**
 * Import hand-recovered decklists from docs/decklist-recovery-parsed/*.json.
 *
 * These decks were transcribed from screenshots of the deck-building UI for
 * seats whose sealeddeck submission is missing or unrecoverable. Card ids are
 * resolved from that seat's own pick_events rather than a global name lookup,
 * so a card the seat never drafted is unresolvable by construction — a bad
 * transcription fails loudly instead of writing something plausible.
 *
 * Usage:
 *   pnpm decklists:import --dry-run
 *   pnpm decklists:import
 *   pnpm decklists:import --force   # also overwrite decks sourced from a URL
 */

import { createClient, type Client } from "@libsql/client";
import { createHash } from "crypto";
import { readFileSync, readdirSync, realpathSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { loadEnv, log, logIndent } from "../src/core/db/ingest/utils";
import { deckCardInsertStatements, type DeckCardInsert } from "../src/core/db/sync/batch";
import { cardNameKey } from "../src/core/parseSheetRows";
import { assertRecognizedFlags } from "./lib/cliFlags";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARSED_DIR = join(__dirname, "..", "docs", "decklist-recovery-parsed");

export interface ParsedDeck {
  draftId: string;
  seat: number;
  maindeckNonBasics: string[];
  sideboard: string[];
}

// A screenshot shows only a card's front face, so the transcription says
// "Claim" where pick_events says "Claim // Fame". `cardNameKey` folds both to
// the same key; without it a single double-faced card fails the whole file,
// since an unresolvable name is a hard error by design.
const norm = cardNameKey;

/**
 * Resolve a parsed deck into deck_cards rows using only cards this seat drafted.
 *
 * @throws if the seat has no picks, or if any named card is not among them.
 */
export async function resolveDeckFromPicks(
  client: Client,
  parsed: ParsedDeck,
): Promise<DeckCardInsert[]> {
  const result = await client.execute({
    sql: `SELECT DISTINCT c.card_id, c.name
          FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ? AND pe.seat = ?`,
    args: [parsed.draftId, parsed.seat],
  });

  if (result.rows.length === 0) {
    throw new Error(
      `${parsed.draftId} seat ${parsed.seat} has no picks — cannot import a deck for a seat that never drafted (or opted out)`,
    );
  }

  const idByName = new Map<string, number>();
  for (const row of result.rows) {
    idByName.set(norm(row.name as string), row.card_id as number);
  }

  const qtyByKey = new Map<string, DeckCardInsert>();
  const unresolved: string[] = [];

  const zones: Array<{ names: string[]; zone: "deck" | "sideboard" }> = [
    { names: parsed.maindeckNonBasics, zone: "deck" },
    { names: parsed.sideboard, zone: "sideboard" },
  ];

  for (const { names, zone } of zones) {
    for (const name of names) {
      const cardId = idByName.get(norm(name));
      if (cardId === undefined) {
        unresolved.push(name);
        continue;
      }
      const key = `${cardId}:${zone}`;
      const existing = qtyByKey.get(key);
      if (existing) {
        existing.qty++;
      } else {
        qtyByKey.set(key, { draftId: parsed.draftId, seat: parsed.seat, cardId, zone, qty: 1 });
      }
    }
  }

  if (unresolved.length > 0) {
    throw new Error(
      `${parsed.draftId} seat ${parsed.seat}: ${unresolved.length} card(s) not among this seat's picks: ${unresolved.join(", ")}`,
    );
  }

  return [...qtyByKey.values()];
}

function readParsedDecks(): Array<{ file: string; deck: ParsedDeck }> {
  return readdirSync(PARSED_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      deck: JSON.parse(readFileSync(join(PARSED_DIR, file), "utf-8")) as ParsedDeck,
    }));
}

export type ImportAction = "write" | "refuse-foreign";

/**
 * Decide whether a transcription may replace what a seat already holds.
 *
 * A seat whose deck came from a sealeddeck URL is not a recovery target: the
 * URL is the player's own submission and the transcription is a reading of a
 * screenshot, so a disagreement between them is a transcription question, not
 * a repair. Overwriting anyway is irreversible in practice — the row is then
 * stamped `recovered:`, and `decideSeatWrite` in scripts/decklists.ts will
 * refuse to let `pnpm decklists` restore the URL-sourced deck without
 * `--force`. Re-importing a seat already stamped `recovered:` is just a re-run
 * of this script and needs no flag.
 *
 * A deck whose `source` is null is treated the same as a URL-sourced one
 * rather than as fair game: every deck stored before provenance existed came
 * from a URL, so "no recorded source" means "we failed to record it", not
 * "nothing to lose".
 */
export function decideImportWrite(
  existing: { hasDeck: boolean; source: string | null },
  force: boolean,
): ImportAction {
  if (!existing.hasDeck) return "write";
  if (existing.source?.startsWith("recovered:")) return "write";
  return force ? "write" : "refuse-foreign";
}

export interface DeckSlot {
  cardId: number;
  zone: string;
  qty: number;
}

export interface DeckDiff {
  /** Card copies the stored deck holds that this transcription does not. */
  onlyStored: number;
  /** Card copies this transcription holds that the stored deck does not. */
  onlyParsed: number;
  /** Per-slot detail, so a reviewer can tell one moved card from a different deck. */
  slots: Array<{ cardId: number; zone: string; storedQty: number; parsedQty: number }>;
}

/**
 * Compare a stored deck and a transcription as `(cardId, zone)` multisets.
 *
 * Zone is part of the identity on purpose: a card moved between maindeck and
 * sideboard is a real disagreement about the deck, and the integrity checker
 * cannot see it — precision is 1.0 either way, because both readings are made
 * of cards the seat drafted.
 */
export function diffDeckCards(stored: DeckSlot[], parsed: DeckSlot[]): DeckDiff {
  const slotKey = (slot: DeckSlot) => `${slot.cardId}:${slot.zone}`;
  const storedQty = new Map(stored.map((s) => [slotKey(s), s.qty]));
  const parsedQty = new Map(parsed.map((s) => [slotKey(s), s.qty]));

  const diff: DeckDiff = { onlyStored: 0, onlyParsed: 0, slots: [] };

  for (const key of new Set([...storedQty.keys(), ...parsedQty.keys()])) {
    const inStored = storedQty.get(key) ?? 0;
    const inParsed = parsedQty.get(key) ?? 0;
    if (inStored === inParsed) continue;

    const [cardId, zone] = key.split(":");
    diff.slots.push({ cardId: Number(cardId), zone, storedQty: inStored, parsedQty: inParsed });
    diff.onlyStored += Math.max(0, inStored - inParsed);
    diff.onlyParsed += Math.max(0, inParsed - inStored);
  }

  diff.slots.sort((a, b) => a.zone.localeCompare(b.zone) || a.cardId - b.cardId);
  return diff;
}

interface StoredSeat {
  /** `deck_hashes.sealeddeck_id`, or null when unstamped or unreadable. */
  source: string | null;
  hasHashRow: boolean;
  slots: DeckSlot[];
  nameById: Map<number, string>;
}

/**
 * Whether `deck_hashes` carries the provenance column yet.
 *
 * Reading provenance is how this script tells a previous recovery from a
 * URL-sourced deck. Production predates the migration that adds the column, so
 * the check has to be asked rather than assumed — and when the answer is no,
 * every existing deck reads as un-attributed, which refuses rather than
 * overwrites.
 */
async function hasProvenanceColumn(client: Client): Promise<boolean> {
  const info = await client.execute("PRAGMA table_info(deck_hashes)");
  return info.rows.some((row) => row.name === "sealeddeck_id");
}

/** Read what a seat currently holds: its provenance and its deck_cards rows. */
async function loadStoredSeat(
  client: Client,
  draftId: string,
  seat: number,
  provenanceReadable: boolean,
): Promise<StoredSeat> {
  const hashRow = await client.execute({
    sql: `SELECT ${provenanceReadable ? "sealeddeck_id" : "NULL AS sealeddeck_id"}
          FROM deck_hashes WHERE draft_id = ? AND seat = ?`,
    args: [draftId, seat],
  });
  const cardRows = await client.execute({
    sql: `SELECT dc.card_id, dc.zone, dc.qty, c.name
          FROM deck_cards dc JOIN cards c ON c.card_id = dc.card_id
          WHERE dc.draft_id = ? AND dc.seat = ?`,
    args: [draftId, seat],
  });

  const nameById = new Map<number, string>();
  const slots: DeckSlot[] = cardRows.rows.map((row) => {
    nameById.set(row.card_id as number, row.name as string);
    return { cardId: row.card_id as number, zone: row.zone as string, qty: row.qty as number };
  });

  return {
    source: (hashRow.rows.at(0)?.sealeddeck_id as string | null | undefined) ?? null,
    hasHashRow: hashRow.rows.length > 0,
    slots,
    nameById,
  };
}

/** Fill in names for card ids the stored deck did not already supply. */
async function loadMissingCardNames(
  client: Client,
  nameById: Map<number, string>,
  cardIds: number[],
): Promise<void> {
  const missing = [...new Set(cardIds)].filter((id) => !nameById.has(id));
  if (missing.length === 0) return;

  const result = await client.execute({
    sql: `SELECT card_id, name FROM cards WHERE card_id IN (${missing.map(() => "?").join(", ")})`,
    args: missing,
  });
  for (const row of result.rows) {
    nameById.set(row.card_id as number, row.name as string);
  }
}

/** How many card copies a set of deck_cards rows represents. */
const countCopies = (slots: DeckSlot[]) => slots.reduce((n, s) => n + s.qty, 0);

const MAX_LISTED_DIFFERENCES = 12;

/**
 * Print what this seat already holds and how far the transcription is from it.
 *
 * Maindeck and sideboard counts alone cannot show that a seat is about to be
 * overwritten, or by how much — two readings of the same 45 cards can agree on
 * both counts and still disagree about which zone eight of them belong in.
 */
function reportSeatState(
  stored: StoredSeat,
  rows: DeckCardInsert[],
  action: ImportAction,
  provenanceReadable: boolean,
): void {
  if (stored.slots.length === 0) {
    const note = stored.hasHashRow ? " (a deck_hashes row exists, but no deck_cards rows)" : "";
    console.log(`      stored deck: none${note} — this import creates it`);
    return;
  }

  const provenance =
    stored.source === null
      ? provenanceReadable
        ? "source unrecorded (predates provenance tracking — treated as URL-sourced)"
        : "source unreadable (deck_hashes has no sealeddeck_id column yet — treated as URL-sourced)"
      : stored.source.startsWith("recovered:")
        ? `source ${stored.source} (a previous recovery — re-importing it is just a re-run)`
        : `source sealeddeck submission '${stored.source}'`;
  console.log(`      stored deck: ${countCopies(stored.slots)} card copies, ${provenance}`);

  const diff = diffDeckCards(stored.slots, rows);
  if (diff.slots.length === 0) {
    console.log("      transcription agrees with the stored deck card for card");
  } else {
    console.log(
      `      transcription differs by ${diff.onlyStored + diff.onlyParsed} card copies ` +
        `(${diff.onlyStored} only in stored, ${diff.onlyParsed} only in parsed)`,
    );
    for (const slot of diff.slots.slice(0, MAX_LISTED_DIFFERENCES)) {
      const name = stored.nameById.get(slot.cardId) ?? `card ${slot.cardId}`;
      console.log(
        `        ${name} (${slot.zone}): stored ${slot.storedQty}, parsed ${slot.parsedQty}`,
      );
    }
    if (diff.slots.length > MAX_LISTED_DIFFERENCES) {
      console.log(`        ... and ${diff.slots.length - MAX_LISTED_DIFFERENCES} more`);
    }
  }

  if (action === "refuse-foreign") {
    console.log(
      "      REFUSED — this seat's deck did not come from a recovery. Pass --force to overwrite it.",
    );
  } else if (stored.source?.startsWith("recovered:")) {
    console.log("      would overwrite the previous recovery");
  } else {
    console.log("      would overwrite the stored deck (--force)");
  }
}

const RECOGNIZED_FLAGS = new Set(["--dry-run", "--force"]);

/**
 * Parse CLI args into flags. Pure so the "reject a typo'd flag" behavior — the
 * difference between a rehearsal and a real import into the one production
 * database — is covered by a unit test rather than only by invoking the script.
 */
export function parseImportArgs(args: string[]): { dryRun: boolean; force: boolean } {
  assertRecognizedFlags(args, RECOGNIZED_FLAGS);

  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  };
}

async function main() {
  loadEnv();

  let dryRun: boolean;
  let force: boolean;
  try {
    ({ dryRun, force } = parseImportArgs(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const parsed = readParsedDecks();
  log(`Found ${parsed.length} parsed decklist(s) in docs/decklist-recovery-parsed`);
  if (dryRun) log("DRY RUN — resolving only, nothing will be written");

  // Resolve everything before writing anything. A transcription error in one
  // file should not leave the database half-updated.
  const resolved: Array<{ file: string; deck: ParsedDeck; rows: DeckCardInsert[] }> = [];
  const failures: string[] = [];

  for (const { file, deck } of parsed) {
    try {
      resolved.push({ file, deck, rows: await resolveDeckFromPicks(client, deck) });
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} file(s) failed to resolve. Nothing was written.\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    client.close();
    process.exit(1);
  }

  // Inspect what each target seat already holds before touching any of it. Two
  // of these files target seats that already have a good URL-sourced deck; the
  // operator has to be able to see that from the dry run.
  const writable: Array<{ file: string; deck: ParsedDeck; rows: DeckCardInsert[] }> = [];
  let refused = 0;

  const provenanceReadable = await hasProvenanceColumn(client);

  for (const { file, deck, rows } of resolved) {
    const stored = await loadStoredSeat(client, deck.draftId, deck.seat, provenanceReadable);
    await loadMissingCardNames(client, stored.nameById, rows.map((r) => r.cardId));

    const action = decideImportWrite(
      { hasDeck: stored.slots.length > 0, source: stored.source },
      force,
    );
    const maindeck = countCopies(rows.filter((r) => r.zone === "deck"));
    const sideboard = countCopies(rows.filter((r) => r.zone === "sideboard"));
    logIndent(
      `${file}: ${deck.draftId} seat ${deck.seat} — ${maindeck} maindeck, ${sideboard} sideboard`,
    );
    reportSeatState(stored, rows, action, provenanceReadable);

    if (action === "refuse-foreign") {
      refused++;
      continue;
    }
    writable.push({ file, deck, rows });
  }

  if (dryRun) {
    log(
      `Dry run complete — ${writable.length} deck(s) would be imported, ${refused} refused. ` +
        `Re-run without --dry-run to apply.`,
    );
    client.close();
    return;
  }

  if (!provenanceReadable) {
    console.error(
      "\ndeck_hashes has no sealeddeck_id column — run pnpm db:migrate first. Nothing was written.\n" +
        "Without it the import cannot record that these decks were recovered, and the guard that\n" +
        "stops pnpm decklists from reverting them has nothing to read.",
    );
    client.close();
    process.exit(1);
  }

  for (const { file, deck, rows } of writable) {
    const source = `recovered:${basename(file)}`;
    const hash = createHash("sha256")
      .update(JSON.stringify({ maindeck: deck.maindeckNonBasics, sideboard: deck.sideboard }))
      .digest("hex")
      .slice(0, 16);

    // One batch: the delete, the inserts and the provenance upsert either all
    // land or none do. As three round trips, a failure between them leaves the
    // seat with no deck at all — and this script's whole purpose is seats whose
    // deck exists nowhere else.
    await client.batch([
      {
        sql: "DELETE FROM deck_cards WHERE draft_id = ? AND seat = ?",
        args: [deck.draftId, deck.seat],
      },
      ...deckCardInsertStatements(rows),
      {
        sql: "INSERT OR REPLACE INTO deck_hashes (draft_id, seat, hash, sealeddeck_id) VALUES (?, ?, ?, ?)",
        args: [deck.draftId, deck.seat, hash, source],
      },
    ]);

    logIndent(`${deck.draftId} seat ${deck.seat}: ${rows.length} rows written (${source})`);
  }

  log(`Imported ${writable.length} recovered decklist(s), refused ${refused}`);
  client.close();
}

// Only run when invoked as a script. Importing this module — which the test does,
// for the pure resolveDeckFromPicks function — must never start a run against
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
