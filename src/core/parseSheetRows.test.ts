import { describe, it, expect } from "vitest";
import {
  normalizeCardName,
  cardNameKey,
  isArrow,
  isDraftComplete,
  parsePoolRows,
  parsePickRows,
  parseMatchRows,
} from "./parseSheetRows";

describe("normalizeCardName", () => {
  it("should strip numeric suffixes", () => {
    expect(normalizeCardName("Scalding Tarn 2")).toBe("Scalding Tarn");
    expect(normalizeCardName("Mishra's Bauble 5")).toBe("Mishra's Bauble");
  });

  it("should handle names without suffixes", () => {
    expect(normalizeCardName("Lightning Bolt")).toBe("Lightning Bolt");
    expect(normalizeCardName("Phelia, Exuberant Shepherd")).toBe(
      "Phelia, Exuberant Shepherd"
    );
  });

  it("should handle edge cases", () => {
    expect(normalizeCardName("")).toBe("");
    expect(normalizeCardName("  Scalding Tarn 2  ")).toBe("Scalding Tarn");
    expect(normalizeCardName("Card 10")).toBe("Card");
  });

  it("should preserve numbers in card names that are not suffixes", () => {
    expect(normalizeCardName("Phyrexia: All Will Be One")).toBe(
      "Phyrexia: All Will Be One"
    );
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

  it("should normalize DFC names to front face", () => {
    expect(cardNameKey("Brazen Borrower // Petty Theft")).toBe("brazen borrower");
    expect(cardNameKey("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki")).toBe(
      "fable of the mirror-breaker"
    );
  });

  it("should return same key for front-face-only and full DFC name", () => {
    expect(cardNameKey("Brazen Borrower")).toBe(cardNameKey("Brazen Borrower // Petty Theft"));
    expect(cardNameKey("Concealing Curtains")).toBe(
      cardNameKey("Concealing Curtains // Revealing Eye")
    );
  });
});

describe("isArrow", () => {
  it("should recognize arrow characters", () => {
    expect(isArrow("→")).toBe(true);
    expect(isArrow("↪")).toBe(true);
    expect(isArrow("↩")).toBe(true);
    expect(isArrow("✪")).toBe(true);
  });

  it("should handle whitespace", () => {
    expect(isArrow(" → ")).toBe(true);
    expect(isArrow("  ✪  ")).toBe(true);
  });

  it("should reject non-arrow values", () => {
    expect(isArrow("")).toBe(false);
    expect(isArrow("Alice")).toBe(false);
    expect(isArrow("->")).toBe(false);
    expect(isArrow("VS")).toBe(false);
  });
});

describe("isDraftComplete", () => {
  it("should return true when ✪ row has picks", () => {
    const rows = [
      ["", "", "Header"],
      ["", ""],
      ["", "", "Alice", "Bob", "↩"],
      ["1", "→", "Card1", "Card2", "↩"],
      ["2", "✪", "Card3", "Card4", "↩"],
    ];
    expect(isDraftComplete(rows)).toBe(true);
  });

  it("should return false when ✪ row has no picks", () => {
    const rows = [
      ["", "", "Header"],
      ["", ""],
      ["", "", "Alice", "Bob", "↩"],
      ["1", "→", "Card1", "Card2", "↩"],
      ["2", "✪", "", "", "↩"],
    ];
    expect(isDraftComplete(rows)).toBe(false);
  });

  it("should return false when ✪ row has only arrow in drafter column", () => {
    const rows = [
      ["", "", "Header"],
      ["", ""],
      ["", "", "Alice", "Bob", "↩"],
      ["1", "→", "Card1", "Card2", "↩"],
      ["2", "✪", "↩", "", ""],
    ];
    expect(isDraftComplete(rows)).toBe(false);
  });

  it("should return true when no ✪ marker found", () => {
    const rows = [
      ["", "", "Header"],
      ["", ""],
      ["", "", "Alice", "Bob", "↩"],
      ["1", "→", "Card1", "Card2", "↩"],
    ];
    expect(isDraftComplete(rows)).toBe(true);
  });

  it("should handle empty rows", () => {
    expect(isDraftComplete([])).toBe(true);
    expect(isDraftComplete([[""]])).toBe(true);
  });
});

describe("parsePoolRows", () => {
  const poolRows = [
    ["✓", "Card", "Type", "Color"],
    ["✓", "Phelia", "Creature", "W"],
    ["", "Unpicked Card", "Instant", "U"],
    ["✓", "Swords to Plowshares", "Instant", "W"],
    ["", "Another Unpicked", "Sorcery", "BR"],
  ];

  it("should return all card names", () => {
    const allCards = parsePoolRows(poolRows);
    expect(allCards).toContain("Phelia");
    expect(allCards).toContain("Unpicked Card");
    expect(allCards).toContain("Swords to Plowshares");
    expect(allCards).toContain("Another Unpicked");
    expect(allCards).toHaveLength(4);
  });

  it("should handle empty rows", () => {
    expect(parsePoolRows([])).toEqual([]);
  });

  it("should skip header row", () => {
    const allCards = parsePoolRows(poolRows);
    expect(allCards).not.toContain("Card");
  });

  it("should normalize card names with numeric suffixes", () => {
    const poolWithCopies = [
      ["✓", "Card", "Type", "Color"],
      ["✓", "Scalding Tarn", "Land", "C"],
      ["✓", "Scalding Tarn 2", "Land", "C"],
    ];
    const allCards = parsePoolRows(poolWithCopies);
    expect(allCards[0]).toBe("Scalding Tarn");
    expect(allCards[1]).toBe("Scalding Tarn");
  });

  it("should skip rows with empty card names", () => {
    const poolWithEmpty = [
      ["✓", "Card", "Type", "Color"],
      ["✓", "Valid Card", "Creature", "W"],
      ["✓", "", "Instant", "U"],
      ["✓", "  ", "Sorcery", "B"],
    ];
    const allCards = parsePoolRows(poolWithEmpty);
    expect(allCards).toHaveLength(1);
    expect(allCards[0]).toBe("Valid Card");
  });

  it("should skip rows with fewer than 2 columns", () => {
    const poolWithShortRows = [
      ["✓", "Card", "Type", "Color"],
      ["✓"],
      ["✓", "Valid Card", "Creature", "W"],
    ];
    const allCards = parsePoolRows(poolWithShortRows);
    expect(allCards).toHaveLength(1);
  });
});

describe("parsePickRows", () => {
  // Minimal 3-drafter, 2-round draft as row arrays
  const minimalRows = [
    ["", "", "Rotisserie Draft", "", "", "", ""],
    ["", "", "", "", "", ""],
    ["", "", "Alice", "Bob", "Carol", "↩", "", "Color1", "Color2", "Color3"],
    ["1", "→", "Phelia", "Swords", "Reanimate", "↩", "", "W", "W", "B"],
    [
      "2",
      "↪",
      "Mother of Runes",
      "Solitude",
      "Thoughtseize",
      "↩",
      "",
      "W",
      "W",
      "UB",
    ],
  ];

  it("should parse pick positions correctly", () => {
    const { picks } = parsePickRows(minimalRows, "test-draft");
    expect(picks).toHaveLength(6);
    // Drafter index 0, round 1 (odd): position = (1-1)*3 + (0+1) = 1
    // Drafter index 0, round 2 (even): position = (2-1)*3 + (3-0) = 6
    const pick1 = picks.find((p) => p.pickPosition === 1);
    const pick6 = picks.find((p) => p.pickPosition === 6);
    expect(pick1?.cardName).toBe("Phelia");
    expect(pick6?.cardName).toBe("Mother of Runes");
  });

  it("should normalize card names", () => {
    const rowsWithCopies = [
      ["", "", "Rotisserie Draft", "", "", "", ""],
      ["", "", "", "", "", ""],
      ["", "", "Alice", "Bob", "↩", "", "Color1", "Color2"],
      ["1", "→", "Scalding Tarn", "Swords", "↩", "", "C", "W"],
      ["2", "↪", "Scalding Tarn 2", "Solitude", "↩", "", "C", "W"],
    ];

    const { picks } = parsePickRows(rowsWithCopies, "test-draft");
    const pick1 = picks.find((p) => p.pickPosition === 1);
    const pick4 = picks.find((p) => p.pickPosition === 4);

    expect(pick1?.cardName).toBe("Scalding Tarn");
    expect(pick4?.cardName).toBe("Scalding Tarn");
  });

  it("should track copy numbers correctly", () => {
    const rowsWithCopies = [
      ["", "", "Rotisserie Draft", "", "", "", ""],
      ["", "", "", "", "", ""],
      ["", "", "Alice", "Bob", "↩", "", "Color1", "Color2"],
      ["1", "→", "Scalding Tarn", "Swords", "↩", "", "C", "W"],
      ["2", "↪", "Scalding Tarn 2", "Scalding Tarn", "↩", "", "C", "C"],
    ];

    const { picks } = parsePickRows(rowsWithCopies, "test-draft");
    const tarnPicks = picks.filter((p) => p.cardName === "Scalding Tarn");

    expect(tarnPicks).toHaveLength(3);
    expect(tarnPicks[0].copyNumber).toBe(1); // Alice's pick 1
    expect(tarnPicks[1].copyNumber).toBe(2); // Bob's pick 2
    expect(tarnPicks[2].copyNumber).toBe(3); // Alice's pick 2 (Scalding Tarn 2)
  });

  it("should set draftId on all picks", () => {
    const { picks } = parsePickRows(minimalRows, "my-draft-id");
    picks.forEach((pick) => {
      expect(pick.draftId).toBe("my-draft-id");
    });
  });

  it("should mark all picks as picked", () => {
    const { picks } = parsePickRows(minimalRows, "test-draft");
    picks.forEach((pick) => {
      expect(pick.wasPicked).toBe(true);
    });
  });

  it("should handle empty rows", () => {
    const { picks } = parsePickRows([], "test-draft");
    expect(picks).toEqual([]);
  });

  it("should handle rows with only headers", () => {
    const headerOnly = [
      ["", "", "Rotisserie Draft"],
      ["", ""],
    ];
    const { picks } = parsePickRows(headerOnly, "test-draft");
    expect(picks).toEqual([]);
  });

  it("should skip rows with invalid pick numbers", () => {
    const rowsWithInvalid = [
      ["", "", "Rotisserie Draft", "", ""],
      ["", "", "", ""],
      ["", "", "Alice", "Bob", "↩", "", "C", "W"],
      ["1", "→", "Card1", "Card2", "↩", "", "W", "W"],
      ["invalid", "→", "Card3", "Card4", "↩", "", "U", "U"],
      ["2", "→", "Card5", "Card6", "↩", "", "B", "B"],
    ];

    const { picks } = parsePickRows(rowsWithInvalid, "test-draft");
    const pickNumbers = [...new Set(picks.map((p) => p.pickPosition))];
    expect(pickNumbers).toContain(1);
    expect(pickNumbers).toContain(2);
    expect(pickNumbers).not.toContain(NaN);
  });

  it("should skip empty card cells", () => {
    const rowsWithEmpty = [
      ["", "", "Rotisserie Draft", "", ""],
      ["", "", "", ""],
      ["", "", "Alice", "Bob", "↩", "", "C", "W"],
      ["1", "→", "Card1", "", "↩", "", "W", ""],
    ];

    const { picks } = parsePickRows(rowsWithEmpty, "test-draft");
    expect(picks).toHaveLength(1);
    expect(picks[0].cardName).toBe("Card1");
  });

  it("should parse colors correctly", () => {
    const { picks } = parsePickRows(minimalRows, "test-draft");

    const pheliaPick = picks.find(
      (p) => p.cardName === "Phelia" && p.pickPosition === 1
    );
    expect(pheliaPick?.color).toBe("W");

    // Thoughtseize: Carol (index 2), round 2 (even) with 3 drafters
    // position = (2-1)*3 + (3-2) = 4
    const thoughtseizePick = picks.find(
      (p) => p.cardName === "Thoughtseize" && p.pickPosition === 4
    );
    expect(thoughtseizePick?.color).toBe("UB");
  });

  it("should return numDrafters", () => {
    const { numDrafters } = parsePickRows(minimalRows, "test-draft");
    expect(numDrafters).toBe(3);
  });

  it("should return drafterNames", () => {
    const { drafterNames } = parsePickRows(minimalRows, "test-draft");
    expect(drafterNames).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("should stop collecting drafter names at empty cells", () => {
    const rowsWithExcelError = [
      ["", "", "Rotisserie Draft", "", "", "", ""],
      ["", "", "", "", "", ""],
      ["", "", "Alice", "Bob", "Carol", "", "", "#NUM!", "", ""],
      ["1", "→", "Card1", "Card2", "Card3", "", "", "", "", ""],
    ];

    const { picks, numDrafters } = parsePickRows(
      rowsWithExcelError,
      "test-draft"
    );
    expect(numDrafters).toBe(3);
    expect(picks).toHaveLength(3);
  });

  it("should return isComplete based on ✪ marker", () => {
    const incompleteRows = [
      ["", "", "Header"],
      ["", ""],
      ["", "", "Alice", "Bob", "↩"],
      ["1", "→", "Card1", "Card2", "↩"],
      ["2", "✪", "", "", "↩"],
    ];
    const { isComplete } = parsePickRows(incompleteRows, "test-draft");
    expect(isComplete).toBe(false);
  });

  it("should return isComplete true when ✪ row has picks", () => {
    const completeRows = [
      ["", "", "Header"],
      ["", ""],
      ["", "", "Alice", "Bob", "↩"],
      ["1", "→", "Card1", "Card2", "↩"],
      ["2", "✪", "Card3", "Card4", "↩"],
    ];
    const { isComplete } = parsePickRows(completeRows, "test-draft");
    expect(isComplete).toBe(true);
  });

  it("should return isComplete true when no ✪ marker", () => {
    const { isComplete } = parsePickRows(minimalRows, "test-draft");
    expect(isComplete).toBe(true);
  });
});

describe("parsePickRows with 12 drafters (real-style data)", () => {
  // Mimics the actual sheet structure with 12 drafters
  const realStyleRows = [
    [
      "",
      "",
      "Rotisserie Draft",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
    ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    [
      "",
      "",
      "Alice",
      "Bob",
      "Carol",
      "Dave",
      "Eve",
      "Frank",
      "Grace",
      "Henry",
      "Ivy",
      "Jack",
      "Kate",
      "Leo",
      "",
      "",
      "",
      "",
      "Draft Status",
      "",
      "",
      "",
    ],
    [
      "1",
      "→",
      "Phelia, Exuberant Shepherd",
      "Swords to Plowshares",
      "Reanimate",
      "Fable of the Mirror-Breaker",
      "Badgermole Cub",
      "Wan Shi Tong, All-Knowing",
      "Sheoldred, the Apocalypse",
      "Quantum Riddler",
      "Ragavan, Nimble Pilferer",
      "Strip Mine",
      "Urza, Lord High Artificer",
      "Birds of Paradise",
      "↩",
      " ",
      "",
      "",
      "Draft Status",
      "",
      "",
      "",
      "W",
      "W",
      "B",
      "R",
      "G",
      "U",
      "B",
      "U",
      "R",
      "C",
      "U",
      "G",
    ],
    [
      "2",
      "↪",
      "Mother of Runes",
      "Solitude",
      "Thoughtseize",
      "Fury",
      "Ignoble Hierarch",
      "Stock Up",
      "Demonic Tutor",
      "Ephemerate",
      "Cori-Steel Cutter",
      "Icetill Explorer",
      "Pyrogoyf",
      "Noble Hierarch",
      "",
      "",
      "",
      "Double Picks After:",
      "25",
      "",
      "",
      "",
      "W",
      "W",
      "B",
      "R",
      "BRG",
      "U",
      "B",
      "W",
      "R",
      "G",
      "R",
      "WUG",
    ],
  ];

  it("should parse all 12 drafters", () => {
    const { picks, numDrafters, picksPerPlayer } = parsePickRows(realStyleRows, "real-draft");
    expect(picks).toHaveLength(24);
    expect(numDrafters).toBe(12);
    expect(picksPerPlayer).toBe(2); // max round number from column A
  });

  it("should correctly associate colors with picks", () => {
    const { picks } = parsePickRows(realStyleRows, "real-draft");

    // Drafter index 0, round 1 (odd): position = 1
    const pick1 = picks.find((p) => p.pickPosition === 1);
    expect(pick1?.color).toBe("W");

    // Drafter index 11, round 1 (odd): position = 12
    const pick12 = picks.find((p) => p.pickPosition === 12);
    expect(pick12?.color).toBe("G");

    // Drafter index 4, round 2 (even): position = (2-1)*12 + (12-4) = 20
    const pick20 = picks.find((p) => p.pickPosition === 20);
    expect(pick20?.color).toBe("BRG");
  });

  it("should handle card names with commas", () => {
    const { picks } = parsePickRows(realStyleRows, "real-draft");
    const pheliaPick = picks.find(
      (p) => p.cardName === "Phelia, Exuberant Shepherd"
    );
    expect(pheliaPick).toBeDefined();
    expect(pheliaPick?.pickPosition).toBe(1);
  });

  it("should extract doublePickStartsAfterRound from metadata", () => {
    const { doublePickStartsAfterRound } = parsePickRows(
      realStyleRows,
      "real-draft"
    );
    expect(doublePickStartsAfterRound).toBe(25);
  });
});

describe("parsePickRows double-pick mode", () => {
  // 3 drafters, double picks after round 2
  const doublePickRows = [
    ["", "", "Rotisserie Draft", "", "", "", ""],
    ["", "", "", "", "", ""],
    ["", "", "Alice", "Bob", "Carol", "↩", "", "Color1", "Color2", "Color3"],
    [
      "1",
      "→",
      "Card_A1",
      "Card_B1",
      "Card_C1",
      "↩",
      "",
      "W",
      "U",
      "B",
      "",
      "Double Picks After:",
      "2",
    ],
    ["2", "↪", "Card_A2", "Card_B2", "Card_C2", "↩", "", "W", "U", "B"],
    ["3", "", "Card_A3", "Card_B3", "Card_C3", "↩", "", "W", "U", "B"],
    ["4", "", "Card_A4", "Card_B4", "Card_C4", "↩", "", "W", "U", "B"],
    ["5", "", "Card_A5", "Card_B5", "Card_C5", "↩", "", "W", "U", "B"],
    ["6", "", "Card_A6", "Card_B6", "Card_C6", "↩", "", "W", "U", "B"],
  ];

  it("should extract doublePickStartsAfterRound from metadata", () => {
    const { doublePickStartsAfterRound } = parsePickRows(
      doublePickRows,
      "test"
    );
    expect(doublePickStartsAfterRound).toBe(2);
  });

  it("should return null for doublePickStartsAfterRound when not present", () => {
    const simpleRows = [
      ["", "", "Rotisserie Draft", "", ""],
      ["", "", "", ""],
      ["", "", "Alice", "Bob", "↩", "", "C", "W"],
      ["1", "→", "Card1", "Card2", "↩", "", "W", "U"],
    ];
    const { doublePickStartsAfterRound } = parsePickRows(simpleRows, "test");
    expect(doublePickStartsAfterRound).toBeNull();
  });

  it("should calculate standard positions for rounds before threshold", () => {
    const { picks } = parsePickRows(doublePickRows, "test");

    // Round 1 (odd, forward): Alice=1, Bob=2, Carol=3
    expect(picks.find((p) => p.cardName === "Card_A1")?.pickPosition).toBe(1);
    expect(picks.find((p) => p.cardName === "Card_B1")?.pickPosition).toBe(2);
    expect(picks.find((p) => p.cardName === "Card_C1")?.pickPosition).toBe(3);

    // Round 2 (even, reverse): Carol=4, Bob=5, Alice=6
    expect(picks.find((p) => p.cardName === "Card_C2")?.pickPosition).toBe(4);
    expect(picks.find((p) => p.cardName === "Card_B2")?.pickPosition).toBe(5);
    expect(picks.find((p) => p.cardName === "Card_A2")?.pickPosition).toBe(6);
  });

  it("should calculate double-pick positions correctly for first double-round pair", () => {
    const { picks } = parsePickRows(doublePickRows, "test");

    // Row 3 (first pick): Alice=7, Bob=9, Carol=11
    expect(picks.find((p) => p.cardName === "Card_A3")?.pickPosition).toBe(7);
    expect(picks.find((p) => p.cardName === "Card_B3")?.pickPosition).toBe(9);
    expect(picks.find((p) => p.cardName === "Card_C3")?.pickPosition).toBe(11);

    // Row 4 (second pick): Alice=8, Bob=10, Carol=12
    expect(picks.find((p) => p.cardName === "Card_A4")?.pickPosition).toBe(8);
    expect(picks.find((p) => p.cardName === "Card_B4")?.pickPosition).toBe(10);
    expect(picks.find((p) => p.cardName === "Card_C4")?.pickPosition).toBe(12);
  });

  it("should alternate direction for second double-round pair", () => {
    const { picks } = parsePickRows(doublePickRows, "test");

    expect(picks.find((p) => p.cardName === "Card_C5")?.pickPosition).toBe(13);
    expect(picks.find((p) => p.cardName === "Card_B5")?.pickPosition).toBe(15);
    expect(picks.find((p) => p.cardName === "Card_A5")?.pickPosition).toBe(17);

    expect(picks.find((p) => p.cardName === "Card_C6")?.pickPosition).toBe(14);
    expect(picks.find((p) => p.cardName === "Card_B6")?.pickPosition).toBe(16);
    expect(picks.find((p) => p.cardName === "Card_A6")?.pickPosition).toBe(18);
  });

  it("should produce contiguous pick positions with no gaps", () => {
    const { picks } = parsePickRows(doublePickRows, "test");
    const positions = picks.map((p) => p.pickPosition).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });
});

describe("parsePickRows double-pick mode with 10 drafters", () => {
  function buildTenPlayerRows(): string[][] {
    const drafterNames = Array.from({ length: 10 }, (_, i) => `P${i}`);
    const header = ["", "", "Rotisserie Draft", ...Array(11).fill("")];
    const blank = ["", "", ...Array(12).fill("")];
    const drafterRow = ["", "", ...drafterNames, "↩", "", ...Array(10).fill("C")];

    const rows = [header, blank, drafterRow];
    for (let round = 1; round <= 27; round++) {
      const cards = drafterNames.map((_, i) => `R${round}_P${i}`);
      const colors = drafterNames.map(() => "C");
      const row = [
        `${round}`,
        "→",
        ...cards,
        "↩",
        "",
        ...colors,
      ];
      if (round === 2) {
        row.push("", "Double Picks After:", "25");
      }
      rows.push(row);
    }
    return rows;
  }

  it("should assign correct positions for round 26 (reverse double-pick)", () => {
    const rows = buildTenPlayerRows();
    const { picks } = parsePickRows(rows, "test");

    // Round 25 (last standard, odd/forward): P0=241, P9=250
    expect(picks.find((p) => p.cardName === "R25_P0")?.pickPosition).toBe(241);
    expect(picks.find((p) => p.cardName === "R25_P9")?.pickPosition).toBe(250);

    // Round 26 (first pick of pair, reverse):
    expect(picks.find((p) => p.cardName === "R26_P9")?.pickPosition).toBe(251);
    expect(picks.find((p) => p.cardName === "R26_P8")?.pickPosition).toBe(253);
    expect(picks.find((p) => p.cardName === "R26_P5")?.pickPosition).toBe(259);
    expect(picks.find((p) => p.cardName === "R26_P0")?.pickPosition).toBe(269);

    // Round 27 (second pick of pair):
    expect(picks.find((p) => p.cardName === "R27_P9")?.pickPosition).toBe(252);
    expect(picks.find((p) => p.cardName === "R27_P8")?.pickPosition).toBe(254);
    expect(picks.find((p) => p.cardName === "R27_P5")?.pickPosition).toBe(260);
    expect(picks.find((p) => p.cardName === "R27_P0")?.pickPosition).toBe(270);
  });

  it("should produce contiguous positions through the transition", () => {
    const rows = buildTenPlayerRows();
    const { picks } = parsePickRows(rows, "test");
    const positions = picks.map((p) => p.pickPosition).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 270 }, (_, i) => i + 1));
  });
});

describe("parseMatchRows", () => {
  const drafterNames = ["Alice", "Bob", "Carol", "Dave"];

  const minimalRows = [
    ["Round Robin Tournament"],
    ["", ""],
    [
      "",
      "Player 1",
      "P1 Games",
      "VS",
      "P2 Games",
      "Player 2",
      "P1 Win",
      "P2 Win",
    ],
    ["", "Alice", "1", "VS", "2", "Bob", "0", "1"],
    ["", "Carol", "2", "VS", "1", "Dave", "1", "0"],
  ];

  it("should parse match results from valid rows", () => {
    const matches = parseMatchRows(minimalRows, drafterNames);

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      seat1: 0,
      seat2: 1,
      seat1GamesWon: 1,
      seat2GamesWon: 2,
    });
    expect(matches[1]).toEqual({
      seat1: 2,
      seat2: 3,
      seat1GamesWon: 2,
      seat2GamesWon: 1,
    });
  });

  it("should skip the first three header rows", () => {
    const matches = parseMatchRows(minimalRows, drafterNames);
    expect(matches).toHaveLength(2);
    expect(typeof matches[0].seat1).toBe("number");
  });

  it("should handle null input", () => {
    expect(parseMatchRows(null, drafterNames)).toEqual([]);
  });

  it("should handle empty rows", () => {
    expect(parseMatchRows([], drafterNames)).toEqual([]);
  });

  it("should handle rows with only headers", () => {
    const headerOnly = [
      ["Round Robin Tournament"],
      ["", ""],
      [
        "",
        "Player 1",
        "P1 Games",
        "VS",
        "P2 Games",
        "Player 2",
        "P1 Win",
        "P2 Win",
      ],
    ];
    expect(parseMatchRows(headerOnly, drafterNames)).toEqual([]);
  });

  it("should skip rows without VS marker", () => {
    const rowsWithInvalidRow = [
      ["Round Robin Tournament"],
      ["", ""],
      ["", "Player 1", "P1 Games", "VS", "P2 Games", "Player 2"],
      ["", "Alice", "1", "VS", "2", "Bob"],
      ["", "Carol", "1", "VERSUS", "2", "Dave"],
    ];
    const matches = parseMatchRows(rowsWithInvalidRow, drafterNames);
    expect(matches).toHaveLength(1);
    expect(matches[0].seat1).toBe(0); // Alice
  });

  it("should skip rows with invalid game counts", () => {
    const rowsWithInvalid = [
      ["Round Robin Tournament"],
      ["", ""],
      ["", "Player 1", "P1 Games", "VS", "P2 Games", "Player 2"],
      ["", "Alice", "1", "VS", "2", "Bob"],
      ["", "Carol", "abc", "VS", "xyz", "Dave"],
    ];
    const matches = parseMatchRows(rowsWithInvalid, drafterNames);
    expect(matches).toHaveLength(1);
  });

  it("should skip rows with missing player names", () => {
    const rowsWithMissing = [
      ["Round Robin Tournament"],
      ["", ""],
      ["", "Player 1", "P1 Games", "VS", "P2 Games", "Player 2"],
      ["", "Alice", "1", "VS", "2", "Bob"],
      ["", "", "1", "VS", "2", "Bob"],
      ["", "Carol", "2", "VS", "1", ""],
    ];
    const matches = parseMatchRows(rowsWithMissing, drafterNames);
    expect(matches).toHaveLength(1);
    expect(matches[0].seat1).toBe(0); // Alice
  });

  it("should skip rows with unknown player names", () => {
    const rowsWithUnknown = [
      ["Round Robin Tournament"],
      ["", ""],
      ["", "Player 1", "P1 Games", "VS", "P2 Games", "Player 2"],
      ["", "Alice", "1", "VS", "2", "Bob"],
      ["", "Unknown", "1", "VS", "2", "Bob"],
    ];
    const matches = parseMatchRows(rowsWithUnknown, drafterNames);
    expect(matches).toHaveLength(1);
  });

  it("should handle 0-0 ties", () => {
    const rowsWithTie = [
      ["Round Robin Tournament"],
      ["", ""],
      ["", "Player 1", "P1 Games", "VS", "P2 Games", "Player 2"],
      ["", "Alice", "0", "VS", "0", "Bob"],
    ];
    const matches = parseMatchRows(rowsWithTie, drafterNames);
    expect(matches).toHaveLength(1);
    expect(matches[0].seat1GamesWon).toBe(0);
    expect(matches[0].seat2GamesWon).toBe(0);
  });

  it("should handle high game counts", () => {
    const rowsWithBo5 = [
      ["Round Robin Tournament"],
      ["", ""],
      ["", "Player 1", "P1 Games", "VS", "P2 Games", "Player 2"],
      ["", "Alice", "3", "VS", "2", "Bob"],
    ];
    const matches = parseMatchRows(rowsWithBo5, drafterNames);
    expect(matches[0].seat1GamesWon).toBe(3);
    expect(matches[0].seat2GamesWon).toBe(2);
  });

  it("should ignore columns beyond the match data", () => {
    const rowsWithStandings = [
      ["Round Robin Tournament"],
      ["", ""],
      [
        "",
        "Player 1",
        "P1 Games",
        "VS",
        "P2 Games",
        "Player 2",
        "P1 Win",
        "P2 Win",
        "",
        "Standings",
      ],
      ["", "Alice", "1", "VS", "2", "Bob", "0", "1", "", "X", "2-1"],
      ["", "Carol", "2", "VS", "1", "Dave", "1", "0", "", "1-2", "X"],
    ];
    const matches = parseMatchRows(rowsWithStandings, drafterNames);
    expect(matches).toHaveLength(2);
    expect(matches[0].seat1).toBe(0);
    expect(matches[0].seat2).toBe(1);
  });

  it("should trim whitespace from player names", () => {
    const rowsWithWhitespace = [
      ["Round Robin Tournament"],
      ["", ""],
      ["", "Player 1", "P1 Games", "VS", "P2 Games", "Player 2"],
      ["", "  Alice  ", "1", "VS", "2", "  Bob  "],
    ];
    const matches = parseMatchRows(rowsWithWhitespace, drafterNames);
    expect(matches[0].seat1).toBe(0); // Alice
    expect(matches[0].seat2).toBe(1); // Bob
  });

  it("should build name-to-seat map from drafterNames array", () => {
    // This verifies the internal map is built correctly from the array
    const customDrafters = ["Zara", "Yuki", "Xander"];
    const rows = [
      ["Title"],
      ["", ""],
      ["", "Header"],
      ["", "Yuki", "2", "VS", "1", "Xander"],
    ];
    const matches = parseMatchRows(rows, customDrafters);
    expect(matches).toHaveLength(1);
    expect(matches[0].seat1).toBe(1); // Yuki is index 1
    expect(matches[0].seat2).toBe(2); // Xander is index 2
  });
});

