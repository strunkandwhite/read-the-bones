import { describe, it, expect } from "vitest";
import { normalizeCardName, cardNameKey, parseDraftPicks, parsePool, parseDraft } from "./parseCsv";

describe("normalizeCardName", () => {
  it("should strip numeric suffixes", () => {
    expect(normalizeCardName("Scalding Tarn 2")).toBe("Scalding Tarn");
    expect(normalizeCardName("Mishra's Bauble 5")).toBe("Mishra's Bauble");
  });

  it("should handle names without suffixes", () => {
    expect(normalizeCardName("Lightning Bolt")).toBe("Lightning Bolt");
    expect(normalizeCardName("Phelia, Exuberant Shepherd")).toBe("Phelia, Exuberant Shepherd");
  });

  it("should handle edge cases", () => {
    expect(normalizeCardName("")).toBe("");
    expect(normalizeCardName("  Scalding Tarn 2  ")).toBe("Scalding Tarn");
    expect(normalizeCardName("Card 10")).toBe("Card");
  });

  it("should preserve numbers in card names that are not suffixes", () => {
    expect(normalizeCardName("Phyrexia: All Will Be One")).toBe("Phyrexia: All Will Be One");
  });
});

describe("cardNameKey", () => {
  it("should return lowercase for case-insensitive matching", () => {
    expect(cardNameKey("Lightning Bolt")).toBe("lightning bolt");
    expect(cardNameKey("Lightning bolt")).toBe("lightning bolt");
    expect(cardNameKey("lightning bolt")).toBe("lightning bolt");
    expect(cardNameKey("LIGHTNING BOLT")).toBe("lightning bolt");
  });

  it("should strip numeric suffix and lowercase", () => {
    expect(cardNameKey("Scalding Tarn 2")).toBe("scalding tarn");
  });

  it("should handle edge cases", () => {
    expect(cardNameKey("")).toBe("");
    expect(cardNameKey("  Scalding Tarn 2  ")).toBe("scalding tarn");
  });
});

