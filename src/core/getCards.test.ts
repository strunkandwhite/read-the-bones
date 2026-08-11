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
  } = {}
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

/**
 * A pick event row. Now includes card_id (used by loadPickEvents to collect
 * card_ids for the separate Scryfall batch load). scryfall_json is NOT
 * returned by the picks query anymore — it comes from the cards table query.
 */
function pickRow(draftId: string, cardName: string, pickN: number, seat: number, cardId = 100) {
  return {
    draft_id: draftId,
    pick_n: pickN,
    seat,
    card_id: cardId,
    card_name: cardName,
  };
}

/**
 * A cube snapshot card row. No longer includes scryfall_json (slimmed query).
 */
function cubeCardRow(snapshotId: number, cardId: number, cardName: string, qty = 1) {
  return {
    cube_snapshot_id: snapshotId,
    card_id: cardId,
    qty,
    card_name: cardName,
  };
}

function cubeSizeRow(snapshotId: number, poolSize: number) {
  return { cube_snapshot_id: snapshotId, pool_size: poolSize };
}

/**
 * A row returned by the Scryfall batch load query (SELECT card_id, name, scryfall_json
 * FROM cards WHERE card_id IN (...)).
 */
function scryfallCardRow(cardId: number, cardName: string) {
  return {
    card_id: cardId,
    name: cardName,
    scryfall_json: scryfallJson(cardName, ["U"]),
  };
}

/**
 * Configure mockClient.execute to return results based on query content.
 * Inspects the SQL string to decide which mock data to return.
 *
 * Query routing (in order):
 *   1. Drafts metadata   — FROM drafts d ... ORDER BY
 *   2. Cube pool sizes   — SUM(qty) as pool_size
 *   3. Pick events       — FROM pick_events pe ... pe.pick_n  (lean: no scryfall_json)
 *   4. TakenCards        — FROM pick_events pe … WHERE pe.draft_id = ?  (no pe.pick_n in ORDER BY)
 *   5. Cube cards        — FROM cube_snapshot_cards csc  (lean: no scryfall_json)
 *   6. Scryfall batch    — FROM cards WHERE card_id IN   (new: one load per distinct card)
 */
