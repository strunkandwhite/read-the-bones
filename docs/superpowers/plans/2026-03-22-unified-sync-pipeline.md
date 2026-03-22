# Unified Sync Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CSV-on-disk ingestion pipeline with a unified sync that flows directly from Google Sheets to Turso, using per-domain hashing and batch writes.

**Architecture:** New `src/core/db/sync/` module handles the unified pipeline. A new row-based parser replaces CSV parsing. Per-domain hashing (pool, picks, matches) determines what to skip vs. replace. All DB writes use `client.batch()`. CLI commands (`draft:create`, `draft:reset`, `sync`, `decklists`) replace the old scripts. Old ingest code is deleted after the new pipeline is verified.

**Tech Stack:** TypeScript, libsql/Turso (batch API), google-spreadsheet, vitest

**Spec:** `docs/superpowers/specs/2026-03-22-unified-sync-pipeline-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/core/parseSheetRows.ts` | Parse raw Sheets row arrays into picks, pool, matches (replaces parseCsv.ts + parseMatches.ts) |
| `src/core/db/sync/index.ts` | Unified sync orchestrator: fetch Sheets → hash → compare → replace |
| `src/core/db/sync/domains.ts` | Per-domain hash computation, comparison, and replacement |
| `src/core/db/sync/batch.ts` | Batch insert operations for picks, matches, cube snapshot cards, deck cards |
| `src/core/db/sync/card-cache.ts` | Cross-draft card resolution cache with bulk load + batch insert |
| `scripts/draft-create.ts` | CLI: `pnpm draft:create` |
| `scripts/draft-reset.ts` | CLI: `pnpm draft:reset` |
| `scripts/sync.ts` | CLI: `pnpm sync` |
| `scripts/decklists.ts` | CLI: `pnpm decklists` |
| `src/core/parseSheetRows.test.ts` | Tests for row-based parsing |
| `src/core/db/sync/__tests__/domains.test.ts` | Tests for per-domain hashing and comparison |
| `src/core/db/sync/__tests__/batch.test.ts` | Tests for batch operations |
| `src/core/db/sync/__tests__/card-cache.test.ts` | Tests for card resolution cache |
| `src/core/db/sync/__tests__/sync.test.ts` | Integration tests for the unified pipeline |

### Modified Files

| File | Changes |
|------|---------|
| `src/core/sheets.ts` | Export `fetchDraftTabsRaw()` returning raw `string[][]` arrays per tab |
| `src/core/sync.ts` | Replace `parseCsv` dependency with `parseSheetRows`; change `incrementalIngest` to accept rows instead of CSV |
| `src/core/db/ingest/utils.ts` | Keep `generateOracleId`, `computeCubeHash`, `log`, `logIndent`. Remove `computeImportHash`, `hashFile`, `IngestDraftMetadata`. Note: `normalizeCardName` and `cardNameKey` move to `parseSheetRows.ts` since they're consumed by `getCards.ts`, `calculateStats.ts`, `build/scryfall.ts`, and `db/ingest/scryfall.ts` |
| `src/core/db/ingest/db-helpers.ts` | Add `resetDraft()` (expanded `deleteDraft` that also clears `privacy_opt_outs` and domain hashes). Keep `ensureCard`, `ensureCubeSnapshot`, `insertOptOuts` |
| `src/core/getDraftStats.ts` | Remove `ingestionHash` from response (no longer reading `last_hash` from `ingestion_meta`) |
| `src/core/getCards.ts` | Remove `ingestionHash` from response |
| `src/core/db/schema.sql` | Add `pool_hash`, `picks_hash`, `matches_hash` to `drafts`; drop `import_hash` |
| `src/app/api/sync/route.ts` | Use `fetchDraftTabsRaw()` + row-based parsing instead of `fetchDraftFromSheet()` + CSV |
| `package.json` | Update scripts: add `sync`, `draft:create`, `draft:reset`, `decklists`; remove `sync-sheets`, `ingest`, `add-draft`, `predev` |

### Deleted Files

| File | Replaced By |
|------|-------------|
| `src/core/parseCsv.ts` | `src/core/parseSheetRows.ts` |
| `src/core/parseCsv.test.ts` | `src/core/parseSheetRows.test.ts` |
| `src/core/parseMatches.ts` | `src/core/parseSheetRows.ts` |
| `src/core/parseMatches.test.ts` | `src/core/parseSheetRows.test.ts` |
| `src/core/db/ingest/discover.ts` | Drafts come from Turso |
| `src/core/db/ingest/full-import.ts` | `src/core/db/sync/` |
| `src/core/db/ingest/incremental.ts` | `src/core/db/sync/` |
| `src/core/db/ingest/index.ts` | `src/core/db/sync/index.ts` |
| `src/core/db/ingest.ts` | `scripts/sync.ts` |
| `src/core/db/__tests__/incremental-ingest.test.ts` | `src/core/db/sync/__tests__/` |
| `src/core/db/__tests__/ingest-sheet-id.test.ts` | No longer needed |
| `src/core/db/__tests__/ingest-bans.test.ts` | Covered by new sync tests |
| `scripts/sync-sheets.ts` | `scripts/sync.ts` |
| `scripts/match-decklists.ts` | `scripts/decklists.ts` |
| `scripts/add-draft.ts` | `scripts/draft-create.ts` |
| `src/build/sheets.ts` | Dead code (was re-export shim) |
| `src/build/sheets.test.ts` | Dead code |

---

## Chunk 1: Foundation — Schema, Parsing, Hashing

### Task 1: Schema Migration

Add per-domain hash columns to the `drafts` table and drop `import_hash`.

**Files:**
- Modify: `src/core/db/schema.sql`
- Create: migration script (check if `src/core/db/migrations/` exists; if not, create the migration as a standalone script in `scripts/`)

- [ ] **Step 1: Check existing migration structure**

Run: `ls src/core/db/migrations/ 2>/dev/null || echo "No migrations directory"`

The project may use `src/core/db/migrate.ts` directly instead of a migrations directory. Check how existing migrations work and follow the same pattern.

- [ ] **Step 2: Update schema.sql**

In `src/core/db/schema.sql`, modify the `drafts` table definition:

```sql
-- Replace import_hash with per-domain hashes
-- Remove: import_hash TEXT,
-- Add:
pool_hash TEXT,
picks_hash TEXT,
matches_hash TEXT,
```

- [ ] **Step 3: Write migration script**

