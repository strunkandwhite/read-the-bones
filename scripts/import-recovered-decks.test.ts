import { describe, it, expect } from "vitest";
import {
  createMemDb,
  insertCard,
  insertDraft,
  insertPickEvent,
} from "../src/core/db/__tests__/testDb";
import {
  resolveDeckFromPicks,
  decideImportWrite,
  diffDeckCards,
  parseImportArgs,
} from "./import-recovered-decks";

async function seedSeat() {
  const client = await createMemDb();
  await insertDraft(client, "baleful-strix");
  await insertCard(client, 1, "Lightning Bolt");
  await insertCard(client, 2, "Brainstorm");
  await insertCard(client, 3, "Counterspell");
  await insertPickEvent(client, "baleful-strix", 1, 3, 1);
  await insertPickEvent(client, "baleful-strix", 2, 3, 2);
  await insertPickEvent(client, "baleful-strix", 3, 3, 3);
  return client;
}

describe("resolveDeckFromPicks", () => {
  it("resolves each card to the id the seat actually drafted", async () => {
    const client = await seedSeat();
    const rows = await resolveDeckFromPicks(client, {
      draftId: "baleful-strix",
      seat: 3,
      maindeckNonBasics: ["Lightning Bolt", "Brainstorm"],
      sideboard: ["Counterspell"],
    });

    expect(rows).toEqual([
      { draftId: "baleful-strix", seat: 3, cardId: 1, zone: "deck", qty: 1 },
      { draftId: "baleful-strix", seat: 3, cardId: 2, zone: "deck", qty: 1 },
      { draftId: "baleful-strix", seat: 3, cardId: 3, zone: "sideboard", qty: 1 },
    ]);
    client.close();
  });

  it("aggregates duplicate copies into qty", async () => {
    const client = await seedSeat();
    const rows = await resolveDeckFromPicks(client, {
      draftId: "baleful-strix",
      seat: 3,
      maindeckNonBasics: ["Lightning Bolt", "Lightning Bolt"],
      sideboard: [],
    });

    expect(rows).toEqual([{ draftId: "baleful-strix", seat: 3, cardId: 1, zone: "deck", qty: 2 }]);
    client.close();
  });

  it("rejects a card the seat never drafted", async () => {
    // A vision transcription error must fail loudly, not write a plausible deck.
    const client = await seedSeat();
    await expect(
      resolveDeckFromPicks(client, {
        draftId: "baleful-strix",
        seat: 3,
        maindeckNonBasics: ["Lightning Bolt", "Black Lotus"],
        sideboard: [],
      })
    ).rejects.toThrow(/Black Lotus/);
    client.close();
  });

  it("rejects every card for a seat with no picks", async () => {
    // An opted-out seat's picks are never ingested, so it is impossible to
    // write a deck for one. That is the privacy guarantee, enforced by construction.
    const client = await seedSeat();
    await expect(
      resolveDeckFromPicks(client, {
        draftId: "baleful-strix",
        seat: 9,
        maindeckNonBasics: ["Lightning Bolt"],
        sideboard: [],
      })
    ).rejects.toThrow(/no picks/i);
    client.close();
  });

  it("resolves a transcription that names only a split card's front face", async () => {
    // A screenshot shows one face. An unresolvable name is a hard failure for
    // the whole file by design, so without front-face folding a single split
    // card would sink an otherwise perfect transcription.
    const client = await createMemDb();
    await insertDraft(client, "terminate");
    await insertCard(client, 20, "Claim // Fame");
    await insertPickEvent(client, "terminate", 1, 2, 20);

    const rows = await resolveDeckFromPicks(client, {
      draftId: "terminate",
      seat: 2,
      maindeckNonBasics: ["Claim"],
      sideboard: [],
    });
    expect(rows[0].cardId).toBe(20);
    client.close();
  });

  it("normalizes numeric suffixes the way pick data does", async () => {
    const client = await createMemDb();
    await insertDraft(client, "tarkir");
    await insertCard(client, 10, "Scalding Tarn");
    await insertPickEvent(client, "tarkir", 1, 4, 10);

    const rows = await resolveDeckFromPicks(client, {
      draftId: "tarkir",
      seat: 4,
      maindeckNonBasics: ["Scalding Tarn 2"],
      sideboard: [],
    });
    expect(rows[0].cardId).toBe(10);
    client.close();
  });
});

