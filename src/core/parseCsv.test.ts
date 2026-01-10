import { describe, it, expect } from "vitest";
import { normalizeCardName, parseDraftPicks, parsePool, parseDraft, buildPlayerNameMap, normalizePlayerName } from "./parseCsv";

describe("buildPlayerNameMap", () => {
  it("should map lowercase names to capitalized variants", () => {
    const names = ["Adhavoc", "adhavoc", "Jack", "Keith"];
    const map = buildPlayerNameMap(names);

    expect(map.get("adhavoc")).toBe("Adhavoc");
    expect(map.get("jack")).toBe("Jack");
    expect(map.get("keith")).toBe("Keith");
  });

  it("should not include all-lowercase names without capitalized variants", () => {
    const names = ["adhavoc", "jack"];
    const map = buildPlayerNameMap(names);

    expect(map.has("adhavoc")).toBe(false);
    expect(map.has("jack")).toBe(false);
  });

  it("should prefer first capitalized variant seen", () => {
    const names = ["AdHavoc", "ADHAVOC"];
    const map = buildPlayerNameMap(names);

    // First capitalized version is stored
    expect(map.get("adhavoc")).toBe("AdHavoc");
  });

  it("should handle empty array", () => {
    const map = buildPlayerNameMap([]);
    expect(map.size).toBe(0);
  });
});

describe("normalizePlayerName", () => {
  it("should normalize lowercase names to capitalized variants", () => {
    const map = new Map([["adhavoc", "Adhavoc"]]);

    expect(normalizePlayerName("adhavoc", map)).toBe("Adhavoc");
  });

  it("should keep capitalized names unchanged", () => {
    const map = new Map([["adhavoc", "Adhavoc"]]);

    expect(normalizePlayerName("Adhavoc", map)).toBe("Adhavoc");
  });

  it("should keep all-lowercase names without canonical variant", () => {
    const map = new Map<string, string>();

    expect(normalizePlayerName("newplayer", map)).toBe("newplayer");
  });

  it("should handle mixed case names (not all lowercase)", () => {
    const map = new Map([["adhavoc", "Adhavoc"]]);

    // "AdHavoc" is not all lowercase, so it doesn't get normalized
    expect(normalizePlayerName("AdHavoc", map)).toBe("AdHavoc");
  });
});

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