Create a migration file that:
1. Adds `pool_hash`, `picks_hash`, `matches_hash` columns to `drafts`
2. Drops `import_hash` column (SQLite doesn't support DROP COLUMN directly before 3.35.0 — check if Turso supports it; if not, recreate the table)
3. Deletes the `last_hash` key from `ingestion_meta`

```typescript
import { createClient } from "../client";
import { loadEnv } from "../ingest/utils";

async function migrate() {
  loadEnv();
  const client = createClient();

  // SQLite 3.35+ supports ALTER TABLE DROP COLUMN
  await client.batch([
    { sql: "ALTER TABLE drafts ADD COLUMN pool_hash TEXT", args: [] },
    { sql: "ALTER TABLE drafts ADD COLUMN picks_hash TEXT", args: [] },
    { sql: "ALTER TABLE drafts ADD COLUMN matches_hash TEXT", args: [] },
    { sql: "ALTER TABLE drafts DROP COLUMN import_hash", args: [] },
    { sql: "DELETE FROM ingestion_meta WHERE key = 'last_hash'", args: [] },
  ]);

  console.log("Migration complete: per-domain hashes added, import_hash removed");
}

migrate().catch(console.error);
```

- [ ] **Step 4: Run migration locally**

Run: `npx tsx src/core/db/migrations/003-per-domain-hashes.ts`
Expected: "Migration complete" message, no errors.

- [ ] **Step 5: Verify schema**

Run: `turso db shell read-the-bones ".schema drafts"`
Expected: `pool_hash`, `picks_hash`, `matches_hash` columns present; `import_hash` absent.

- [ ] **Step 6: Commit**

```bash
git add src/core/db/schema.sql src/core/db/migrations/003-per-domain-hashes.ts
git commit -m "Add per-domain hash columns to drafts table, drop import_hash"
```

---

### Task 2: Row-Based Parsing Module

Replace `parseCsv.ts` and `parseMatches.ts` with a module that operates on `string[][]` row arrays (what the Sheets API returns natively).

**Files:**
- Create: `src/core/parseSheetRows.ts`
- Create: `src/core/parseSheetRows.test.ts`
- Reference: `src/core/parseCsv.ts` (for logic to port)
- Reference: `src/core/parseMatches.ts` (for logic to port)

The key insight: `parseCsv.ts` parses CSV strings back into rows, then processes the rows. We skip the CSV step and process rows directly. The actual row-processing logic (drafter name extraction from row 3, pick data from row 4+, arrow detection, `✪` marker, color columns) stays the same.

- [ ] **Step 1: Write failing tests for `parsePoolRows`**

Port the pool parsing tests from `parseCsv.test.ts`. The input changes from CSV strings to `string[][]`.

```typescript
// src/core/parseSheetRows.test.ts
import { describe, it, expect } from "vitest";
import { parsePoolRows } from "./parseSheetRows";

describe("parsePoolRows", () => {
  // Pool sheet format: Column A = checkmark (✓ if picked), Column B = card name
  // Row 0 is a header row (skip)
  it("extracts card names from column B, skipping header row", () => {
    const rows = [
      ["", "Card Name"],           // header
      ["✓", "Lightning Bolt"],
      ["", "Counterspell"],
      ["✓", "Dark Ritual"],
    ];
    expect(parsePoolRows(rows)).toEqual(["Lightning Bolt", "Counterspell", "Dark Ritual"]);
  });

  it("skips rows with empty card names", () => {
    const rows = [
      ["", "Card Name"],
      ["✓", "Lightning Bolt"],
      ["", ""],
      ["", "Counterspell"],
    ];
    expect(parsePoolRows(rows)).toEqual(["Lightning Bolt", "Counterspell"]);
  });

  it("normalizes card names (strips numeric suffixes)", () => {
    const rows = [
      ["", "Card Name"],
      ["", "Scalding Tarn 2"],
    ];
    expect(parsePoolRows(rows)).toEqual(["Scalding Tarn"]);
  });
});
```

Run: `pnpm vitest run src/core/parseSheetRows.test.ts`
Expected: FAIL (module doesn't exist)

- [ ] **Step 2: Implement `parsePoolRows`**

Pool sheet format: Column A = checkmark, Column B (index 1) = card name. Row 0 is header.

```typescript
// src/core/parseSheetRows.ts

export function parsePoolRows(rows: string[][]): string[] {
  // Skip header row (index 0), read card names from column B (index 1)
  const cards: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;
    const cardName = row[1]?.trim();
    if (!cardName) continue;
    const normalized = normalizeCardName(cardName);
    if (normalized) cards.push(normalized);
  }
  return cards;
}
```

Run: `pnpm vitest run src/core/parseSheetRows.test.ts`
Expected: PASS

- [ ] **Step 3: Write failing tests for `parsePickRows`**

Port the pick parsing tests. Key behaviors: row 3 has drafter names starting at column C (index 2), rows 4+ have picks, column A has pick number, arrow characters in column B, color columns on the right, `✪` marker detection, card name normalization (strip numeric suffixes).

```typescript
import { parsePickRows, CardPick } from "./parseSheetRows";

describe("parsePickRows", () => {
  // Minimal 2-drafter sheet layout:
  // Row 0-1: headers (ignored)
  // Row 2: ["", "", "Alice", "Bob"]
  // Row 3+: ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"]
  const baseRows: string[][] = [
    ["", "", "Rotisserie Draft"],
    ["", ""],
    ["", "", "Alice", "Bob"],
    ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
    ["2", "↪", "Dark Ritual", "Swords to Plowshares", "B", "W"],
  ];

  it("extracts picks with correct seat and position", () => {
    const result = parsePickRows(baseRows, "test-draft");
    expect(result.drafterNames).toEqual(["Alice", "Bob"]);
    expect(result.numDrafters).toBe(2);
    expect(result.picks).toHaveLength(4);
    expect(result.picks[0]).toMatchObject({
      cardName: "Lightning Bolt",
      pickPosition: 1,
      seat: 0,
      draftId: "test-draft",
    });
    expect(result.picks[1]).toMatchObject({
      cardName: "Counterspell",
      pickPosition: 1,
      seat: 1,
    });
  });

  it("detects draft completion via ✪ marker", () => {
    const rows = [
      ...baseRows,
      ["✪", "", "", ""],
    ];
    const result = parsePickRows(rows, "test-draft");
    expect(result.isComplete).toBe(true);
  });

  it("normalizes card names by stripping numeric suffixes", () => {
    const rows = [
      ["", "", "Rotisserie Draft"],
      ["", ""],
      ["", "", "Alice"],
      ["1", "→", "Scalding Tarn 2", "R"],
    ];
    const result = parsePickRows(rows, "test-draft");
    expect(result.picks[0].cardName).toBe("Scalding Tarn");
  });
});
```

Run: `pnpm vitest run src/core/parseSheetRows.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement `parsePickRows`**

Port the logic from `parseCsv.ts`'s `parseDraftPicks()`. Key differences:
- Input is `string[][]` instead of CSV string
- No CSV parsing step needed
- Same row layout logic: drafter names at row index 2 starting at column 2, picks at row 3+

Reuse `normalizeCardName` and `isArrow` from `parseCsv.ts` (copy them into the new module — they're small utility functions).

```typescript
export interface CardPick {
  cardName: string;
  pickPosition: number;
  copyNumber: number;
  wasPicked: boolean;
  draftId: string;
  seat: number;
  color: string;
}

export interface ParsedPicks {
  picks: CardPick[];
  numDrafters: number;
  drafterNames: string[];
  isComplete: boolean;
  doublePickStartsAfterRound: number | null;
}

export function normalizeCardName(cardName: string): string {
  return cardName.replace(/\s+\d+$/, "");
}

function isArrow(value: string): boolean {
  return ["→", "↪", "↩", "✪"].includes(value.trim());
}

export function parsePickRows(rows: string[][], draftId: string): ParsedPicks {
  // Port logic from parseCsv.parseDraftPicks, operating on rows directly
  // Row 2 (index 2): drafter names starting at column 2
  // Row 3+ (index 3+): pick data
  // ... (full implementation ported from parseCsv.ts)
}
```

The full implementation should mirror `parseDraftPicks` line by line, but skip the CSV-to-rows step. Read `parseCsv.ts:98-280` for the exact logic.

Run: `pnpm vitest run src/core/parseSheetRows.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for `parseMatchRows`**

Port from `parseMatches.test.ts`. The actual match sheet format is **row-per-match**, not a grid:
- Rows 0-2: headers (skip)
- Row 3+: match data in columns B-F (indices 1-5)
  - Column B (index 1): Player1 name
  - Column C (index 2): Player1 games won
  - Column D (index 3): "VS" (literal marker)
  - Column E (index 4): Player2 games won
  - Column F (index 5): Player2 name

Input changes from CSV string + name-to-seat map to `string[][]` + drafter names array.

```typescript
import { parseMatchRows } from "./parseSheetRows";

describe("parseMatchRows", () => {
  it("parses row-per-match results", () => {
    // 3 header rows (skipped) + match data rows
    const rows = [
      ["", "Title Row"],                                          // Row 0: title
      [""],                                                        // Row 1: empty
      ["", "Player 1", "Games", "", "Games", "Player 2"],        // Row 2: header
      ["", "Alice", "2", "VS", "1", "Bob"],                      // Row 3: match
      ["", "Alice", "0", "VS", "2", "Charlie"],                  // Row 4: match
      ["", "Bob", "2", "VS", "0", "Charlie"],                    // Row 5: match
    ];
    const drafterNames = ["Alice", "Bob", "Charlie"];
    const matches = parseMatchRows(rows, drafterNames);

    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({
      seat1: 0, seat2: 1, seat1GamesWon: 2, seat2GamesWon: 1,
    });
  });

  it("skips rows without VS marker", () => {
    const rows = [
      [""], [""], [""],
      ["", "Alice", "2", "VS", "1", "Bob"],
      ["", "invalid", "row", "without", "vs"],
    ];
    const matches = parseMatchRows(rows, ["Alice", "Bob"]);
    expect(matches).toHaveLength(1);
  });

  it("returns empty array for null/missing rows", () => {
    expect(parseMatchRows(null, ["Alice"])).toEqual([]);
    expect(parseMatchRows([], ["Alice"])).toEqual([]);
  });
});
```

Run: `pnpm vitest run src/core/parseSheetRows.test.ts`
Expected: FAIL

- [ ] **Step 6: Implement `parseMatchRows`**

Port from `parseMatches.ts`'s `parseMatches()`, adapted for row arrays. The logic is nearly identical — just skip the Papa.parse step and operate on `rows` directly.

```typescript
export interface MatchResult {
  seat1: number;
  seat2: number;
  seat1GamesWon: number;
  seat2GamesWon: number;
}

export function parseMatchRows(
  rows: string[][] | null,
  drafterNames: string[],
): MatchResult[] {
  if (!rows || rows.length < 4) return [];

  // Build name→seat map from drafterNames (0-indexed)
  const nameToSeat = new Map<string, number>();
  drafterNames.forEach((name, i) => nameToSeat.set(name.trim(), i));

  const matches: MatchResult[] = [];

  // Row-per-match format: rows 3+ have match data in columns B-F (indices 1-5)
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 6) continue;

    const player1Name = row[1]?.trim();
    const player1Games = parseInt(row[2]?.trim(), 10);
    const vsMarker = row[3]?.trim();
    const player2Games = parseInt(row[4]?.trim(), 10);
    const player2Name = row[5]?.trim();

    if (!player1Name || !player2Name) continue;
    if (vsMarker !== "VS") continue;
    if (isNaN(player1Games) || isNaN(player2Games)) continue;

    const seat1 = nameToSeat.get(player1Name);
    const seat2 = nameToSeat.get(player2Name);
    if (seat1 === undefined || seat2 === undefined) continue;

    matches.push({ seat1, seat2, seat1GamesWon: player1Games, seat2GamesWon: player2Games });
  }

  return matches;
}
```

Run: `pnpm vitest run src/core/parseSheetRows.test.ts`
Expected: PASS

- [ ] **Step 7: Port remaining edge-case tests**

Port all remaining tests from `parseCsv.test.ts` and `parseMatches.test.ts` that cover edge cases:
- Double-pick rounds detection
- Empty pick slots
- Color column extraction
- Unpicked cards (pool size penalty)
- Match result edge cases (draws, missing cells)

Run full test suite to verify: `pnpm vitest run src/core/parseSheetRows.test.ts`

- [ ] **Step 8: Commit**

```bash
git add src/core/parseSheetRows.ts src/core/parseSheetRows.test.ts
git commit -m "Add row-based sheet parsing module (replaces CSV parsing)"
```

---

### Task 3: Per-Domain Hashing

**Files:**
- Create: `src/core/db/sync/domains.ts`
- Create: `src/core/db/sync/__tests__/domains.test.ts`
- Reference: `src/core/db/ingest/utils.ts` (for `computeCubeHash`)

- [ ] **Step 1: Write failing tests for hash functions**

```typescript
// src/core/db/sync/__tests__/domains.test.ts
import { describe, it, expect } from "vitest";
import { hashPicks, hashPool, hashMatches } from "../domains";
import type { CardPick, MatchResult } from "../../../parseSheetRows";

describe("hashPool", () => {
  it("produces consistent hash for same cards regardless of order", () => {
    const a = hashPool(["Bolt", "Counterspell", "Ritual"]);
    const b = hashPool(["Ritual", "Bolt", "Counterspell"]);
    expect(a).toBe(b);
  });

  it("produces different hash for different pools", () => {
    const a = hashPool(["Bolt", "Counterspell"]);
    const b = hashPool(["Bolt", "Ritual"]);
    expect(a).not.toBe(b);
  });
});

describe("hashPicks", () => {
  it("produces consistent hash for same picks", () => {
    const picks: CardPick[] = [
      { cardName: "Bolt", pickPosition: 1, seat: 0, copyNumber: 1, wasPicked: true, draftId: "d", color: "R" },
      { cardName: "Counter", pickPosition: 2, seat: 1, copyNumber: 1, wasPicked: true, draftId: "d", color: "U" },
    ];
    expect(hashPicks(picks)).toBe(hashPicks([...picks]));
  });

  it("detects changed pick data", () => {
    const a: CardPick[] = [
      { cardName: "Bolt", pickPosition: 1, seat: 0, copyNumber: 1, wasPicked: true, draftId: "d", color: "R" },
    ];
    const b: CardPick[] = [
      { cardName: "Bolt", pickPosition: 1, seat: 1, copyNumber: 1, wasPicked: true, draftId: "d", color: "R" },
    ];
    expect(hashPicks(a)).not.toBe(hashPicks(b));
  });
});

describe("hashMatches", () => {
  it("produces consistent hash for same matches regardless of order", () => {
    const matches: MatchResult[] = [
      { seat1: 1, seat2: 2, seat1GamesWon: 2, seat2GamesWon: 1 },
      { seat1: 1, seat2: 3, seat1GamesWon: 0, seat2GamesWon: 2 },
    ];
    const reversed = [...matches].reverse();
    expect(hashMatches(matches)).toBe(hashMatches(reversed));
  });
});
```

Run: `pnpm vitest run src/core/db/sync/__tests__/domains.test.ts`
Expected: FAIL

- [ ] **Step 2: Implement hash functions**

```typescript
// src/core/db/sync/domains.ts
import { createHash } from "crypto";
import type { CardPick, MatchResult } from "../../parseSheetRows";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function hashPool(cardNames: string[]): string {
  const sorted = [...cardNames].sort();
  return sha256(sorted.join("\n"));
}

export function hashPicks(picks: CardPick[]): string {
  const sorted = [...picks].sort((a, b) => a.pickPosition - b.pickPosition || a.seat - b.seat);
  const lines = sorted.map((p) => `${p.pickPosition}:${p.seat}:${p.cardName}`);
  return sha256(lines.join("\n"));
}

export function hashMatches(matches: MatchResult[]): string {
  const sorted = [...matches].sort((a, b) => a.seat1 - b.seat1 || a.seat2 - b.seat2);
  const lines = sorted.map((m) => `${m.seat1}:${m.seat2}:${m.seat1GamesWon}:${m.seat2GamesWon}`);
  return sha256(lines.join("\n"));
}
```

Run: `pnpm vitest run src/core/db/sync/__tests__/domains.test.ts`
Expected: PASS

- [ ] **Step 3: Write tests for domain comparison logic**

```typescript
describe("compareDomainHash", () => {
  it("returns 'skip' when hashes match", () => {
    expect(compareDomainHash("abc123", "abc123")).toBe("skip");
  });

  it("returns 'replace' when hashes differ", () => {
    expect(compareDomainHash("abc123", "def456")).toBe("replace");
  });

  it("returns 'replace' when stored hash is null (first sync)", () => {
    expect(compareDomainHash("abc123", null)).toBe("replace");
  });
});
```

- [ ] **Step 4: Implement `compareDomainHash`**

```typescript
export function compareDomainHash(
  newHash: string,
  storedHash: string | null,
): "skip" | "replace" {
  return newHash === storedHash ? "skip" : "replace";
}
```

Run: `pnpm vitest run src/core/db/sync/__tests__/domains.test.ts`
Expected: PASS

- [ ] **Step 5: Add `getDomainHashes` and `updateDomainHashes` DB functions**

These read/write the per-domain hash columns on the `drafts` table.

```typescript
import type { Client } from "@libsql/client";

export interface DomainHashes {
  poolHash: string | null;
  picksHash: string | null;
  matchesHash: string | null;
}

export async function getDomainHashes(client: Client, draftId: string): Promise<DomainHashes | null> {
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
  if (hashes.poolHash !== undefined) { sets.push("pool_hash = ?"); args.push(hashes.poolHash); }
  if (hashes.picksHash !== undefined) { sets.push("picks_hash = ?"); args.push(hashes.picksHash); }
  if (hashes.matchesHash !== undefined) { sets.push("matches_hash = ?"); args.push(hashes.matchesHash); }
  if (sets.length === 0) return;
  args.push(draftId);
  await client.execute({ sql: `UPDATE drafts SET ${sets.join(", ")} WHERE draft_id = ?`, args });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/core/db/sync/domains.ts src/core/db/sync/__tests__/domains.test.ts
git commit -m "Add per-domain hashing and comparison for unified sync"
```

---

### Task 4: Sheets Refactoring

Export raw row arrays from `sheets.ts` so the sync pipeline can bypass CSV serialization.

**Files:**
- Modify: `src/core/sheets.ts`

- [ ] **Step 1: Add `fetchDraftTabsRaw` function**

This function returns raw `string[][]` arrays for each tab, without CSV conversion. Add alongside the existing `fetchDraftFromSheet` (which remains for now — the old code still uses it until we delete it).

```typescript
export interface DraftSheetRawData {
  picks: string[][] | null;
  pool: string[][] | null;
  matches: string[][] | null;
}

export async function fetchDraftTabsRaw(
  sheetId: string,
  apiKey: string,
): Promise<DraftSheetRawData> {
  const doc = new GoogleSpreadsheet(sheetId, { apiKey });
  await doc.loadInfo();

  return {
    picks: await fetchSheetTab(doc, TAB_NAMES.picks),
    pool: await fetchSheetTab(doc, TAB_NAMES.pool),
    matches: await fetchSheetTab(doc, TAB_NAMES.matches),
  };
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `pnpm vitest run src/build/sheets.test.ts`
Expected: PASS (no existing behavior changed)

- [ ] **Step 3: Commit**

```bash
git add src/core/sheets.ts
git commit -m "Export fetchDraftTabsRaw for direct row-based sync"
```

---

## Chunk 2: Database Operations — Batch Writes, Card Cache

### Task 5: Batch DB Operations

Replace individual `client.execute()` loops with `client.batch()` calls.

**Files:**
- Create: `src/core/db/sync/batch.ts`
- Create: `src/core/db/sync/__tests__/batch.test.ts`
- Reference: `src/core/db/ingest/db-helpers.ts` (for current insert logic)

- [ ] **Step 1: Write failing tests for `batchInsertPicks`**

```typescript
// src/core/db/sync/__tests__/batch.test.ts
import { describe, it, expect, vi } from "vitest";
import { batchInsertPicks } from "../batch";

describe("batchInsertPicks", () => {
  it("builds batch statements for all picks", async () => {
    const mockClient = {
      batch: vi.fn().mockResolvedValue([]),
    };
    const picks = [
      { draftId: "d1", pickN: 1, seat: 1, cardId: 100 },
      { draftId: "d1", pickN: 2, seat: 2, cardId: 200 },
    ];

    await batchInsertPicks(mockClient as any, picks);

    expect(mockClient.batch).toHaveBeenCalledTimes(1);
    const statements = mockClient.batch.mock.calls[0][0];
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("INSERT INTO pick_events");
  });

  it("does nothing for empty picks array", async () => {
    const mockClient = { batch: vi.fn() };
    await batchInsertPicks(mockClient as any, []);
    expect(mockClient.batch).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm vitest run src/core/db/sync/__tests__/batch.test.ts`
Expected: FAIL

- [ ] **Step 2: Implement batch insert functions**

```typescript
// src/core/db/sync/batch.ts
import type { Client } from "@libsql/client";

interface PickInsert {
  draftId: string;
  pickN: number;
  seat: number;
  cardId: number;
}

interface MatchInsert {
  draftId: string;
  seat1: number;
  seat2: number;
  seat1GamesWon: number;
  seat2GamesWon: number;
}

interface DeckCardInsert {
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
```

Run: `pnpm vitest run src/core/db/sync/__tests__/batch.test.ts`
Expected: PASS

- [ ] **Step 3: Write tests for remaining batch functions**

Add tests for `batchInsertMatches`, `batchInsertDeckCards`, `batchInsertCubeSnapshotCards`, `deleteDomainData`. Follow the same mock pattern.

- [ ] **Step 4: Commit**

```bash
git add src/core/db/sync/batch.ts src/core/db/sync/__tests__/batch.test.ts
git commit -m "Add batch DB operations for picks, matches, deck cards, cube snapshot cards"
```

---

### Task 6: Card Resolution Cache

Bulk-load cards from Turso at sync start, batch-insert new cards, cache across drafts.

**Files:**
- Create: `src/core/db/sync/card-cache.ts`
- Create: `src/core/db/sync/__tests__/card-cache.test.ts`
- Reference: `src/core/db/ingest/db-helpers.ts` (for `ensureCard` logic)
- Reference: `src/core/db/ingest/scryfall.ts` (for Scryfall cache)

- [ ] **Step 1: Write failing tests**

```typescript
// src/core/db/sync/__tests__/card-cache.test.ts
import { describe, it, expect, vi } from "vitest";
import { CardCache } from "../card-cache";

describe("CardCache", () => {
  it("returns card_id for known cards after bulk load", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { card_id: 1, name: "Lightning Bolt" },
          { card_id: 2, name: "Counterspell" },
        ],
      }),
      batch: vi.fn().mockResolvedValue([]),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);

    expect(cache.get("Lightning Bolt")).toBe(1);
    expect(cache.get("Counterspell")).toBe(2);
    expect(cache.get("Unknown Card")).toBeUndefined();
  });

  it("tracks missing cards and batch-inserts them", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      batch: vi.fn().mockResolvedValue([
        { rows: [{ card_id: 10 }] },
        { rows: [{ card_id: 11 }] },
      ]),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);

    cache.markMissing("New Card", "generated:new-card", null);
    cache.markMissing("Other Card", "generated:other-card", null);

    await cache.flushMissing(mockClient as any);

    expect(mockClient.batch).toHaveBeenCalled();
  });
});
```

Run: `pnpm vitest run src/core/db/sync/__tests__/card-cache.test.ts`
Expected: FAIL

- [ ] **Step 2: Implement CardCache**

```typescript
// src/core/db/sync/card-cache.ts
import type { Client } from "@libsql/client";

