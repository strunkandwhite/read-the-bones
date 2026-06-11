import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { getWipDeck, upsertWipDeck, createSnapshot, getSnapshot } from "./decks";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute(`
    CREATE TABLE decks (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      deck_state TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('wip', 'snapshot')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX idx_decks_wip ON decks(draft_id, seat) WHERE kind = 'wip'
  `);
});

const sampleDeckState = {
  draftId: "tarkir",
  seat: 1,
  zones: {
    deck: { "mv-0-1": ["Card A"], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
    sideboard: { "mv-0-1": [], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
  },
  basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
};

describe("getWipDeck", () => {
  it("returns null when no WIP exists", async () => {
    const result = await getWipDeck(client, "tarkir", 1);
    expect(result).toBeNull();
  });

  it("returns WIP deck state after upsert", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const result = await getWipDeck(client, "tarkir", 1);
    expect(result).not.toBeNull();
    expect(result!.draftId).toBe("tarkir");
    expect(result!.seat).toBe(1);
    expect(result!.deckState.zones.deck["mv-0-1"]).toEqual(["Card A"]);
  });

  it("does not return snapshots", async () => {
    await createSnapshot(client, sampleDeckState);
    const result = await getWipDeck(client, "tarkir", 1);
    expect(result).toBeNull();
  });
});

describe("upsertWipDeck", () => {
  it("creates a new WIP row", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const result = await client.execute({
      sql: "SELECT * FROM decks WHERE kind = 'wip'",
      args: [],
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].draft_id).toBe("tarkir");
  });

  it("updates existing WIP row on conflict", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const updated = {
      ...sampleDeckState,
      zones: {
        ...sampleDeckState.zones,
        deck: { ...sampleDeckState.zones.deck, "mv-0-1": ["Card B"] },
      },
    };
    await upsertWipDeck(client, "tarkir", 1, updated);
    const result = await getWipDeck(client, "tarkir", 1);
    expect(result!.deckState.zones.deck["mv-0-1"]).toEqual(["Card B"]);
  });

  it("allows separate WIP rows for different seats", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const seat2 = { ...sampleDeckState, seat: 2 };
    await upsertWipDeck(client, "tarkir", 2, seat2);
    const result = await client.execute({
      sql: "SELECT * FROM decks WHERE kind = 'wip'",
      args: [],
    });
    expect(result.rows.length).toBe(2);
  });
});

describe("createSnapshot", () => {
  it("creates an immutable snapshot with a generated ID", async () => {
    const { deckId } = await createSnapshot(client, sampleDeckState);
    expect(deckId).toHaveLength(16);
    const result = await client.execute({
      sql: "SELECT * FROM decks WHERE id = ?",
      args: [deckId],
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].kind).toBe("snapshot");
  });

  it("allows multiple snapshots for the same seat+draft", async () => {
    const { deckId: id1 } = await createSnapshot(client, sampleDeckState);
    const { deckId: id2 } = await createSnapshot(client, sampleDeckState);
    expect(id1).not.toBe(id2);
  });
});

describe("getSnapshot", () => {
  it("returns null when snapshot does not exist", async () => {
    const result = await getSnapshot(client, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns snapshot by ID", async () => {
    const { deckId } = await createSnapshot(client, sampleDeckState);
    const result = await getSnapshot(client, deckId);
    expect(result).not.toBeNull();
    expect(result!.deckId).toBe(deckId);
    expect(result!.deckState.zones.deck["mv-0-1"]).toEqual(["Card A"]);
  });

  it("does not return WIP rows", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const row = await client.execute({
      sql: "SELECT id FROM decks WHERE kind = 'wip'",
      args: [],
    });
    const wipId = row.rows[0].id as string;
    const result = await getSnapshot(client, wipId);
    expect(result).toBeNull();
  });
});