describe("decideImportWrite", () => {
  it("writes a seat that has no deck at all", () => {
    expect(decideImportWrite({ hasDeck: false, source: null }, false)).toBe("write");
  });

  it("refuses a seat whose deck came from a sealeddeck URL", () => {
    // The URL is the player's own submission; a screenshot transcription that
    // disagrees with it is a transcription question, not a repair. Overwriting
    // stamps the row `recovered:`, which then blocks `pnpm decklists` from
    // restoring the URL-sourced deck — so the mistake is permanent.
    expect(decideImportWrite({ hasDeck: true, source: "xYz123" }, false)).toBe("refuse-foreign");
  });

  it("refuses a seat holding a deck with no recorded source", () => {
    // Every deck stored before provenance existed came from a URL, so an
    // unstamped row means "we failed to record it", not "nothing to lose".
    expect(decideImportWrite({ hasDeck: true, source: null }, false)).toBe("refuse-foreign");
  });

  it("overwrites a URL-sourced deck when --force is passed", () => {
    expect(decideImportWrite({ hasDeck: true, source: "xYz123" }, true)).toBe("write");
  });

  it("re-imports a previously recovered seat without --force", () => {
    const existing = { hasDeck: true, source: "recovered:baleful-strix-seat-3.json" };
    expect(decideImportWrite(existing, false)).toBe("write");
  });

  it("writes a seat whose deck_hashes row is stamped but whose deck_cards are gone", () => {
    // The `hash = ''` sentinel path leaves provenance behind with no cards.
    // There is nothing to overwrite, so the guard must not block the import.
    expect(decideImportWrite({ hasDeck: false, source: "xYz123" }, false)).toBe("write");
  });
});

describe("diffDeckCards", () => {
  const slot = (cardId: number, zone: string, qty = 1) => ({ cardId, zone, qty });

  it("reports no differences for identical decks", () => {
    const deck = [slot(1, "deck"), slot(2, "sideboard")];
    expect(diffDeckCards(deck, [...deck])).toEqual({
      onlyStored: 0,
      onlyParsed: 0,
      slots: [],
    });
  });

  it("counts a card moved between zones on both sides", () => {
    // The case the integrity checker cannot see: both readings are made of
    // cards the seat drafted, so precision is 1.0 either way.
    const diff = diffDeckCards([slot(1, "sideboard")], [slot(1, "deck")]);
    expect(diff.onlyStored).toBe(1);
    expect(diff.onlyParsed).toBe(1);
    expect(diff.slots).toEqual([
      { cardId: 1, zone: "deck", storedQty: 0, parsedQty: 1 },
      { cardId: 1, zone: "sideboard", storedQty: 1, parsedQty: 0 },
    ]);
  });

  it("counts a differing quantity of the same card as one copy", () => {
    const diff = diffDeckCards([slot(1, "deck", 2)], [slot(1, "deck", 1)]);
    expect(diff).toEqual({
      onlyStored: 1,
      onlyParsed: 0,
      slots: [{ cardId: 1, zone: "deck", storedQty: 2, parsedQty: 1 }],
    });
  });

  it("counts an entirely absent stored deck as all-parsed", () => {
    const diff = diffDeckCards([], [slot(1, "deck"), slot(2, "deck", 2)]);
    expect(diff.onlyStored).toBe(0);
    expect(diff.onlyParsed).toBe(3);
  });
});

describe("parseImportArgs", () => {
  it("defaults both flags off", () => {
    expect(parseImportArgs([])).toEqual({ dryRun: false, force: false });
  });

  it("recognizes --dry-run and --force regardless of order", () => {
    expect(parseImportArgs(["--force", "--dry-run"])).toEqual({ dryRun: true, force: true });
  });

  it("throws on an unrecognized flag instead of silently dropping it", () => {
    // `--dryrun` used to parse as "no flags", turning a rehearsal into a real
    // import against the one production database.
    expect(() => parseImportArgs(["--dryrun"])).toThrow("Unrecognized flag: --dryrun");
  });

  it("throws on an unrecognized flag even when a valid flag is also present", () => {
    expect(() => parseImportArgs(["--dry-run", "--forc"])).toThrow("Unrecognized flag: --forc");
  });
});
