import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockClient = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./db/client", () => ({
  getClient: vi.fn().mockResolvedValue(mockClient),
}));

import { getCards } from "./getCards";

// --- Test helpers ---

/** Minimal Scryfall JSON that transformScryfallJson can parse. */
function scryfallJson(name: string, colorIdentity: string[] = []) {
  return JSON.stringify({
    name,
    image_uris: { normal: `https://example.com/${name}.jpg` },
    mana_cost: "{1}{U}",
    cmc: 2,
    type_line: "Creature",
    colors: colorIdentity,
    color_identity: colorIdentity,
    oracle_text: "",
  });
}

function draftRow(
  id: string,
  {
    name = id,
    date = "2026-01-01",
    cubeSnapshotId = 1,
    numSeats = 10,
    phase = "complete",
    bannedCards = null as string | null,
    poolHash = "ph1",
    picksHash = "pi1",
    matchesHash = "mh1",
  } = {},
) {
  return {
    draft_id: id,
    draft_name: name,
    draft_date: date,
    cube_snapshot_id: cubeSnapshotId,
    num_seats: numSeats,
    phase,
    banned_cards: bannedCards,
    pool_hash: poolHash,
    picks_hash: picksHash,
    matches_hash: matchesHash,
  };
}

function pickRow(draftId: string, cardName: string, pickN: number, seat: number) {
  return {
    draft_id: draftId,
    pick_n: pickN,
    seat,
    card_name: cardName,
    scryfall_json: scryfallJson(cardName, ["U"]),
  };
}

function cubeCardRow(snapshotId: number, cardId: number, cardName: string, qty = 1) {
  return {
    cube_snapshot_id: snapshotId,
    card_id: cardId,
    qty,
    card_name: cardName,
    scryfall_json: scryfallJson(cardName, ["U"]),
  };
}

function cubeSizeRow(snapshotId: number, poolSize: number) {
  return { cube_snapshot_id: snapshotId, pool_size: poolSize };
}

/**
 * Configure mockClient.execute to return results based on query content.
 * Inspects the SQL string to decide which mock data to return.
 */