describe("integration: parseMatchRows round robin", () => {
  const drafterNames = ["Alice", "Bob", "Carol", "Dave"];

  const roundRobinRows = [
    ["Round Robin Tournament Results"],
    ["", ""],
    [
      "",
      "Player 1",
      "P1 Games",
      "VS",
      "P2 Games",
      "Player 2",
      "P1 Win",
      "P2 Win",
      "",
      "Standings",
    ],
    ["", "Alice", "2", "VS", "1", "Bob", "1", "0"],
    ["", "Alice", "2", "VS", "0", "Carol", "1", "0"],
    ["", "Alice", "1", "VS", "2", "Dave", "0", "1"],
    ["", "Bob", "2", "VS", "1", "Carol", "1", "0"],
    ["", "Bob", "0", "VS", "2", "Dave", "0", "1"],
    ["", "Carol", "1", "VS", "2", "Dave", "0", "1"],
  ];

  it("should correctly parse a full round robin", () => {
    const matches = parseMatchRows(roundRobinRows, drafterNames);
    expect(matches).toHaveLength(6);
  });

  it("should parse game counts from both seat1 and seat2 columns consistently", () => {
    const matches = parseMatchRows(roundRobinRows, drafterNames);
    let totalP1Wins = 0;
    let totalP2Wins = 0;
    for (const m of matches) {
      totalP1Wins += m.seat1GamesWon;
      totalP2Wins += m.seat2GamesWon;
    }
    // Seat1 column: 2+2+1+2+0+1 = 8; seat2 column: 1+0+2+1+2+2 = 8
    expect(totalP1Wins).toBe(8);
    expect(totalP2Wins).toBe(8);
    expect(totalP1Wins + totalP2Wins).toBe(16);
  });
});
