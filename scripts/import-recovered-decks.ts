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
 */

import { createClient, type Client } from "@libsql/client";
import { createHash } from "crypto";
import { readFileSync, readdirSync, realpathSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { loadEnv, log, logIndent } from "../src/core/db/ingest/utils";
import { batchInsertDeckCards, type DeckCardInsert } from "../src/core/db/sync/batch";
import { normalizeCardName } from "../src/core/parseSheetRows";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARSED_DIR = join(__dirname, "..", "docs", "decklist-recovery-parsed");

export interface ParsedDeck {
  draftId: string;
  seat: number;
  maindeckNonBasics: string[];
  sideboard: string[];
}

const norm = (name: string) => normalizeCardName(name).toLowerCase();

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

async function main() {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");

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
      const rows = await resolveDeckFromPicks(client, deck);
      resolved.push({ file, deck, rows });
      const maindeck = rows.filter((r) => r.zone === "deck").reduce((n, r) => n + r.qty, 0);
      const sideboard = rows.filter((r) => r.zone === "sideboard").reduce((n, r) => n + r.qty, 0);
      logIndent(`${file}: ${deck.draftId} seat ${deck.seat} — ${maindeck} maindeck, ${sideboard} sideboard`);
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

  if (dryRun) {
    log(`Dry run complete — ${resolved.length} deck(s) would be imported. Re-run without --dry-run to apply.`);
    client.close();
    return;
  }

  for (const { file, deck, rows } of resolved) {
    const source = `recovered:${basename(file)}`;
    const hash = createHash("sha256")
      .update(JSON.stringify({ maindeck: deck.maindeckNonBasics, sideboard: deck.sideboard }))
      .digest("hex")
      .slice(0, 16);

    await client.execute({
      sql: "DELETE FROM deck_cards WHERE draft_id = ? AND seat = ?",
      args: [deck.draftId, deck.seat],
    });
    await batchInsertDeckCards(client, rows);
    await client.execute({
      sql: "INSERT OR REPLACE INTO deck_hashes (draft_id, seat, hash, sealeddeck_id) VALUES (?, ?, ?, ?)",
      args: [deck.draftId, deck.seat, hash, source],
    });

    logIndent(`${deck.draftId} seat ${deck.seat}: ${rows.length} rows written (${source})`);
  }

  log(`Imported ${resolved.length} recovered decklist(s)`);
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