describe("parseDraftPicks", () => {
  const minimalCsv = `,,Rotisserie Draft,,,,
,,,,,
,,Jack,Aspi,Neo,↩,,Color1,Color2,Color3
1,→,Phelia,Swords,Reanimate,↩,,W,W,B
2,↪,Mother of Runes,Solitude,Thoughtseize,↩,,W,W,B`;

  it("should parse drafter names from row 3", () => {
    const { picks } = parseDraftPicks(minimalCsv, "test-draft");
    const drafters = [...new Set(picks.map((p) => p.drafterName))];
    expect(drafters).toContain("Jack");
    expect(drafters).toContain("Aspi");
    expect(drafters).toContain("Neo");
  });

  it("should parse pick positions correctly", () => {
    const { picks } = parseDraftPicks(minimalCsv, "test-draft");
    const jackPicks = picks.filter((p) => p.drafterName === "Jack");
    expect(jackPicks).toHaveLength(2);
    // Jack is drafter index 0, with 3 drafters:
    // Round 1 (odd): position = (1-1)*3 + (0+1) = 1
    // Round 2 (even): position = (2-1)*3 + (3-0) = 6
    expect(jackPicks[0].pickPosition).toBe(1);
    expect(jackPicks[1].pickPosition).toBe(6);
  });

  it("should normalize card names", () => {
    const csvWithCopies = `,,Rotisserie Draft,,,,
,,,,,
,,Jack,Aspi,↩,,Color1,Color2
1,→,Scalding Tarn,Swords,↩,,C,W
2,↪,Scalding Tarn 2,Solitude,↩,,C,W`;

    const { picks } = parseDraftPicks(csvWithCopies, "test-draft");
    const jackPicks = picks.filter((p) => p.drafterName === "Jack");

    expect(jackPicks[0].cardName).toBe("Scalding Tarn");
    expect(jackPicks[1].cardName).toBe("Scalding Tarn");
  });

  it("should track copy numbers correctly", () => {
    const csvWithCopies = `,,Rotisserie Draft,,,,
,,,,,
,,Jack,Aspi,↩,,Color1,Color2
1,→,Scalding Tarn,Swords,↩,,C,W
2,↪,Scalding Tarn 2,Scalding Tarn,↩,,C,C`;

    const { picks } = parseDraftPicks(csvWithCopies, "test-draft");
    const tarnPicks = picks.filter((p) => p.cardName === "Scalding Tarn");

    expect(tarnPicks).toHaveLength(3);
    expect(tarnPicks[0].copyNumber).toBe(1); // Jack's pick 1
    expect(tarnPicks[1].copyNumber).toBe(2); // Aspi's pick 2
    expect(tarnPicks[2].copyNumber).toBe(3); // Jack's pick 2 (Scalding Tarn 2)
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
,,Jack,Aspi,↩,,C,W
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
,,Jack,Aspi,↩,,C,W
1,→,Card1,,↩,,W,`;

    const { picks } = parseDraftPicks(csvWithEmpty, "test-draft");
    expect(picks).toHaveLength(1);
    expect(picks[0].cardName).toBe("Card1");
  });

  it("should parse colors correctly", () => {
    const csvWithColors = `,,Rotisserie Draft,,,,
,,,,,
,,Jack,Aspi,Neo,↩,,Color1,Color2,Color3
1,→,Phelia,Swords,Reanimate,↩,,W,W,B
2,↪,Mother of Runes,Solitude,Thoughtseize,↩,,W,W,UB`;

    const { picks } = parseDraftPicks(csvWithColors, "test-draft");

    // Check that colors are parsed
    // Phelia: Jack (index 0), round 1 → position 1
    const pheliaPick = picks.find((p) => p.cardName === "Phelia" && p.pickPosition === 1);
    expect(pheliaPick?.color).toBe("W");

    // Thoughtseize: Neo (index 2), round 2 (even) with 3 drafters
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
,,Jack,Aspi,↩,,C,W
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

  it("should assign 'Unpicked' as drafter name for unpicked cards", () => {
    const { picks } = parseDraft(picksCsv, poolCsv, "test-draft");
    const unpickedCards = picks.filter((p) => !p.wasPicked);

    unpickedCards.forEach((card) => {
      expect(card.drafterName).toBe("Unpicked");
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
,,Jack,Aspi,↩,,C,C
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
,,Jack,Aspi,arborist,Neo,Murmurtwin,Ray Bees,Last Abzan,Max,Mr. Fancypants,baronvonfonz,Greg,Keith,,,,,,,,,,,,,,,,,,,,
1,→,"Phelia, Exuberant Shepherd",Swords to Plowshares,Reanimate,Fable of the Mirror-Breaker,Badgermole Cub,"Wan Shi Tong, All-Knowing","Sheoldred, the Apocalypse",Quantum Riddler,"Ragavan, Nimble Pilferer",Strip Mine,"Urza, Lord High Artificer",Birds of Paradise,↩, ,,,Draft Status,,,,W,W,B,R,G,U,B,U,R,C,U,G
2,↪,Mother of Runes,Solitude,Thoughtseize,Fury,Ignoble Hierarch,Stock Up,Demonic Tutor,Ephemerate,Cori-Steel Cutter,Icetill Explorer,Pyrogoyf,Noble Hierarch,,,,,Double Picks After:,25,,,W,W,B,R,BRG,U,B,W,R,G,R,WUG`;

  it("should parse all 12 drafters", () => {
    const { picks, numDrafters } = parseDraftPicks(realStylePicksCsv, "real-draft");
    const drafters = [...new Set(picks.map((p) => p.drafterName))];

    expect(drafters).toHaveLength(12);
    expect(drafters).toContain("Jack");
    expect(drafters).toContain("Aspi");
    expect(drafters).toContain("Keith");
    expect(numDrafters).toBe(12);
  });

  it("should parse 24 picks (12 drafters x 2 picks)", () => {
    const { picks } = parseDraftPicks(realStylePicksCsv, "real-draft");
    expect(picks).toHaveLength(24);
  });

  it("should correctly associate colors with picks", () => {
    const { picks } = parseDraftPicks(realStylePicksCsv, "real-draft");

    // Jack (index 0), round 1 (odd): position = 1
    const jackPick1 = picks.find((p) => p.drafterName === "Jack" && p.pickPosition === 1);
    expect(jackPick1?.color).toBe("W");

    // Keith (index 11), round 1 (odd): position = (1-1)*12 + (11+1) = 12
    const keithPick1 = picks.find((p) => p.drafterName === "Keith" && p.pickPosition === 12);
    expect(keithPick1?.color).toBe("G");

    // Murmurtwin (index 4), round 2 (even): position = (2-1)*12 + (12-4) = 20
    const murmurPick2 = picks.find((p) => p.drafterName === "Murmurtwin" && p.pickPosition === 20);
    expect(murmurPick2?.color).toBe("BRG");
  });

  it("should handle quoted card names with commas", () => {
    const { picks } = parseDraftPicks(realStylePicksCsv, "real-draft");

    const pheliaPick = picks.find((p) => p.cardName === "Phelia, Exuberant Shepherd");
    expect(pheliaPick).toBeDefined();
    expect(pheliaPick?.drafterName).toBe("Jack");
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
