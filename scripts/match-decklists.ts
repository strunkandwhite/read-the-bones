/**
 * Match sealeddeck.tech decklists to draft seats.
 *
 * Reads decklists.txt, fetches each sealeddeck URL, parses picks.csv
 * for each draft, matches by card overlap, and writes:
 *   - data/<draft>/decklists.csv
 *   - data/<draft>/decks/<seat>.json
 *
 * Usage: npx tsx scripts/match-decklists.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseDraftPicks, normalizeCardName } from "../src/core/parseCsv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DECKLISTS_FILE = join(__dirname, "..", "data", "decklists.txt");

const BASIC_LANDS = new Set([
  "plains",
  "island",
  "swamp",
  "mountain",
  "forest",
  "wastes",
]);

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
  pool: Set<string>; // deck + sideboard + hidden, minus basics, normalized
}

// Parse decklists.txt into draft groups
function parseDecklistsFile(
  content: string
): Map<string, string[]> {
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

// Fetch a sealeddeck.tech pool
async function fetchDeck(id: string): Promise<SealedDeckResponse> {
  const url = `https://sealeddeck.tech/api/pools/${id}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return (await response.json()) as SealedDeckResponse;
}

// Normalize a card name for matching (lowercase, strip numeric suffixes)
function normalizeForMatch(name: string): string {
  return normalizeCardName(name).toLowerCase();
}

// Extract non-basic card names from a sealeddeck response
function extractPool(response: SealedDeckResponse): Set<string> {
  const pool = new Set<string>();
  const allCards = [
    ...response.deck,
    ...response.sideboard,
    ...(response.hidden || []),
  ];
  for (const card of allCards) {
    const normalized = normalizeForMatch(card.name);
    if (!BASIC_LANDS.has(normalized)) {
      pool.add(normalized);
    }
  }
  return pool;
}

// Extract proper-case card names for a zone
function extractZoneCards(
  cards: SealedDeckCard[],
  scryfallNames: Map<string, string>
): string[] {
  const result: string[] = [];
  for (const card of cards) {
    const normalized = normalizeForMatch(card.name);
    if (BASIC_LANDS.has(normalized)) continue;
    // Use proper-case name from Scryfall cache if available, otherwise title-case
    const properName = scryfallNames.get(normalized) || card.name;
    for (let i = 0; i < card.count; i++) {
      result.push(properName);
    }
  }
  return result.sort();
}

// Parse picks.csv and get each seat's cards
function getSeatPicks(
  draftFolder: string
): Map<number, Set<string>> {
  const picksPath = join(DATA_DIR, draftFolder, "picks.csv");
  const csv = readFileSync(picksPath, "utf-8");
  const { picks } = parseDraftPicks(csv, draftFolder);

  const seatPicks = new Map<number, Set<string>>();
  for (const pick of picks) {
    const seat = pick.seat + 1; // Convert 0-indexed to 1-indexed
    if (!seatPicks.has(seat)) {
      seatPicks.set(seat, new Set());
    }
    seatPicks.get(seat)!.add(normalizeForMatch(pick.cardName));
  }

  return seatPicks;
}

// Build a map of normalized names to proper-case names from picks
function getProperNames(draftFolder: string): Map<string, string> {
  const picksPath = join(DATA_DIR, draftFolder, "picks.csv");
  const csv = readFileSync(picksPath, "utf-8");
  const { picks } = parseDraftPicks(csv, draftFolder);

  const names = new Map<string, string>();
  for (const pick of picks) {
    const normalized = normalizeForMatch(pick.cardName);
    if (!names.has(normalized)) {
      names.set(normalized, normalizeCardName(pick.cardName));
    }
  }
  return names;
}

// Match decklists to seats
function matchDecksToSeats(
  decklists: DecklistEntry[],
  seatPicks: Map<number, Set<string>>
): Map<number, DecklistEntry> {
  const assignments = new Map<number, DecklistEntry>();

  for (const decklist of decklists) {
    let bestSeat = -1;
    let bestScore = 0;

    for (const [seat, picks] of seatPicks) {
      const overlap = [...decklist.pool].filter((c) => picks.has(c)).length;
      const score = picks.size > 0 ? overlap / picks.size : 0;

      if (score > bestScore) {
        bestScore = score;
        bestSeat = seat;
      }
    }

    if (bestScore < 0.5) {
      console.warn(
        `  WARNING: Low match score for ${decklist.sealeddeckId}: ${(bestScore * 100).toFixed(1)}% (best seat: ${bestSeat})`
      );
    }

    // Later decklists overwrite earlier ones for the same seat
    if (assignments.has(bestSeat)) {
      const prev = assignments.get(bestSeat)!;
      console.log(
        `  Seat ${bestSeat}: ${prev.sealeddeckId} replaced by ${decklist.sealeddeckId} (later submission)`
      );
    }

    assignments.set(bestSeat, decklist);
  }

  return assignments;
}

// Resolve draft folder name from label in decklists.txt
function resolveDraftFolder(label: string): string | null {
  // Direct match
  if (existsSync(join(DATA_DIR, label))) return label;

  // Try hyphenated version
  const hyphenated = label.replace(/\s+/g, "-");
  if (existsSync(join(DATA_DIR, hyphenated))) return hyphenated;

  return null;
}

// Main
async function main() {
  const content = readFileSync(DECKLISTS_FILE, "utf-8");
  const drafts = parseDecklistsFile(content);

  console.log(`Found ${drafts.size} drafts in decklists.txt\n`);

  for (const [label, urls] of drafts) {
    const folder = resolveDraftFolder(label);
    if (!folder) {
      console.error(`ERROR: No data folder found for "${label}"`);
      continue;
    }

    console.log(`\n=== ${label} (${folder}) — ${urls.length} links ===`);

    // Extract sealeddeck IDs from URLs
    const ids = urls.map((url) => {
      const match = url.match(/sealeddeck\.tech\/(.+)$/);
      return match ? match[1] : url;
    });

    // Fetch all decklists
    const decklists: DecklistEntry[] = [];
    for (const id of ids) {
      try {
        console.log(`  Fetching ${id}...`);
        const response = await fetchDeck(id);
        const pool = extractPool(response);

        decklists.push({
          sealeddeckId: id,
          url: `https://sealeddeck.tech/${id}`,
          deck: response.deck.map((c) => c.name),
          sideboard: [
            ...response.sideboard.map((c) => c.name),
            ...(response.hidden || []).map((c) => c.name),
          ],
          pool,
        });

        // Rate limit: sealeddeck.tech is a small site
        await new Promise((r) => setTimeout(r, 200));
      } catch (error) {
        console.error(`  ERROR fetching ${id}: ${error}`);
      }
    }

    // Parse picks
    const seatPicks = getSeatPicks(folder);
    const properNames = getProperNames(folder);

    console.log(`  ${seatPicks.size} seats in picks.csv`);

    // Match decklists to seats
    const assignments = matchDecksToSeats(decklists, seatPicks);

    // Report matches
    console.log(`  Matched ${assignments.size} decklists to seats:`);
    for (const [seat, entry] of [...assignments].sort(
      ([a], [b]) => a - b
    )) {
      const overlap = [...entry.pool].filter(
        (c) => seatPicks.get(seat)?.has(c) ?? false
      ).length;
      const total = seatPicks.get(seat)?.size ?? 0;
      console.log(
        `    Seat ${seat}: ${entry.sealeddeckId} (${overlap}/${total} cards match)`
      );
    }

    // Write decklists.csv
    const csvLines = ["seat,sealeddeck_id"];
    for (const [seat, entry] of [...assignments].sort(
      ([a], [b]) => a - b
    )) {
      csvLines.push(`${seat},${entry.sealeddeckId}`);
    }
    const csvPath = join(DATA_DIR, folder, "decklists.csv");
    writeFileSync(csvPath, csvLines.join("\n") + "\n");
    console.log(`  Wrote ${csvPath}`);

    // Write deck JSON files
    const decksDir = join(DATA_DIR, folder, "decks");
    mkdirSync(decksDir, { recursive: true });

    for (const [seat, entry] of assignments) {
      const deckCards = extractZoneCards(
        entry.deck.map((name) => ({ name, count: 1 })),
        properNames
      );
      const sideboardCards = extractZoneCards(
        entry.sideboard.map((name) => ({ name, count: 1 })),
        properNames
      );

      const deckFile = join(decksDir, `${seat}.json`);
      writeFileSync(
        deckFile,
        JSON.stringify(
          {
            sealeddeck_id: entry.sealeddeckId,
            deck: deckCards,
            sideboard: sideboardCards,
          },
          null,
          2
        ) + "\n"
      );
    }
    console.log(`  Wrote ${assignments.size} deck files to ${decksDir}/`);
  }

  console.log("\nDone!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