function setupMockExecute(options: {
  draftRows?: ReturnType<typeof draftRow>[];
  pickRows?: ReturnType<typeof pickRow>[];
  cubeCardRows?: ReturnType<typeof cubeCardRow>[];
  cubeSizeRows?: ReturnType<typeof cubeSizeRow>[];
  takenRows?: Array<{ name: string; seat: number }>;
  scryfallRows?: ReturnType<typeof scryfallCardRow>[];
}) {
  const {
    draftRows = [],
    pickRows = [],
    cubeCardRows = [],
    cubeSizeRows = [],
    takenRows = [],
    scryfallRows,
  } = options;

  // If no explicit scryfallRows provided, synthesise them from the union of
  // pick + cube card names so tests don't need to repeat this boilerplate.
  const defaultScryfallRows: ReturnType<typeof scryfallCardRow>[] = [];
  if (scryfallRows === undefined) {
    const seen = new Set<number>();
    for (const r of pickRows) {
      if (!seen.has(r.card_id)) {
        seen.add(r.card_id);
        defaultScryfallRows.push(scryfallCardRow(r.card_id, r.card_name));
      }
    }
    for (const r of cubeCardRows) {
      if (!seen.has(r.card_id)) {
        seen.add(r.card_id);
        defaultScryfallRows.push(scryfallCardRow(r.card_id, r.card_name));
      }
    }
  }
  const effectiveScryfallRows = scryfallRows ?? defaultScryfallRows;

  mockClient.execute.mockImplementation((query: { sql: string; args?: unknown[] } | string) => {
    const sql = typeof query === "string" ? query : query.sql;

    // Drafts metadata query
    if (sql.includes("FROM drafts d") && sql.includes("ORDER BY")) {
      return Promise.resolve({ rows: draftRows });
    }

    // Cube pool sizes
    if (sql.includes("SUM(qty) as pool_size")) {
      return Promise.resolve({ rows: cubeSizeRows });
    }

    // Pick events (lean — no scryfall_json): ORDER BY clause includes pe.pick_n
    if (sql.includes("FROM pick_events pe") && sql.includes("ORDER BY pe.draft_id")) {
      return Promise.resolve({ rows: pickRows });
    }

    // TakenCards query for activeDraft (no ORDER BY pe.draft_id)
    if (sql.includes("FROM pick_events pe")) {
      return Promise.resolve({ rows: takenRows });
    }

    // Cube snapshot cards (lean — no scryfall_json)
    if (sql.includes("FROM cube_snapshot_cards csc")) {
      return Promise.resolve({ rows: cubeCardRows });
    }

    // Scryfall batch load: one query per distinct card_id set
    if (sql.includes("FROM cards") && sql.includes("WHERE card_id IN")) {
      return Promise.resolve({ rows: effectiveScryfallRows });
    }

    return Promise.resolve({ rows: [] });
  });
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
    const drafts = [draftRow("d1", { cubeSnapshotId: 1 }), draftRow("d2", { cubeSnapshotId: 1 })];

    const picks = [
      // Card picked early in both drafts
      pickRow("d1", "Counterspell", 3, 1),
      pickRow("d2", "Counterspell", 5, 2),
      // Card picked late in one draft
      pickRow("d1", "Cancel", 80, 3),
    ];

    const cubeCards = [cubeCardRow(1, 1, "Counterspell"), cubeCardRow(1, 2, "Cancel")];

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

  it("weights a card's pick score by each draft's date, not just relative order", async () => {
    // Regression test for the session-ordinal wiring in getCards.ts (feeds
    // sessionsAgoByDraft off draftMetadataMap's dates): a wrong date lookup
    // would still pass the "cancel worse than counterspell" comparison test
    // above since that test uses two same-dated drafts (sessionsAgo 0 for
    // both), so it can't tell dated ordinals apart from no ordinals at all.
    const drafts = [
      draftRow("d1", { cubeSnapshotId: 1, date: "2026-01-01" }),
      draftRow("d2", { cubeSnapshotId: 1, date: "2026-02-01" }),
    ];

    const picks = [pickRow("d1", "Lightning Bolt", 50, 1), pickRow("d2", "Lightning Bolt", 10, 2)];

    const cubeCards = [cubeCardRow(1, 1, "Lightning Bolt")];

    setupMockExecute({
      draftRows: drafts,
      pickRows: picks,
      cubeCardRows: cubeCards,
      cubeSizeRows: [cubeSizeRow(1, 540)],
    });

    const result = await getCards({});

    const bolt = result.cards.find((c) => c.cardName === "Lightning Bolt");
    expect(bolt).toBeDefined();
    // d2 (2026-02-01) is the newest session, sessionsAgo 0, full weight.
    // d1 (2026-01-01) is one session back, weight 0.5^(1/4) = 0.840896:
    // exp((1*ln(10) + 0.840896*ln(50)) / 1.840896) = 20.8584
    expect(bolt!.weightedGeomean).toBeCloseTo(20.8584, 3);
  });

  it("keeps the real session gap when a draft filter excludes an interior completed session", async () => {
    // d2 sits between d1 and d3 but is excluded from the draftIds selection.
    // Session ordinals must still span every completed draft (not just the
    // selection), so d3 stays two sessions back rather than collapsing to
    // one when d2 drops out of the picked-card observations.
    const drafts = [
      draftRow("d1", { cubeSnapshotId: 1, date: "2026-08-01" }),
      draftRow("d2", { cubeSnapshotId: 1, date: "2026-07-01" }),
      draftRow("d3", { cubeSnapshotId: 1, date: "2026-06-01" }),
    ];

    const picks = [pickRow("d1", "Bolt", 1, 1, 1), pickRow("d3", "Bolt", 30, 2, 1)];

    const cubeCards = [cubeCardRow(1, 1, "Bolt")];

    setupMockExecute({
      draftRows: drafts,
      pickRows: picks,
      cubeCardRows: cubeCards,
      cubeSizeRows: [cubeSizeRow(1, 540)],
    });

    const result = await getCards({ draftIds: ["d1", "d3"] });

    const bolt = result.cards.find((c) => c.cardName === "Bolt");
    expect(bolt).toBeDefined();
    // d1 ordinal 0 (weight 1); d2 (excluded from selection) occupies
    // ordinal 1; d3 ordinal 2, weight 0.5^(2/4) = 0.707107:
    // exp((1*ln(1) + 0.707107*ln(30)) / 1.707107) = 4.0911
    expect(bolt!.weightedGeomean).toBeCloseTo(4.0911, 3);
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
    const drafts = [draftRow("d1", { cubeSnapshotId: 1 }), draftRow("d2", { cubeSnapshotId: 2 })];

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

  it("returns zero draftCount when specified draftIds contain only in-progress drafts", async () => {
    setupMockExecute({
      draftRows: [draftRow("d1", { phase: "drafting" })],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      cubeCardRows: [cubeCardRow(1, 1, "Island")],
    });

    // d1 is in-progress (drafting phase) so it does not count toward completed stats
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

  it("pins the full transformed shape of an EnrichedCardStats entry (regression guard for Task 21 slim-SQL refactor)", async () => {
    // This test pins the complete output shape of getCards so that the slim-SQL
    // refactor (scryfall_json loaded once per distinct card instead of per row)
    // is verified to produce identical enriched card output.
    setupMockExecute({
      draftRows: [draftRow("d1", { cubeSnapshotId: 1 })],
      pickRows: [pickRow("d1", "Lightning Bolt", 3, 1, 42)],
      cubeCardRows: [cubeCardRow(1, 42, "Lightning Bolt", 1)],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      // Explicit scryfall data for card_id=42 matches the pick + cube row
      scryfallRows: [
        {
          card_id: 42,
          name: "Lightning Bolt",
          scryfall_json: scryfallJson("Lightning Bolt", ["R"]),
        },
      ],
    });

    const result = await getCards({});

    expect(result.cards).toHaveLength(1);
    const card = result.cards[0];

    // Top-level stats fields
    expect(card.cardName).toBe("Lightning Bolt");
    expect(card.draftsPickedIn).toBe(1);
    expect(card.timesAvailable).toBe(1);
    expect(card.maxCopiesInDraft).toBe(1);
    expect(typeof card.weightedGeomean).toBe("number");
    expect(card.colors).toBeInstanceOf(Array);

    // Scryfall enrichment (transformScryfallJson output)
    expect(card.scryfall).toBeDefined();
    expect(card.scryfall!.name).toBe("Lightning Bolt");
    expect(typeof card.scryfall!.imageUri).toBe("string");
    expect(card.scryfall!.manaCost).toBe("{1}{U}"); // from scryfallJson helper
    expect(card.scryfall!.manaValue).toBe(2);
    expect(card.scryfall!.typeLine).toBe("Creature");
    expect(card.scryfall!.colors).toEqual(["R"]);
    expect(card.scryfall!.colorIdentity).toEqual(["R"]);
    expect(card.scryfall!.oracleText).toBe("");

    // Full response shape fields
    expect(result.cubeCopies).toEqual({ "Lightning Bolt": 1 });
    expect(result.draftCount).toBe(1);
    expect(result.ingestionHash).toMatch(/^[a-f0-9]+$/);
  });

  it("skips banned cards when generating unpicked pool entries (banned card gets 0 timesAvailable)", async () => {
    // Set up a draft with 2 cards in the cube, one of which is banned.
    // The banned card is skipped in buildAllPicks (no unpicked pool entry).
    // It still appears in result.cards as a new-card stub with weightedGeomean:Infinity
    // and timesAvailable:0 — but importantly it does NOT affect stats via unpicked entries.
    setupMockExecute({
      draftRows: [
        draftRow("d1", {
          cubeSnapshotId: 1,
          bannedCards: JSON.stringify(["Black Lotus"]),
        }),
      ],
      pickRows: [],
      cubeCardRows: [cubeCardRow(1, 1, "Lightning Bolt"), cubeCardRow(1, 2, "Black Lotus")],
      cubeSizeRows: [cubeSizeRow(1, 200)],
    });

    const result = await getCards({});

    const names = result.cards.map((c) => c.cardName);
    expect(names).toContain("Lightning Bolt");
    // Black Lotus is banned — no unpicked pool entry is generated, so timesAvailable = 0
    const bannedCard = result.cards.find((c) => c.cardName === "Black Lotus");
    expect(bannedCard).toBeDefined(); // appears as a stub (in display cube)
    expect(bannedCard!.timesAvailable).toBe(0); // no unpicked entries generated
    // Lightning Bolt (not banned) gets a normal unpicked entry
    const bolt = result.cards.find((c) => c.cardName === "Lightning Bolt");
    expect(bolt).toBeDefined();
    expect(bolt!.timesAvailable).toBe(1);
  });

  it("assigns copyNumber correctly for multiple copies of the same card in one draft", async () => {
    // Two picks of Mishra's Bauble in d1 (qty=2 in cube).
    // copyNumber for the first pick should be 1, second pick should be 2.
    setupMockExecute({
      draftRows: [draftRow("d1", { cubeSnapshotId: 1 })],
      pickRows: [
        pickRow("d1", "Mishra's Bauble", 5, 1, 10),
        pickRow("d1", "Mishra's Bauble", 12, 2, 10),
      ],
      cubeCardRows: [cubeCardRow(1, 10, "Mishra's Bauble", 2)],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      scryfallRows: [
        { card_id: 10, name: "Mishra's Bauble", scryfall_json: scryfallJson("Mishra's Bauble") },
      ],
    });

    const result = await getCards({});

    // Both copies were picked, so the card should appear in stats
    const card = result.cards.find((c) => c.cardName === "Mishra's Bauble");
    expect(card).toBeDefined();
    // 2 picks, both in the same draft
    expect(card!.draftsPickedIn).toBe(1);
    expect(card!.maxCopiesInDraft).toBe(2);
  });

  it("generates multiple unpicked entries when cube qty > 1 and cards are not picked", async () => {
    // Cube has Mishra's Bauble with qty=3. No picks.
    // buildAllPicks generates 3 CardPick entries (one per copy) for the same draftId.
    // calculateStats uses uniqueDraftIds for timesAvailable (size=1 for a single draft)
    // but maxCopiesInDraft counts the copies within that draft.
    setupMockExecute({
      draftRows: [draftRow("d1", { cubeSnapshotId: 1 })],
      pickRows: [],
      cubeCardRows: [cubeCardRow(1, 10, "Mishra's Bauble", 3)],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      scryfallRows: [
        { card_id: 10, name: "Mishra's Bauble", scryfall_json: scryfallJson("Mishra's Bauble") },
      ],
    });

    const result = await getCards({});

    const card = result.cards.find((c) => c.cardName === "Mishra's Bauble");
    expect(card).toBeDefined();
    // 1 draft, 3 unpicked entries — timesAvailable is unique-draft-count = 1
    expect(card!.timesAvailable).toBe(1);
    expect(card!.draftsPickedIn).toBe(0);
    // maxCopiesInDraft reflects the qty=3 from the cube
    expect(card!.maxCopiesInDraft).toBe(3);
  });

  it("generates unpicked entries only for remaining copies when some are picked", async () => {
    // qty=3, picks=1 → 2 unpicked entries. The card appears once in picks + 2 unpicked.
    // timesAvailable = 1 (same draft); draftsPickedIn = 1; maxCopiesInDraft = 3.
    setupMockExecute({
      draftRows: [draftRow("d1", { cubeSnapshotId: 1 })],
      pickRows: [pickRow("d1", "Mishra's Bauble", 5, 1, 10)],
      cubeCardRows: [cubeCardRow(1, 10, "Mishra's Bauble", 3)],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      scryfallRows: [
        { card_id: 10, name: "Mishra's Bauble", scryfall_json: scryfallJson("Mishra's Bauble") },
      ],
    });

    const result = await getCards({});

    const card = result.cards.find((c) => c.cardName === "Mishra's Bauble");
    expect(card).toBeDefined();
    // All entries (1 picked + 2 unpicked) share the same draft d1
    expect(card!.timesAvailable).toBe(1);
    expect(card!.draftsPickedIn).toBe(1);
    // maxCopiesInDraft = 3 (1 picked + 2 remaining unpicked entries)
    expect(card!.maxCopiesInDraft).toBe(3);
  });

  it("new cards (in current cube with no historical picks) have weightedGeomean of Infinity", async () => {
    // Card exists in the most-recent cube snapshot but has NEVER appeared in any
    // completed draft — it has no pick events and no unpicked pool entries from
    // completed drafts.  assembleCardStats() creates a stub entry with
    // weightedGeomean: Infinity for it.
    //
    // To trigger this: the card is in the display cube (mostRecentCubeSnapshotId)
    // but NOT in any of the selectedDraftIds' cube snapshots (so no unpicked
    // entries are generated for it during buildAllPicks).
    setupMockExecute({
      draftRows: [
        draftRow("d1", { cubeSnapshotId: 1 }), // completed, selected
        draftRow("d2", { cubeSnapshotId: 2, phase: "drafting" }), // not completed — excluded
      ],
      pickRows: [pickRow("d1", "Lightning Bolt", 3, 1, 1)],
      cubeCardRows: [
        // snapshot 1: old cube (for selected draft d1)
        cubeCardRow(1, 1, "Lightning Bolt"),
        // snapshot 2: new cube (display cube, has Counterspell as a new card)
        cubeCardRow(2, 1, "Lightning Bolt"),
        cubeCardRow(2, 2, "Counterspell"),
      ],
      cubeSizeRows: [cubeSizeRow(1, 200), cubeSizeRow(2, 200)],
      scryfallRows: [
        {
          card_id: 1,
          name: "Lightning Bolt",
          scryfall_json: scryfallJson("Lightning Bolt", ["R"]),
        },
        { card_id: 2, name: "Counterspell", scryfall_json: scryfallJson("Counterspell", ["U"]) },
      ],
    });

    // Use poolAsOfDraft=d2 to make snapshot 2 the display cube
    const result = await getCards({ poolAsOfDraft: "d2" });

    // Counterspell appears in the display cube but has no historical data
    const newCard = result.cards.find((c) => c.cardName === "Counterspell");
    expect(newCard).toBeDefined();
    expect(newCard!.weightedGeomean).toBe(Infinity);
    expect(newCard!.timesAvailable).toBe(0);
    expect(newCard!.draftsPickedIn).toBe(0);
  });

  it("Scryfall data is loaded once per distinct card_id (SQL no longer joins scryfall_json onto every pick/cube row)", async () => {
    // Both pick rows reference the same card_id (10). The scryfall batch query
    // is called once with {10} and returns scryfall data for "Counterspell".
    // If the old per-row join were still active, it would select scryfall_json
    // inside the picks query — the mock verifies the NEW query routing instead.
    setupMockExecute({
      draftRows: [draftRow("d1", { cubeSnapshotId: 1 })],
      pickRows: [
        pickRow("d1", "Counterspell", 3, 1, 10),
        pickRow("d1", "Counterspell", 5, 2, 10), // same card_id, second copy
      ],
      cubeCardRows: [cubeCardRow(1, 10, "Counterspell", 2)],
      cubeSizeRows: [cubeSizeRow(1, 200)],
      scryfallRows: [
        { card_id: 10, name: "Counterspell", scryfall_json: scryfallJson("Counterspell", ["U"]) },
      ],
    });

    const result = await getCards({});

    const card = result.cards.find((c) => c.cardName === "Counterspell");
    expect(card).toBeDefined();
    // Both picks are from the same card_id but different copies — scryfall data populated
    expect(card!.scryfall?.name).toBe("Counterspell");
    expect(card!.scryfall?.colorIdentity).toEqual(["U"]);

    // Verify the scryfall batch query was invoked (FROM cards WHERE card_id IN)
    // by checking that execute was called with that SQL pattern
    const calls = mockClient.execute.mock.calls.map((c: unknown[]) =>
      typeof c[0] === "string" ? c[0] : (c[0] as { sql: string }).sql
    );
    const scryfallBatchCall = calls.find(
      (sql: string) => sql.includes("FROM cards") && sql.includes("WHERE card_id IN")
    );
    expect(scryfallBatchCall).toBeDefined();

    // Verify neither the picks query nor the cube query selects scryfall_json
    const picksQuery = calls.find(
      (sql: string) => sql.includes("FROM pick_events pe") && sql.includes("ORDER BY pe.draft_id")
    );
    expect(picksQuery).toBeDefined();
    expect(picksQuery).not.toContain("scryfall_json");

    const cubeQuery = calls.find((sql: string) => sql.includes("FROM cube_snapshot_cards csc"));
    expect(cubeQuery).toBeDefined();
    expect(cubeQuery).not.toContain("scryfall_json");
  });
});