describe("parseDraftPicks", () => {
  const minimalCsv = `,,Rotisserie Draft,,,,
,,,,,
,,Alice,Bob,Carol,↩,,Color1,Color2,Color3
1,→,Phelia,Swords,Reanimate,↩,,W,W,B
2,↪,Mother of Runes,Solitude,Thoughtseize,↩,,W,W,B`;

  it("should parse pick positions correctly", () => {
    const { picks } = parseDraftPicks(minimalCsv, "test-draft");
    // With 3 drafters, 2 rounds = 6 picks total
    expect(picks).toHaveLength(6);
    // Drafter index 0, round 1 (odd): position = (1-1)*3 + (0+1) = 1
    // Drafter index 0, round 2 (even): position = (2-1)*3 + (3-0) = 6
    const pick1 = picks.find((p) => p.pickPosition === 1);
    const pick6 = picks.find((p) => p.pickPosition === 6);
    expect(pick1?.cardName).toBe("Phelia");
    expect(pick6?.cardName).toBe("Mother of Runes");
  });

  it("should normalize card names", () => {
    const csvWithCopies = `,,Rotisserie Draft,,,,
,,,,,
,,Alice,Bob,↩,,Color1,Color2
1,→,Scalding Tarn,Swords,↩,,C,W
2,↪,Scalding Tarn 2,Solitude,↩,,C,W`;

    const { picks } = parseDraftPicks(csvWithCopies, "test-draft");
    // Pick positions 1 and 4 are from drafter index 0 (first column)
    const pick1 = picks.find((p) => p.pickPosition === 1);
    const pick4 = picks.find((p) => p.pickPosition === 4);

    expect(pick1?.cardName).toBe("Scalding Tarn");
    expect(pick4?.cardName).toBe("Scalding Tarn");
  });

  it("should track copy numbers correctly", () => {
    const csvWithCopies = `,,Rotisserie Draft,,,,
,,,,,
,,Alice,Bob,↩,,Color1,Color2
1,→,Scalding Tarn,Swords,↩,,C,W
2,↪,Scalding Tarn 2,Scalding Tarn,↩,,C,C`;

    const { picks } = parseDraftPicks(csvWithCopies, "test-draft");
    const tarnPicks = picks.filter((p) => p.cardName === "Scalding Tarn");

    expect(tarnPicks).toHaveLength(3);
    expect(tarnPicks[0].copyNumber).toBe(1); // Alice's pick 1
    expect(tarnPicks[1].copyNumber).toBe(2); // Bob's pick 2
    expect(tarnPicks[2].copyNumber).toBe(3); // Alice's pick 2 (Scalding Tarn 2)
  });

  it("should set draftId on all picks", () => {
    const { picks } = parseDraftPicks(minimalCsv, "my-draft-id");
    picks.forEach((pick) => {
      expect(pick.draftId).toBe("my-draft-id");
    });
  });

  it("should mark all picks as picked", () => {
    const { picks } = parseDraftPicks(minimalCsv, "test-draft");
    picks.forEach((pick) => {
      expect(pick.wasPicked).toBe(true);
    });
  });

  it("should handle empty CSV", () => {
    const { picks } = parseDraftPicks("", "test-draft");
    expect(picks).toEqual([]);
  });

  it("should handle CSV with only headers", () => {
    const headerOnly = `,,Rotisserie Draft
,,`;
    const { picks } = parseDraftPicks(headerOnly, "test-draft");
    expect(picks).toEqual([]);
  });

  it("should skip rows with invalid pick numbers", () => {
    const csvWithInvalid = `,,Rotisserie Draft,,
,,,
,,Alice,Bob,↩,,C,W
1,→,Card1,Card2,↩,,W,W
invalid,→,Card3,Card4,↩,,U,U
2,→,Card5,Card6,↩,,B,B`;

    const { picks } = parseDraftPicks(csvWithInvalid, "test-draft");
    const pickNumbers = [...new Set(picks.map((p) => p.pickPosition))];
    expect(pickNumbers).toContain(1);
    expect(pickNumbers).toContain(2);
    expect(pickNumbers).not.toContain(NaN);
  });

  it("should skip empty card cells", () => {
    const csvWithEmpty = `,,Rotisserie Draft,,
,,,
,,Alice,Bob,↩,,C,W
1,→,Card1,,↩,,W,`;

    const { picks } = parseDraftPicks(csvWithEmpty, "test-draft");
    expect(picks).toHaveLength(1);
    expect(picks[0].cardName).toBe("Card1");
  });

  it("should parse colors correctly", () => {
    const csvWithColors = `,,Rotisserie Draft,,,,
,,,,,
,,Alice,Bob,Carol,↩,,Color1,Color2,Color3
1,→,Phelia,Swords,Reanimate,↩,,W,W,B
2,↪,Mother of Runes,Solitude,Thoughtseize,↩,,W,W,UB`;

    const { picks } = parseDraftPicks(csvWithColors, "test-draft");

    // Check that colors are parsed
    // Phelia: Alice (index 0), round 1 -> position 1
    const pheliaPick = picks.find((p) => p.cardName === "Phelia" && p.pickPosition === 1);
    expect(pheliaPick?.color).toBe("W");

    // Thoughtseize: Carol (index 2), round 2 (even) with 3 drafters
    // position = (2-1)*3 + (3-2) = 4
    const thoughtseizePick = picks.find(
      (p) => p.cardName === "Thoughtseize" && p.pickPosition === 4
    );
    expect(thoughtseizePick?.color).toBe("UB");
  });

  it("should return numDrafters", () => {
    const { numDrafters } = parseDraftPicks(minimalCsv, "test-draft");
    expect(numDrafters).toBe(3);
  });

  it("should stop collecting drafter names at empty cells", () => {
    // Simulate a CSV where there's an Excel error (#NUM!) after empty cells
    // The parser should stop at empty cells and not include #NUM! as a drafter
    const csvWithExcelError = `,,Rotisserie Draft,,,,
,,,,,
,,Alice,Bob,Carol,,,#NUM!,,
1,→,Card1,Card2,Card3,,,,,`;

    const { picks, numDrafters } = parseDraftPicks(csvWithExcelError, "test-draft");

    // Should only find 3 drafters, not 4 (shouldn't include #NUM!)
    expect(numDrafters).toBe(3);
    // Only 3 picks (one per drafter)
    expect(picks).toHaveLength(3);
  });
});

