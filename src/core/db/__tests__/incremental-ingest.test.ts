import { describe, it, expect } from "vitest";

import { parseIngestArgs, incrementalPicks, incrementalMatches } from "../ingest";

describe("parseIngestArgs", () => {
  it("returns no force and no filter when no args", () => {
    const result = parseIngestArgs([]);
    expect(result).toEqual({ force: false, filterDraftId: undefined });
  });

  it("parses --force flag alone", () => {
    const result = parseIngestArgs(["--force"]);
    expect(result).toEqual({ force: true, filterDraftId: undefined });
  });

  it("parses draft ID filter alone", () => {
    const result = parseIngestArgs(["tarkir"]);
    expect(result).toEqual({ force: false, filterDraftId: "tarkir" });
  });

  it("parses --force with draft ID (either order)", () => {
    expect(parseIngestArgs(["--force", "tarkir"])).toEqual({
      force: true,
      filterDraftId: "tarkir",
    });
    expect(parseIngestArgs(["tarkir", "--force"])).toEqual({
      force: true,
      filterDraftId: "tarkir",
    });
  });
});

describe("incrementalPicks", () => {
  // Create a mock client that tracks SQL calls
  function mockClient(maxPickN: number) {
    const calls: { sql: string; args: unknown[] }[] = [];
    return {
      client: {
        execute: async (params: { sql: string; args: unknown[] }) => {
          calls.push(params);
          if (params.sql.includes("MAX(pick_n)")) {
            return { rows: [{ max_pick: maxPickN }] };
          }
          if (params.sql.includes("SELECT card_id FROM cards")) {
            return { rows: [{ card_id: 42 }] };
          }
          if (params.sql.includes("INSERT OR IGNORE")) {
            return { rows: [], rowsAffected: 1 };
          }
          if (params.sql.includes("UPDATE drafts SET is_complete")) {
            return { rows: [], rowsAffected: 1 };
          }
          return { rows: [] };
        },
      } as any,
      calls,
    };
  }

  // picks.csv format: col A = round number, col B = arrow, col C+ = drafter picks.
  // Row 1-2 are headers (ignored). Row 3 (index 2) has drafter names.
  // Row 4+ has round# in col A, arrow in col B, card names in col C+.
  // With 2 drafters, round 1 -> picks 1,2; round 2 -> picks 4,3 (snake); round 3 -> picks 5,6.
  // isDraftComplete returns true if no ✪ marker is found, so we add an incomplete
  // marker row (✪ with empty drafter cols) to test non-complete drafts.
  function makePicksCsv(
    picks: [number, string, string][],
    opts?: { incomplete?: boolean },
  ) {
    const rows = [
      ",,Player A,Player B", // Row 1 (ignored)
      ",,Player A,Player B", // Row 2 (ignored)
      ",,Player A,Player B", // Row 3: drafter names at index 2+
      ...picks.map(([n, a, b]) => `${n},→,${a},${b}`),
    ];
    if (opts?.incomplete) {
      // Add a ✪ marker row with empty drafter columns to signal incomplete draft
      rows.push(",✪,,");
    }
    return rows.join("\n");
  }

  it("inserts only new picks above DB max", async () => {
    // With 2 drafters: round 1 picks at positions 1,2; round 2 at positions 4,3 (snake).
    // dbMaxPick=2 means pick at position 1 and 2 already exist.
    // New picks: position 3 (Counterspell) and position 4 (not present, empty).
    // Only Counterspell at position 3 is new (round 2, Player B, snake pos = (2-1)*2 + (2-1) = 3).
    const { client } = mockClient(2);
    const picksCsv = makePicksCsv(
      [
        [1, "Lightning Bolt", "Ancestral Recall"],
        [2, "", "Counterspell"],
      ],
      { incomplete: true },
    );
    // Round 1: Bolt at pos 1, Ancestral at pos 2. Round 2 (snake): Counterspell at pos (1)*2 + (2-1) = 3.
    // dbMaxPick=2, so only Counterspell (pos 3) is new.

    const result = await incrementalPicks(
      client as any,
      "test-draft",
      picksCsv,
    );
    expect(result.picksInserted).toBe(1);
    expect(result.status).toBe("updated");
  });

  it("returns no_change when no new picks", async () => {
    // Round 1: positions 1, 2. dbMaxPick=2 means all picks are already in DB.
    const { client } = mockClient(2);
    const picksCsv = makePicksCsv(
      [[1, "Lightning Bolt", "Ancestral Recall"]],
      { incomplete: true },
    );

    const result = await incrementalPicks(
      client as any,
      "test-draft",
      picksCsv,
    );
    expect(result.status).toBe("no_change");
    expect(result.picksInserted).toBe(0);
  });

  it("returns diverged when CSV max < DB max", async () => {
    // Round 1 with 2 drafters: max pick position = 2. DB says max is 5 -> diverged.
    const { client } = mockClient(5);
    const picksCsv = makePicksCsv(
      [[1, "Lightning Bolt", "Ancestral Recall"]],
      { incomplete: true },
    );

    const result = await incrementalPicks(
      client as any,
      "test-draft",
      picksCsv,
    );
    expect(result.status).toBe("diverged");
  });
});

describe("incrementalMatches", () => {
  function mockClient(existingMatchCount: number) {
    const insertedSql: string[] = [];
    return {
      client: {
        execute: async (params: { sql: string; args: unknown[] }) => {
          if (params.sql.includes("COUNT(*)")) {
            return { rows: [{ count: existingMatchCount }] };
          }
          if (params.sql.includes("INSERT OR IGNORE")) {
            insertedSql.push(params.sql);
            return { rows: [], rowsAffected: 1 };
          }
          return { rows: [] };
        },
      } as any,
      insertedSql,
    };
  }

  it("inserts matches with INSERT OR IGNORE", async () => {
    const { client, insertedSql } = mockClient(0);
    // matches.csv format: 3 header rows, then data rows
    // Data cols: [empty, player1Name, player1Score, "VS", player2Score, player2Name]
    const matchesCsv = [
      "Title Row",
      "",
      "Header Row,Player 1,Score,,Score,Player 2",
      ",Player A,2,VS,1,Player B",
      ",Player A,1,VS,2,Player C",
    ].join("\n");

    const drafterNames = ["Player A", "Player B", "Player C"];
    const result = await incrementalMatches(
      client as any,
      "test-draft",
      matchesCsv,
      drafterNames,
    );
    expect(result).toBe(2);
    expect(insertedSql.length).toBe(2);
  });
});
