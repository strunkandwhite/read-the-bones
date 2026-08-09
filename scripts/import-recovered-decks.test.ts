import { describe, it, expect } from "vitest";
import { createMemDb, insertCard, insertDraft, insertPickEvent } from "../src/core/db/__tests__/testDb";
import { resolveDeckFromPicks } from "./import-recovered-decks";

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

    expect(rows).toEqual([
      { draftId: "baleful-strix", seat: 3, cardId: 1, zone: "deck", qty: 2 },
    ]);
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
      }),
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
      }),
    ).rejects.toThrow(/no picks/i);
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