describe("parsePool", () => {
  const poolCsv = `✓,Card,Type,Color
✓,Phelia,Creature,W
,Unpicked Card,Instant,U
✓,Swords to Plowshares,Instant,W
,Another Unpicked,Sorcery,BR`;

  it("should return all card names", () => {
    const allCards = parsePool(poolCsv);
    expect(allCards).toContain("Phelia");
    expect(allCards).toContain("Unpicked Card");
    expect(allCards).toContain("Swords to Plowshares");
    expect(allCards).toContain("Another Unpicked");
    expect(allCards).toHaveLength(4);
  });

  it("should handle empty pool", () => {
    const allCards = parsePool("");
    expect(allCards).toEqual([]);
  });

  it("should skip header row", () => {
    const allCards = parsePool(poolCsv);
    expect(allCards).not.toContain("Card");
  });

  it("should normalize card names with numeric suffixes", () => {
    const poolWithCopies = `✓,Card,Type,Color
✓,Scalding Tarn,Land,C
✓,Scalding Tarn 2,Land,C`;

    const allCards = parsePool(poolWithCopies);
    expect(allCards[0]).toBe("Scalding Tarn");
    expect(allCards[1]).toBe("Scalding Tarn");
  });
});

describe("parseDraft", () => {
  const picksCsv = `,,Rotisserie Draft,,
,,,
,,Alice,Bob,↩,,C,W
1,→,Card1,Card2,↩,,W,U`;

  const poolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W
✓,Card2,Instant,U
,Unpicked1,Sorcery,B
,Unpicked2,Enchantment,G`;

  it("should combine picks and unpicked cards", () => {
    const { picks } = parseDraft(picksCsv, poolCsv, "test-draft");

    const pickedCards = picks.filter((p) => p.wasPicked);
    const unpickedCards = picks.filter((p) => !p.wasPicked);

    expect(pickedCards).toHaveLength(2);
    expect(unpickedCards).toHaveLength(2);
  });

  it("should return correct pool size", () => {
    const { poolSize } = parseDraft(picksCsv, poolCsv, "test-draft");
    expect(poolSize).toBe(4);
  });

  it("should assign poolSize as pickPosition for unpicked cards", () => {
    const { picks, poolSize } = parseDraft(picksCsv, poolCsv, "test-draft");
    const unpickedCards = picks.filter((p) => !p.wasPicked);

    unpickedCards.forEach((card) => {
      expect(card.pickPosition).toBe(poolSize);
    });
  });

  it("should preserve colors for unpicked cards", () => {
    const { picks } = parseDraft(picksCsv, poolCsv, "test-draft");
    const unpickedCards = picks.filter((p) => !p.wasPicked);

    const unpicked1 = unpickedCards.find((c) => c.cardName === "Unpicked1");
    expect(unpicked1?.color).toBe("B");

    const unpicked2 = unpickedCards.find((c) => c.cardName === "Unpicked2");
    expect(unpicked2?.color).toBe("G");
  });

  it("should continue copy numbering for unpicked copies", () => {
    const picksWithCopy = `,,Rotisserie Draft,,
,,,
,,Alice,Bob,↩,,C,C
1,→,Scalding Tarn,Scalding Tarn 2,↩,,C,C`;

    const poolWithCopy = `✓,Card,Type,Color
✓,Scalding Tarn,Land,C
✓,Scalding Tarn 2,Land,C
,Scalding Tarn 3,Land,C`;

    const { picks } = parseDraft(picksWithCopy, poolWithCopy, "test-draft");
    const tarnPicks = picks.filter((p) => p.cardName === "Scalding Tarn");

    expect(tarnPicks).toHaveLength(3);
    // Picked copies
    expect(tarnPicks[0].copyNumber).toBe(1);
    expect(tarnPicks[1].copyNumber).toBe(2);
    // Unpicked copy should be 3
    const unpickedTarn = tarnPicks.find((p) => !p.wasPicked);
    expect(unpickedTarn?.copyNumber).toBe(3);
  });

  it("should set draftId on all records", () => {
    const { picks } = parseDraft(picksCsv, poolCsv, "my-draft-123");

    picks.forEach((pick) => {
      expect(pick.draftId).toBe("my-draft-123");
    });
  });
});

describe("integration with real CSV structure", () => {
  // This mimics the actual CSV structure from the data files
  const realStylePicksCsv = `,,Rotisserie Draft,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
,,Alice,Bob,Carol,Dave,Eve,Frank,Grace,Henry,Ivy,Jack,Kate,Leo,,,,,,,,,,,,,,,,,,,,
1,→,"Phelia, Exuberant Shepherd",Swords to Plowshares,Reanimate,Fable of the Mirror-Breaker,Badgermole Cub,"Wan Shi Tong, All-Knowing","Sheoldred, the Apocalypse",Quantum Riddler,"Ragavan, Nimble Pilferer",Strip Mine,"Urza, Lord High Artificer",Birds of Paradise,↩, ,,,Draft Status,,,,W,W,B,R,G,U,B,U,R,C,U,G
2,↪,Mother of Runes,Solitude,Thoughtseize,Fury,Ignoble Hierarch,Stock Up,Demonic Tutor,Ephemerate,Cori-Steel Cutter,Icetill Explorer,Pyrogoyf,Noble Hierarch,,,,,Double Picks After:,25,,,W,W,B,R,BRG,U,B,W,R,G,R,WUG`;

  it("should parse all 12 drafters", () => {
    const { picks, numDrafters } = parseDraftPicks(realStylePicksCsv, "real-draft");

    // 12 drafters x 2 rounds = 24 picks
    expect(picks).toHaveLength(24);
    expect(numDrafters).toBe(12);
  });

  it("should parse 24 picks (12 drafters x 2 picks)", () => {
    const { picks } = parseDraftPicks(realStylePicksCsv, "real-draft");
    expect(picks).toHaveLength(24);
  });

  it("should correctly associate colors with picks", () => {
    const { picks } = parseDraftPicks(realStylePicksCsv, "real-draft");

    // Drafter index 0, round 1 (odd): position = 1
    const pick1 = picks.find((p) => p.pickPosition === 1);
    expect(pick1?.color).toBe("W");

    // Drafter index 11, round 1 (odd): position = (1-1)*12 + (11+1) = 12
    const pick12 = picks.find((p) => p.pickPosition === 12);
    expect(pick12?.color).toBe("G");

    // Drafter index 4, round 2 (even): position = (2-1)*12 + (12-4) = 20
    const pick20 = picks.find((p) => p.pickPosition === 20);
    expect(pick20?.color).toBe("BRG");
  });

  it("should handle quoted card names with commas", () => {
    const { picks } = parseDraftPicks(realStylePicksCsv, "real-draft");

    const pheliaPick = picks.find((p) => p.cardName === "Phelia, Exuberant Shepherd");
    expect(pheliaPick).toBeDefined();
    // Pick position 1 is drafter index 0 in round 1
    expect(pheliaPick?.pickPosition).toBe(1);
  });

  // Test the real Cube CSV structure
  const realStylePoolCsv = `✓,Card,Type,Color,View,Picked By,
✓,Descendant of Storms,Creature — Human Soldier,W,View,LastAbzan,$D$44
✓,Esper Sentinel,Artifact Creature — Human Soldier,W,View,ThorH,$H$13
,Kytheon Hero of Akros,Legendary Creature — Human Soldier,W,View,,
✓,Mother of Runes,Creature — Human Cleric,W,View,LastAbzan,$D$5`;

  it("should parse all cards from real pool format", () => {
    const allCards = parsePool(realStylePoolCsv);

    expect(allCards).toHaveLength(4);
    expect(allCards).toContain("Descendant of Storms");
    expect(allCards).toContain("Esper Sentinel");
    expect(allCards).toContain("Kytheon Hero of Akros");
    expect(allCards).toContain("Mother of Runes");
  });
});