interface PendingCard {
  oracleId: string;
  name: string;
  scryfallJson: string | null;
}

export class CardCache {
  private nameToId = new Map<string, number>();
  private missing: PendingCard[] = [];

  async loadAll(client: Client): Promise<void> {
    const result = await client.execute({ sql: "SELECT card_id, name FROM cards", args: [] });
    for (const row of result.rows) {
      this.nameToId.set((row.name as string).toLowerCase(), row.card_id as number);
    }
  }

  get(cardName: string): number | undefined {
    return this.nameToId.get(cardName.toLowerCase());
  }

  set(cardName: string, cardId: number): void {
    this.nameToId.set(cardName.toLowerCase(), cardId);
  }

  markMissing(name: string, oracleId: string, scryfallJson: string | null): void {
    if (!this.nameToId.has(name.toLowerCase())) {
      this.missing.push({ oracleId, name, scryfallJson });
    }
  }

  async flushMissing(client: Client): Promise<void> {
    if (this.missing.length === 0) return;

    // Insert all missing cards in a batch, using INSERT OR IGNORE for safety
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

  get size(): number {
    return this.nameToId.size;
  }
}
```

Run: `pnpm vitest run src/core/db/sync/__tests__/card-cache.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/db/sync/card-cache.ts src/core/db/sync/__tests__/card-cache.test.ts
git commit -m "Add cross-draft card resolution cache with bulk load and batch insert"
```

---

## Chunk 3: Sync Pipeline and CLI Commands

### Task 7: Unified Sync Orchestrator

The core of the new pipeline: fetch Sheets data, parse, hash, compare, replace.

**Files:**
- Create: `src/core/db/sync/index.ts`
- Create: `src/core/db/sync/__tests__/sync.test.ts`
- Reference: All previous new modules

- [ ] **Step 1: Define the `syncDraft` function signature and types**

```typescript
// src/core/db/sync/index.ts
import type { Client } from "@libsql/client";
import type { DraftSheetRawData } from "../../sheets";
import type { ParsedPicks, MatchResult } from "../../parseSheetRows";

export interface SyncOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export interface SyncDraftResult {
  draftId: string;
  poolAction: "skip" | "replace";
  picksAction: "skip" | "replace";
  matchesAction: "skip" | "replace";
  picksCount: number;
  matchesCount: number;
  markedComplete: boolean;
  error?: string;
}

export interface SyncRunResult {
  results: SyncDraftResult[];
  errors: string[];
}
```

- [ ] **Step 2: Write integration test for `syncDraft`**

Test the core flow: given fetched Sheets data + a mock DB client, verify it hashes, compares, and calls the right batch operations.

```typescript
// src/core/db/sync/__tests__/sync.test.ts
import { describe, it, expect, vi } from "vitest";
import { syncDraft } from "../index";

describe("syncDraft", () => {
  it("skips all domains when hashes match", async () => {
    // Mock client that returns matching hashes
    // Verify no DELETE or INSERT calls are made
  });

  it("replaces picks when hash differs", async () => {
    // Mock client with different picks_hash
    // Verify DELETE pick_events + batch INSERT called
  });

  it("handles first sync (null hashes) by inserting everything", async () => {
    // Mock client with null hashes
    // Verify all domains get replaced
  });
});
```

- [ ] **Step 3: Implement `syncDraft`**

This is the main function. It orchestrates:
1. Parse raw Sheets data into picks, pool, matches
2. Compute per-domain hashes
3. Read stored hashes from DB
4. For each domain: compare → skip or (delete + batch insert)
5. Update stored hashes
6. Handle opt-outs
7. Detect completion

```typescript
export async function syncDraft(
  client: Client,
  draftId: string,
  sheetData: DraftSheetRawData,
  cardCache: CardCache,
  scryfallCache: Map<string, any>,
  optOutNames: Set<string>,
  options: SyncOptions = {},
): Promise<SyncDraftResult> {
  const result: SyncDraftResult = {
    draftId,
    poolAction: "skip",
    picksAction: "skip",
    matchesAction: "skip",
    picksCount: 0,
    matchesCount: 0,
    markedComplete: false,
  };

  try {
    // Parse sheets data
    const pool = sheetData.pool ? parsePoolRows(sheetData.pool) : [];
    const parsedPicks = sheetData.picks ? parsePickRows(sheetData.picks, draftId) : null;
    const matches = sheetData.picks && sheetData.matches
      ? parseMatchRows(sheetData.matches, parsedPicks?.drafterNames ?? [])
      : [];

    // Compute hashes
    const newHashes = {
      poolHash: pool.length > 0 ? hashPool(pool) : null,
      picksHash: parsedPicks ? hashPicks(parsedPicks.picks) : null,
      matchesHash: matches.length > 0 ? hashMatches(matches) : null,
    };

    // Get stored hashes
    const storedHashes = await getDomainHashes(client, draftId);
    if (!storedHashes) throw new Error(`Draft ${draftId} not found in database`);

    if (options.dryRun) {
      // Report what would change without writing
      result.poolAction = compareDomainHash(newHashes.poolHash, storedHashes.poolHash);
      result.picksAction = compareDomainHash(newHashes.picksHash, storedHashes.picksHash);
      result.matchesAction = compareDomainHash(newHashes.matchesHash, storedHashes.matchesHash);
      return result;
    }

    // Pool domain
    if (pool.length > 0 && compareDomainHash(newHashes.poolHash!, storedHashes.poolHash) === "replace") {
      result.poolAction = "replace";

      // Resolve each pool card to a card_id via cardCache + Scryfall
      const cardIds = new Map<string, { cardId: number; qty: number }>();
      const cardNameCounts = new Map<string, number>();
      for (const name of pool) {
        cardNameCounts.set(name, (cardNameCounts.get(name) || 0) + 1);
      }
      for (const [name, qty] of cardNameCounts) {
        let cardId = cardCache.get(name);
        if (cardId === undefined) {
          const scryfallData = scryfallCache.get(name.toLowerCase());
          const oracleId = scryfallData?.oracle_id ?? generateOracleId(name);
          const displayName = scryfallData?.name ?? name;
          const json = scryfallData ? JSON.stringify(scryfallData) : null;
          cardCache.markMissing(displayName, oracleId, json);
        }
      }
      await cardCache.flushMissing(client);

      // Build cardId map for ensureCubeSnapshot
      for (const [name, qty] of cardNameCounts) {
        const cardId = cardCache.get(name);
        if (cardId !== undefined) {
          cardIds.set(name, { cardId, qty });
        }
      }

      // Create or reuse cube snapshot (existing ensureCubeSnapshot handles dedup by cube hash)
      const cubeHash = computeCubeHash([...cardNameCounts.keys()]);
      const snapshotId = await ensureCubeSnapshot(client, cubeHash, cardIds);

      // Update draft's cube_snapshot_id
      await client.execute({
        sql: "UPDATE drafts SET cube_snapshot_id = ? WHERE draft_id = ?",
        args: [snapshotId, draftId],
      });
    }

    // Picks domain
    if (parsedPicks && compareDomainHash(newHashes.picksHash!, storedHashes.picksHash) === "replace") {
      result.picksAction = "replace";
      await deleteDomainData(client, draftId, "picks");
      // Resolve card names → card_ids using cardCache
      // Build pick inserts, call batchInsertPicks
      result.picksCount = parsedPicks.picks.filter((p) => p.wasPicked).length;

      // Update num_seats and drafter count
      await client.execute({
        sql: "UPDATE drafts SET num_seats = ? WHERE draft_id = ?",
        args: [parsedPicks.numDrafters, draftId],
      });
    }

    // Matches domain
    if (matches.length > 0 && compareDomainHash(newHashes.matchesHash!, storedHashes.matchesHash) === "replace") {
      result.matchesAction = "replace";
      await deleteDomainData(client, draftId, "matches");
      await batchInsertMatches(client, matches.map((m) => ({ draftId, ...m })));
      result.matchesCount = matches.length;
    }

    // Update stored hashes
    await updateDomainHashes(client, draftId, {
      poolHash: newHashes.poolHash,
      picksHash: newHashes.picksHash,
      matchesHash: newHashes.matchesHash,
    });

    // Opt-outs
    if (optOutNames.size > 0 && parsedPicks) {
      await insertOptOuts(client, draftId, parsedPicks.drafterNames, optOutNames);
    }

    // Completion detection
    if (parsedPicks?.isComplete) {
      await client.execute({
        sql: "UPDATE drafts SET is_complete = 1 WHERE draft_id = ?",
        args: [draftId],
      });
      result.markedComplete = true;
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}
```

- [ ] **Step 4: Implement `syncAll` orchestrator**

```typescript
export async function syncAll(
  client: Client,
  options: SyncOptions & { filterDraftId?: string } = {},
): Promise<SyncRunResult> {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_SHEETS_API_KEY not set");

  // Load card cache
  const cardCache = new CardCache();
  await cardCache.loadAll(client);

  // Load Scryfall cache
  const scryfallCache = loadScryfallCache();

  // Load opt-outs
  const optOutNames = loadOptOutNames();

  // Get drafts to sync
  let drafts: Array<{ draftId: string; sheetId: string }>;
  if (options.filterDraftId) {
    const result = await client.execute({
      sql: "SELECT draft_id, sheet_id FROM drafts WHERE draft_id = ?",
      args: [options.filterDraftId],
    });
    drafts = result.rows.map((r) => ({ draftId: r.draft_id as string, sheetId: r.sheet_id as string }));
  } else {
    const result = await client.execute({
      sql: "SELECT draft_id, sheet_id FROM drafts WHERE is_complete = 0 AND sheet_id IS NOT NULL",
      args: [],
    });
    drafts = result.rows.map((r) => ({ draftId: r.draft_id as string, sheetId: r.sheet_id as string }));
  }

  const results: SyncDraftResult[] = [];
  const errors: string[] = [];

  for (const draft of drafts) {
    if (!draft.sheetId) {
      errors.push(`${draft.draftId}: no sheet_id configured`);
      continue;
    }

    try {
      // Fetch ALL Sheets data into memory BEFORE touching DB
      const sheetData = await fetchDraftTabsRaw(draft.sheetId, apiKey);

      // Collect missing Scryfall cards from pool
      if (sheetData.pool) {
        const poolNames = parsePoolRows(sheetData.pool);
        await fetchMissingScryfallCards(scryfallCache, poolNames);
      }

      const result = await syncDraft(
        client, draft.draftId, sheetData, cardCache, scryfallCache, optOutNames, options,
      );
      results.push(result);

      if (result.error) errors.push(`${draft.draftId}: ${result.error}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${draft.draftId}: ${msg}`);
    }
  }

  // Flush any remaining missing cards
  await cardCache.flushMissing(client);

  // Backfill Scryfall data
  await backfillScryfallData(client, scryfallCache);

  return { results, errors };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/core/db/sync/__tests__/sync.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/db/sync/index.ts src/core/db/sync/__tests__/sync.test.ts
git commit -m "Add unified sync orchestrator with per-domain hash comparison"
```

---

### Task 8: CLI Commands — draft:create, draft:reset

**Files:**
- Create: `scripts/draft-create.ts`
- Create: `scripts/draft-reset.ts`
- Modify: `src/core/db/ingest/db-helpers.ts` (add `resetDraft`)

- [ ] **Step 1: Implement `draft:create`**

```typescript
// scripts/draft-create.ts
import { createClient } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseArgs(args: string[]) {
  let name = "", date = "", sheetId = "", bannedCards: string[] = [];
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--name": name = args[++i]; break;
      case "--date": date = args[++i]; break;
      case "--sheet-id": sheetId = args[++i]; break;
      case "--banned-cards": bannedCards = args[++i].split(",").map((s) => s.trim()); break;
    }
  }
  if (!name) throw new Error("--name is required");
  if (!date) throw new Error("--date is required (YYYY-MM-DD)");
  return { name, date, sheetId: sheetId || null, bannedCards };
}

async function main() {
  loadEnv();
  const { name, date, sheetId, bannedCards } = parseArgs(process.argv.slice(2));
  const draftId = slugify(name);
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  await client.execute({
    sql: `INSERT INTO drafts (draft_id, draft_name, draft_date, sheet_id, banned_cards, is_complete, num_seats)
          VALUES (?, ?, ?, ?, ?, 0, 0)`,
    args: [draftId, name, date, sheetId, bannedCards.length > 0 ? JSON.stringify(bannedCards) : null],
  });

  console.log(`Created draft: ${draftId} (${name}, ${date})`);
  if (sheetId) console.log(`  Sheet ID: ${sheetId}`);
  if (bannedCards.length > 0) console.log(`  Banned: ${bannedCards.join(", ")}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Add `resetDraft` to db-helpers**

```typescript
// Add to src/core/db/ingest/db-helpers.ts
export async function resetDraft(client: Client, draftId: string): Promise<void> {
  await client.batch([
    { sql: "DELETE FROM match_events WHERE draft_id = ?", args: [draftId] },
    { sql: "DELETE FROM deck_cards WHERE draft_id = ?", args: [draftId] },
    { sql: "DELETE FROM deck_hashes WHERE draft_id = ?", args: [draftId] },
    { sql: "DELETE FROM pick_events WHERE draft_id = ?", args: [draftId] },
    { sql: "DELETE FROM privacy_opt_outs WHERE draft_id = ?", args: [draftId] },
    {
      sql: "UPDATE drafts SET pool_hash = NULL, picks_hash = NULL, matches_hash = NULL, cube_snapshot_id = NULL, num_seats = 0, is_complete = 0 WHERE draft_id = ?",
      args: [draftId],
    },
  ]);
}
```

- [ ] **Step 3: Implement `draft:reset`**

```typescript
// scripts/draft-reset.ts
import { createClient } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";
import { resetDraft } from "../src/core/db/ingest/db-helpers";

async function main() {
  loadEnv();
  const draftId = process.argv[2];
  if (!draftId) throw new Error("Usage: pnpm draft:reset <draft-name>");

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  // Verify draft exists
  const result = await client.execute({
    sql: "SELECT draft_id, draft_name FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) throw new Error(`Draft not found: ${draftId}`);

  await resetDraft(client, draftId);
  console.log(`Reset draft: ${draftId} — all domain data cleared, hashes nulled`);
  console.log("Run 'pnpm sync' to reimport from Sheets");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: Commit**

```bash
git add scripts/draft-create.ts scripts/draft-reset.ts src/core/db/ingest/db-helpers.ts
git commit -m "Add draft:create and draft:reset CLI commands"
```

---

### Task 9: CLI Entry Point — pnpm sync

**Files:**
- Create: `scripts/sync.ts`

- [ ] **Step 1: Implement sync CLI**

```typescript
// scripts/sync.ts
import { createClient } from "@libsql/client";
import { loadEnv, log } from "../src/core/db/ingest/utils";
import { syncAll } from "../src/core/db/sync/index";

function parseArgs(args: string[]) {
  let filterDraftId: string | undefined;
  let dryRun = false;
  let verbose = false;

  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (!arg.startsWith("-")) filterDraftId = arg;
  }

  return { filterDraftId, dryRun, verbose };
}

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  if (options.dryRun) log("DRY RUN — no changes will be written");

  const { results, errors } = await syncAll(client, options);

  for (const r of results) {
    const actions = [
      r.poolAction === "replace" ? "pool" : null,
      r.picksAction === "replace" ? `picks(${r.picksCount})` : null,
      r.matchesAction === "replace" ? `matches(${r.matchesCount})` : null,
    ].filter(Boolean);

    if (actions.length === 0) {
      log(`${r.draftId}: unchanged`);
    } else {
      log(`${r.draftId}: replaced ${actions.join(", ")}`);
    }
    if (r.markedComplete) log(`  → marked complete`);
    if (r.error) log(`  ⚠ ${r.error}`);
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sync.ts
git commit -m "Add pnpm sync CLI entry point"
```

---

### Task 10: Decklists Pipeline

**Files:**
- Create: `scripts/decklists.ts`
- Reference: `scripts/match-decklists.ts` (for logic to port)

- [ ] **Step 1: Implement decklists CLI**

Port the logic from `scripts/match-decklists.ts` with these changes:
- Read pick data from Turso (not from CSV files) to match decks to seats
- Write deck cards directly to Turso via batch operations (not to JSON files)
- Per-seat hashing continues via `deck_hashes` table

```typescript
// scripts/decklists.ts
import { createClient } from "@libsql/client";
import { loadEnv, log } from "../src/core/db/ingest/utils";
import { batchInsertDeckCards } from "../src/core/db/sync/batch";
import { CardCache } from "../src/core/db/sync/card-cache";

// Port: parseDecklistsFile, fetchDeck, matchDecksToSeats from match-decklists.ts
// Change: getSeatPicks reads from Turso instead of picks.csv
// Change: output goes to deck_cards table via batch insert instead of JSON files

async function getSeatPicks(client: Client, draftId: string): Promise<Map<number, Set<string>>> {
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

// ... rest of the implementation follows match-decklists.ts logic
// but writes to DB instead of files
```

- [ ] **Step 2: Commit**

```bash
git add scripts/decklists.ts
git commit -m "Add pnpm decklists CLI for direct Turso decklist import"
```

---

## Chunk 4: Live Sync Update, Cache Invalidation, Cleanup

### Task 11: Update Live Sync Route

Update `/api/sync` to use `fetchDraftTabsRaw` and row-based parsing instead of `fetchDraftFromSheet` + CSV.

**Files:**
- Modify: `src/app/api/sync/route.ts`
- Modify: `src/core/sync.ts`

- [ ] **Step 1: Update `incrementalIngest` in sync.ts**

Change `incrementalIngest` to accept parsed picks (from `parsePickRows`) instead of a CSV string. The function currently takes `picksCsv: string` and calls `parseDraftPicks(picksCsv, draftId)`. Change it to accept `ParsedPicks` directly.

```typescript
// Before:
export async function incrementalIngest(client: Client, draftId: string, picksCsv: string)

// After:
export async function incrementalIngest(
  client: Client,
  draftId: string,
  parsedPicks: ParsedPicks,
)
```

Update the function body to use `parsedPicks` directly instead of calling `parseDraftPicks`.

- [ ] **Step 2: Update `/api/sync/route.ts`**

Replace `fetchDraftFromSheet` with `fetchDraftTabsRaw`, then parse rows in memory:

```typescript
// Before:
import { fetchDraftFromSheet } from "@/core/sheets";
// ...
const sheetData = await fetchDraftFromSheet(draft.sheetId, apiKey);
const result = await incrementalIngest(client, draft.draftId, sheetData.picks!);

// After:
import { fetchDraftTabsRaw } from "@/core/sheets";
import { parsePickRows } from "@/core/parseSheetRows";
// ...
const sheetData = await fetchDraftTabsRaw(draft.sheetId, apiKey);
if (!sheetData.picks) continue;
const parsedPicks = parsePickRows(sheetData.picks, draft.draftId);
const result = await incrementalIngest(client, draft.draftId, parsedPicks);
```

- [ ] **Step 3: Update sync.ts tests**

Update `src/core/__tests__/sync.test.ts` to pass `ParsedPicks` objects instead of CSV strings.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/__tests__/sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/sync.ts src/app/api/sync/route.ts src/core/__tests__/sync.test.ts
git commit -m "Update live sync route to use row-based parsing"
```

---

### Task 12: Remove ingestionHash from Cache Invalidation

`getDraftStats.ts` and `getCards.ts` read `last_hash` from `ingestion_meta` for client-side cache busting. Since `last_hash` is removed, replace with a different cache key (e.g., timestamp-based or hash of per-domain hashes).

**Files:**
- Modify: `src/core/getDraftStats.ts`
- Modify: `src/core/getCards.ts`

- [ ] **Step 1: Check how `ingestionHash` is used client-side**

Read the client components that consume `ingestionHash` to understand the cache invalidation pattern. The hash is likely used as a query key or ETag.

- [ ] **Step 2: Replace with a combined hash of per-domain hashes**

Instead of reading `ingestion_meta.last_hash`, compute a hash from all drafts' domain hashes:

```typescript
// Helper in getDraftStats.ts / getCards.ts
async function getIngestionFingerprint(client: Client): Promise<string> {
  const result = await client.execute({
    sql: "SELECT pool_hash, picks_hash, matches_hash FROM drafts ORDER BY draft_id",
    args: [],
  });
  const combined = result.rows
    .map((r) => `${r.pool_hash}:${r.picks_hash}:${r.matches_hash}`)
    .join("|");
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: PASS (some tests may need updates if they mock `ingestion_meta`)

- [ ] **Step 4: Commit**

```bash
git add src/core/getDraftStats.ts src/core/getCards.ts
git commit -m "Replace ingestion_meta last_hash with per-domain hash fingerprint"
```

---

### Task 13: Update package.json Scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update scripts**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "sync": "tsx scripts/sync.ts",
    "draft:create": "tsx scripts/draft-create.ts",
    "draft:reset": "tsx scripts/draft-reset.ts",
    "decklists": "tsx scripts/decklists.ts",
    "db:migrate": "tsx src/core/db/migrate.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings 0",
    "knip": "knip",
    "test": "vitest run",
    "precommit": "pnpm typecheck && pnpm lint && pnpm knip && pnpm test",
    "screenshot": "tsx scripts/screenshot.ts"
  }
}
```

Removed: `predev`, `sync-sheets`, `ingest`, `add-draft`

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "Update npm scripts for unified sync pipeline"
```

---

### Task 14: Migration Script — Backfill Per-Domain Hashes

For existing drafts in Turso, compute and store per-domain hashes from the data already in the database.

**Files:**
- Create: `scripts/backfill-hashes.ts` (one-time migration, can be deleted after)

- [ ] **Step 1: Implement backfill script**

```typescript
// scripts/backfill-hashes.ts
import { createClient } from "@libsql/client";
import { loadEnv, log } from "../src/core/db/ingest/utils";
import { hashPool, hashPicks, hashMatches, updateDomainHashes } from "../src/core/db/sync/domains";

async function main() {
  loadEnv();
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const drafts = await client.execute({ sql: "SELECT draft_id FROM drafts", args: [] });

  for (const row of drafts.rows) {
    const draftId = row.draft_id as string;

    // Compute pool hash from cube_snapshot_cards
    const poolResult = await client.execute({
      sql: `SELECT c.name FROM cube_snapshot_cards csc
            JOIN cards c ON csc.card_id = c.card_id
            JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
            WHERE d.draft_id = ?
            ORDER BY c.name`,
      args: [draftId],
    });
    const poolNames = poolResult.rows.map((r) => r.name as string);
    const poolHash = poolNames.length > 0 ? hashPool(poolNames) : null;

    // Compute picks hash from pick_events
    const picksResult = await client.execute({
      sql: `SELECT pe.pick_n, pe.seat, c.name as card_name FROM pick_events pe
            JOIN cards c ON pe.card_id = c.card_id
            WHERE pe.draft_id = ?
            ORDER BY pe.pick_n, pe.seat`,
      args: [draftId],
    });
    const picks = picksResult.rows.map((r) => ({
      cardName: r.card_name as string,
      pickPosition: r.pick_n as number,
      seat: r.seat as number,
      copyNumber: 1,
      wasPicked: true,
      draftId,
      color: "",
    }));
    const picksHash = picks.length > 0 ? hashPicks(picks) : null;

    // Compute matches hash from match_events
    const matchesResult = await client.execute({
      sql: `SELECT seat1, seat2, seat1_wins, seat2_wins FROM match_events
            WHERE draft_id = ? ORDER BY seat1, seat2`,
      args: [draftId],
    });
    const matches = matchesResult.rows.map((r) => ({
      seat1: r.seat1 as number,
      seat2: r.seat2 as number,
      seat1Wins: r.seat1_wins as number,
      seat2Wins: r.seat2_wins as number,
    }));
    const matchesHash = matches.length > 0 ? hashMatches(matches) : null;

    await updateDomainHashes(client, draftId, { poolHash, picksHash, matchesHash });
    log(`${draftId}: pool=${poolHash ?? "null"} picks=${picksHash ?? "null"} matches=${matchesHash ?? "null"}`);
  }

  log("Hash backfill complete");
}

main().catch(console.error);
```

**Important note on hash alignment:** The backfill computes hashes from data in the DB (resolved card names from the `cards` table). The sync pipeline computes hashes from raw Sheets data (pre-resolution card names). If names differ (e.g., DFC names, Scryfall normalization), hashes won't match and the first sync will re-replace those domains. This is acceptable — it's a one-time cost and ensures correctness. If you want exact alignment, compute hashes from the same source (Sheets data) by running `pnpm sync` once after migration instead of backfilling from the DB.

- [ ] **Step 2: Run backfill**

Run: `npx tsx scripts/backfill-hashes.ts`
Expected: Hashes printed for each draft, no errors.

- [ ] **Step 3: Verify**

Run: `turso db shell read-the-bones "SELECT draft_id, pool_hash, picks_hash, matches_hash FROM drafts"`
Expected: All drafts have non-null hashes.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-hashes.ts
git commit -m "Add one-time hash backfill script for migration"
```

---

### Task 15: Delete Old Code

Remove all files that are replaced by the new pipeline. Run the full test suite and quality checks between deletions to catch breakage early.

**Files to delete (in dependency order):**

- [ ] **Step 0: Move decklists.txt to project root**

```bash
cp data/decklists.txt ./decklists.txt
```

Verify the file exists at the new location before proceeding.

- [ ] **Step 1: Delete old scripts**

```bash
rm scripts/sync-sheets.ts scripts/match-decklists.ts scripts/add-draft.ts
```

- [ ] **Step 2: Delete old parsers**

```bash
rm src/core/parseCsv.ts src/core/parseCsv.test.ts
rm src/core/parseMatches.ts src/core/parseMatches.test.ts
```

- [ ] **Step 3: Delete old ingest pipeline**

```bash
rm src/core/db/ingest/discover.ts
rm src/core/db/ingest/full-import.ts
rm src/core/db/ingest/incremental.ts
rm src/core/db/ingest/index.ts
rm src/core/db/ingest.ts
rm src/core/db/__tests__/incremental-ingest.test.ts
rm src/core/db/__tests__/ingest-sheet-id.test.ts
rm src/core/db/__tests__/ingest-bans.test.ts
```

- [ ] **Step 4: Delete build shim**

```bash
rm src/build/sheets.ts src/build/sheets.test.ts
```

- [ ] **Step 5: Clean up ingest/utils.ts**

Remove `computeImportHash`, `hashFile`, `IngestDraftMetadata` from `src/core/db/ingest/utils.ts`. Keep `generateOracleId`, `computeCubeHash`, `log`, `logIndent`, `PROJECT_ROOT`, `loadEnv`.

- [ ] **Step 6: Clean up db-helpers.ts**

Remove `getDraftImportHash`, `createDraft` (replaced by `draft:create` CLI), `deleteDraft` (replaced by `resetDraft`). Keep `ensureCard`, `ensureCubeSnapshot`, `insertOptOuts`, `resetDraft`.

- [ ] **Step 7: Migrate shared utilities and fix remaining imports**

`normalizeCardName` and `cardNameKey` from `parseCsv.ts` are imported by files that are NOT being deleted:
- `src/core/getCards.ts`
- `src/core/calculateStats.ts`
- `src/build/scryfall.ts` and `src/build/scryfall.test.ts`
- `src/core/db/ingest/scryfall.ts`
- `src/core/sync.ts`

These must be updated to import from `parseSheetRows.ts` instead. Both functions are already defined in the new module (Task 2).

Search for all imports of `parseCsv` and update them:
Run: `grep -r "from.*parseCsv" src/`

Also search for any other imports of deleted modules:
Run: `grep -r "from.*parseMatches\|from.*ingest/discover\|from.*ingest/full-import\|from.*ingest/incremental\|from.*ingest/index\|from.*build/sheets" src/`

- [ ] **Step 8: Run full quality checks**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, and tests all pass. Knip may flag newly dead code — fix as needed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Remove old CSV-based ingestion pipeline, parsers, and scripts"
```

---

### Task 16: Update CLAUDE.md

Update the project documentation to reflect the new pipeline.

**Files:**
- Modify: `CLAUDE.md` (project root)

- [ ] **Step 1: Update Key Commands section**

Replace the old sync-sheets/ingest commands with the new sync/draft commands.

- [ ] **Step 2: Update Project Structure section**

Remove references to `data/` directory. Update `src/core/db/` structure to show `sync/` instead of `ingest/` (or alongside, for remaining ingest files).

- [ ] **Step 3: Update Data Format section**

Remove references to CSV file formats. Note that data comes from Google Sheets directly.

- [ ] **Step 4: Update Deploying / Data Flow sections**

Simplify the data flow description: Sheets → `pnpm sync` → Turso → web app.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "Update project docs for unified sync pipeline"
```

---

### Task 17: End-to-End Verification

Verify the complete pipeline works against real data.

- [ ] **Step 1: Run sync with dry-run**

Run: `pnpm sync --dry-run`
Expected: Reports what would change for each incomplete draft, no DB writes.

- [ ] **Step 2: Run sync for a specific draft**

Run: `pnpm sync <known-draft-name>`
Expected: All domains show "unchanged" (since hashes were backfilled).

- [ ] **Step 3: Run draft:reset + sync to verify full reimport**

Run: `pnpm draft:reset <test-draft> && pnpm sync <test-draft>`
Expected: All domains show "replace" with correct counts.

- [ ] **Step 4: Run the dev server and verify UI**

Run: `pnpm dev`
Expected: App loads, card table displays correctly, draft selection works.

- [ ] **Step 5: Run full quality checks one final time**

Run: `pnpm precommit`
Expected: All pass.

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "Fix issues found during end-to-end verification"
```