function setupMockExecute(options: {
  draftRows?: ReturnType<typeof draftRow>[];
  pickRows?: ReturnType<typeof pickRow>[];
  cubeCardRows?: ReturnType<typeof cubeCardRow>[];
  cubeSizeRows?: ReturnType<typeof cubeSizeRow>[];
  takenRows?: Array<{ name: string; seat: number }>;
}) {
  const {
    draftRows = [],
    pickRows = [],
    cubeCardRows = [],
    cubeSizeRows = [],
    takenRows = [],
  } = options;

  mockClient.execute.mockImplementation(
    (query: { sql: string; args?: unknown[] } | string) => {
      const sql = typeof query === "string" ? query : query.sql;

      // Drafts metadata query
      if (sql.includes("FROM drafts d") && sql.includes("ORDER BY")) {
        return Promise.resolve({ rows: draftRows });
      }

      // Cube pool sizes
      if (sql.includes("SUM(qty) as pool_size")) {
        return Promise.resolve({ rows: cubeSizeRows });
      }

      // Pick events
      if (sql.includes("FROM pick_events pe")) {
        // Distinguish takenCards query (no JOIN on pick_n) from main picks query
        if (sql.includes("pe.pick_n")) {
          return Promise.resolve({ rows: pickRows });
        }
        // takenCards query for activeDraft
        return Promise.resolve({ rows: takenRows });
      }

      // Cube snapshot cards
      if (sql.includes("FROM cube_snapshot_cards csc")) {
        return Promise.resolve({ rows: cubeCardRows });
      }

      return Promise.resolve({ rows: [] });
    },
  );
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCards", () => {
  it("returns empty card data when database has no drafts", async () => {
    setupMockExecute({});

    const result = await getCards({});

    expect(result.cards).toEqual([]);
    expect(result.draftCount).toBe(0);
    expect(result.cubeCopies).toEqual({});
    expect(result.draftMetadata).toEqual({});
    expect(result.draftIds).toEqual([]);
    expect(result.completedDraftIds).toEqual([]);
    expect(result.ingestionHash).toBeDefined();
    expect(typeof result.ingestionHash).toBe("string");
  });

  it("correctly computes draft metadata (name, date, numDrafters) from mock DB rows", async () => {
    setupMockExecute({
      draftRows: [
        draftRow("d1", { name: "Alpha Draft", date: "2026-01-15", numSeats: 8 }),
        draftRow("d2", { name: "Beta Draft", date: "2026-02-01", numSeats: 10 }),
      ],
      cubeSizeRows: [cubeSizeRow(1, 360)],
      cubeCardRows: [cubeCardRow(1, 1, "Lightning Bolt")],
    });

    const result = await getCards({});

    expect(result.draftMetadata["d1"]).toEqual({
      name: "Alpha Draft",
      date: "2026-01-15",
      numDrafters: 8,
    });
    expect(result.draftMetadata["d2"]).toEqual({
      name: "Beta Draft",
      date: "2026-02-01",
      numDrafters: 10,
    });
    expect(result.draftIds).toEqual(["d1", "d2"]);
    expect(result.completedDraftIds).toEqual(["d1", "d2"]);
    expect(result.draftCount).toBe(2);
  });

  it("aggregates pick events across multiple drafts to compute stats", async () => {
    const drafts = [
      draftRow("d1", { cubeSnapshotId: 1 }),
      draftRow("d2", { cubeSnapshotId: 1 }),
    ];

    const picks = [
      // Card picked early in both drafts
      pickRow("d1", "Counterspell", 3, 1),
      pickRow("d2", "Counterspell", 5, 2),
      // Card picked late in one draft
      pickRow("d1", "Cancel", 80, 3),
    ];

    const cubeCards = [
      cubeCardRow(1, 1, "Counterspell"),
      cubeCardRow(1, 2, "Cancel"),
    ];

    setupMockExecute({
      draftRows: drafts,
      pickRows: picks,
      cubeCardRows: cubeCards,
      cubeSizeRows: [cubeSizeRow(1, 200)],
    });

    const result = await getCards({});

    expect(result.cards.length).toBeGreaterThan(0);

    const counterspell = result.cards.find((c) => c.cardName === "Counterspell");
    expect(counterspell).toBeDefined();
    // Picked in both drafts
    expect(counterspell!.draftsPickedIn).toBe(2);
    expect(counterspell!.timesAvailable).toBe(2);

    const cancel = result.cards.find((c) => c.cardName === "Cancel");
    expect(cancel).toBeDefined();
    // Picked in 1, unpicked in 1
    expect(cancel!.draftsPickedIn).toBe(1);
    expect(cancel!.timesAvailable).toBe(2);
    // Weighted geomean should be higher (worse) than Counterspell
    expect(cancel!.weightedGeomean).toBeGreaterThan(counterspell!.weightedGeomean);
  });

  it("includes takenCards when activeDraft is provided", async () => {
    setupMockExecute({
      draftRows: [draftRow("d1")],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      cubeCardRows: [cubeCardRow(1, 1, "Brainstorm")],
      takenRows: [
        { name: "Brainstorm", seat: 1 },
        { name: "Force of Will", seat: 3 },
      ],
    });

    const result = await getCards({ activeDraft: "d1" });

    expect(result.takenCards).toBeDefined();
    expect(result.takenCards).toHaveLength(2);
    expect(result.takenCards).toContainEqual({ name: "Brainstorm", seat: 1 });
    expect(result.takenCards).toContainEqual({ name: "Force of Will", seat: 3 });
  });

  it("filters cube cards by poolAsOfDraft snapshot", async () => {
    // Two drafts with different cube snapshots
    const drafts = [
      draftRow("d1", { cubeSnapshotId: 1 }),
      draftRow("d2", { cubeSnapshotId: 2 }),
    ];

    // Snapshot 1 has Bolt, snapshot 2 has Bolt + Counterspell
    const cubeCards = [
      cubeCardRow(1, 1, "Lightning Bolt"),
      cubeCardRow(2, 1, "Lightning Bolt"),
      cubeCardRow(2, 2, "Counterspell"),
    ];

    setupMockExecute({
      draftRows: drafts,
      pickRows: [
        pickRow("d1", "Lightning Bolt", 5, 1),
        pickRow("d2", "Lightning Bolt", 3, 2),
        pickRow("d2", "Counterspell", 7, 1),
      ],
      cubeCardRows: cubeCards,
      cubeSizeRows: [cubeSizeRow(1, 200), cubeSizeRow(2, 200)],
    });

    // poolAsOfDraft=d1 means display snapshot is snapshot 1 (only has Bolt)
    const result = await getCards({ poolAsOfDraft: "d1" });

    const cardNames = result.cards.map((c) => c.cardName);
    expect(cardNames).toContain("Lightning Bolt");
    // Counterspell is not in snapshot 1's cube, so it should be filtered out
    expect(cardNames).not.toContain("Counterspell");
  });

  it("computes ingestionHash as a hex string", async () => {
    setupMockExecute({
      draftRows: [draftRow("d1", { poolHash: "abc", picksHash: "def", matchesHash: "ghi" })],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      cubeCardRows: [cubeCardRow(1, 1, "Island")],
    });

    const result = await getCards({});

    expect(result.ingestionHash).toMatch(/^[a-f0-9]+$/);
    expect(result.ingestionHash.length).toBe(16);
  });

  it("handles drafts with no picks gracefully", async () => {
    setupMockExecute({
      draftRows: [draftRow("d1")],
      pickRows: [],
      cubeCardRows: [cubeCardRow(1, 1, "Plains")],
      cubeSizeRows: [cubeSizeRow(1, 200)],
    });

    const result = await getCards({});

    // Should still return cards (unpicked entries from cube)
    expect(result.draftCount).toBe(1);
    const plains = result.cards.find((c) => c.cardName === "Plains");
    expect(plains).toBeDefined();
    // Never picked, so weightedGeomean should be high (poolSize penalized)
    expect(plains!.draftsPickedIn).toBe(0);
    expect(plains!.timesAvailable).toBe(1);
  });

  it("returns empty card data when no draftIds match completed drafts", async () => {
    setupMockExecute({
      draftRows: [draftRow("d1", { phase: "drafting" })],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      cubeCardRows: [cubeCardRow(1, 1, "Island")],
    });

    // No completed drafts, so filtering draftIds yields empty
    const result = await getCards({ draftIds: ["d1"] });
    expect(result.draftCount).toBe(0);
  });

  it("includes bannedCardNames when activeDraft has banned cards", async () => {
    setupMockExecute({
      draftRows: [
        draftRow("d1", { bannedCards: JSON.stringify(["Black Lotus", "Ancestral Recall"]) }),
      ],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      cubeCardRows: [cubeCardRow(1, 1, "Island")],
    });

    const result = await getCards({ activeDraft: "d1" });

    expect(result.bannedCardNames).toBeDefined();
    expect(result.bannedCardNames).toContain("Black Lotus");
    expect(result.bannedCardNames).toContain("Ancestral Recall");
  });
});
