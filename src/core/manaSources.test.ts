import { describe, it, expect } from "vitest";
import {
  colorSourceSplits,
  isLandSource,
  isNotableColor,
  sourcesNeeded,
} from "./manaSources";
import type { ScryCard } from "./types";

function card(fields: Partial<ScryCard> & { name: string }): ScryCard {
  return {
    imageUri: "",
    manaCost: "",
    manaValue: 0,
    typeLine: "",
    colors: [],
    colorIdentity: [],
    oracleText: "",
    ...fields,
  };
}

/** Oracle text and type lines are verbatim from cache/scryfall.json. */
const CARDS: ScryCard[] = [
  card({
    name: "Wooded Foothills",
    typeLine: "Land",
    oracleText:
      "{T}, Pay 1 life, Sacrifice this land: Search your library for a Mountain or Forest card, put it onto the battlefield, then shuffle.",
  }),
  card({
    name: "Overgrown Tomb",
    typeLine: "Land — Swamp Forest",
    oracleText:
      "({T}: Add {B} or {G}.)\nAs this land enters, you may pay 2 life. If you don't, it enters tapped.",
  }),
  card({
    name: "Prismatic Vista",
    typeLine: "Land",
    oracleText:
      "{T}, Pay 1 life, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield, then shuffle.",
  }),
  card({
    name: "Celestial Colonnade",
    typeLine: "Land",
    oracleText:
      "This land enters tapped.\n{T}: Add {W} or {U}.\n{3}{W}{U}: Until end of turn, this land becomes a 4/4 white and blue Elemental creature with flying and vigilance. It's still a land.",
  }),
  card({
    name: "Phyrexian Tower",
    typeLine: "Legendary Land",
    oracleText: "{T}: Add {C}.\n{T}, Sacrifice a creature: Add {B}{B}.",
  }),
  card({
    name: "Starting Town",
    typeLine: "Land — Town",
    oracleText:
      "This land enters tapped unless it's your first, second, or third turn of the game.\n{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color.",
  }),
  card({
    name: "Multiversal Passage",
    typeLine: "Land",
    oracleText:
      "As this land enters, choose a basic land type. Then you may pay 2 life. If you don't, it enters tapped.\nThis land is the chosen type.",
  }),
  card({
    name: "Sink into Stupor // Soporific Springs",
    typeLine: "Instant // Land",
    manaCost: "{1}{U}{U}",
    manaValue: 3,
    oracleText:
      "Return target spell or nonland permanent an opponent controls to its owner's hand.\n\nAs this land enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {U}.",
  }),
  card({
    name: "Legion's Landing // Adanto, the First Fort",
    typeLine: "Legendary Enchantment // Legendary Land",
    manaCost: "{W}",
    manaValue: 1,
    oracleText:
      "When Legion's Landing enters, create a 1/1 white Vampire creature token with lifelink.\nWhen you attack with three or more creatures, transform Legion's Landing.\n\n(Transforms from Legion's Landing.)\n{T}: Add {W}.\n{2}{W}, {T}: Create a 1/1 white Vampire creature token with lifelink.",
  }),
  card({
    name: "Carnage Interpreter",
    typeLine: "Creature — Devil Rogue",
    manaCost: "{1}{B/R}{B/R}",
    manaValue: 3,
  }),
  card({
    name: "Wren and Six",
    typeLine: "Legendary Planeswalker — Wrenn",
    manaCost: "{R}{G}",
    manaValue: 2,
  }),
  card({
    name: "Tarmogoyf",
    typeLine: "Creature — Lhurgoyf",
    manaCost: "{1}{G}",
    manaValue: 2,
  }),
  card({
    name: "Nissa, Ascended Animist",
    typeLine: "Legendary Planeswalker — Nissa",
    manaCost: "{3}{G}{G}{G/P}{G/P}",
    manaValue: 7,
  }),
  card({
    name: "Bonecrusher Giant",
    typeLine: "Creature — Giant // Instant",
    manaCost: "{2}{R} // {1}{R}",
    manaValue: 3,
  }),
];

const DATA = new Map(CARDS.map((c) => [c.name, c]));

function splitFor(names: string[]) {
  const splits = colorSourceSplits(names, DATA);
  return new Map(splits.map((s) => [s.color, s]));
}

describe("isLandSource", () => {
  it("counts a basic land, which never reaches the Scryfall cache", () => {
    expect(isLandSource("Forest", undefined)).toBe(true);
  });

  it("counts the land half of a modal double-faced card", () => {
    expect(
      isLandSource(
        "Sink into Stupor // Soporific Springs",
        DATA.get("Sink into Stupor // Soporific Springs"),
      ),
    ).toBe(true);
  });

  it("does not count a spell that transforms into a land", () => {
    expect(
      isLandSource(
        "Legion's Landing // Adanto, the First Fort",
        DATA.get("Legion's Landing // Adanto, the First Fort"),
      ),
    ).toBe(false);
  });

  it("does not count a nonland card", () => {
    expect(isLandSource("Tarmogoyf", DATA.get("Tarmogoyf"))).toBe(false);
  });
});

describe("colorSourceSplits sources", () => {
  it("counts a dual land as a source for both its colors", () => {
    const splits = splitFor(["Overgrown Tomb", "Tarmogoyf"]);

    expect(splits.get("G")?.sources).toBe(1);
    expect(splits.get("B")?.sources).toBe(1);
  });

  it("counts a fetchland for the colors of the duals it can find", () => {
    // Wooded Foothills finds Forests, and Overgrown Tomb is one — so the
    // fetchland is a black source as well as a green one, alongside the Tomb.
    const splits = splitFor([
      "Wooded Foothills",
      "Overgrown Tomb",
      "Tarmogoyf",
      "Carnage Interpreter",
    ]);

    expect(splits.get("G")?.sources).toBe(2);
    expect(splits.get("B")?.sources).toBe(2);
  });

  it("gives a fetchland nothing when the deck holds no land it can find", () => {
    const splits = splitFor(["Wooded Foothills", "Island", "Tarmogoyf"]);

    expect(splits.get("G")?.sources).toBe(0);
  });

  it("counts a fetchland for a basic it can find", () => {
    const splits = splitFor(["Wooded Foothills", "Forest", "Tarmogoyf"]);

    expect(splits.get("G")?.sources).toBe(2);
  });

  it("finds only basics with a fetchland that searches for a basic land card", () => {
    const splits = splitFor([
      "Prismatic Vista",
      "Overgrown Tomb",
      "Island",
      "Tarmogoyf",
    ]);

    // Prismatic Vista reaches the Island but not the Overgrown Tomb.
    expect(splits.get("U")?.sources).toBe(2);
    expect(splits.get("G")?.sources).toBe(1);
  });

  it("ignores the colored pips in a creature-land's activation cost", () => {
    // Celestial Colonnade's "{3}{W}{U}: …becomes a 4/4" is not mana it makes,
    // but its "{T}: Add {W} or {U}" is — so it is one source of each, not two.
    const splits = splitFor(["Celestial Colonnade", "Legion's Landing // Adanto, the First Fort"]);

    expect(splits.get("W")?.sources).toBe(1);
  });

  it("ignores mana that costs sacrificing a creature", () => {
    const splits = splitFor(["Phyrexian Tower", "Carnage Interpreter", "Tarmogoyf"]);

    expect(splits.get("B")?.sources).toBe(0);
  });

  it("counts an any-color land for every color", () => {
    const splits = splitFor(["Starting Town", "Tarmogoyf"]);

    expect(splits.get("G")?.sources).toBe(1);
  });

  it("counts a land that chooses a basic type for every color", () => {
    const splits = splitFor(["Multiversal Passage", "Tarmogoyf"]);

    expect(splits.get("G")?.sources).toBe(1);
  });

  it("counts a modal double-faced land as a source, not as a spell to support", () => {
    const splits = splitFor([
      "Sink into Stupor // Soporific Springs",
      "Tarmogoyf",
    ]);

    expect(splits.get("U")?.sources).toBe(1);
    expect(splits.get("U")?.required ?? 0).toBe(0);
  });

  it("counts a spell that transforms into a land as a spell to support", () => {
    const splits = splitFor(["Legion's Landing // Adanto, the First Fort"]);

    expect(splits.get("W")?.sources).toBe(0);
    expect(splits.get("W")?.required).toBe(sourcesNeeded(1, 1));
  });
});

describe("colorSourceSplits requirements", () => {
  it("takes the most demanding spell of each color", () => {
    const splits = splitFor(["Wren and Six", "Tarmogoyf", "Overgrown Tomb"]);

    // Both want one green pip, Wren and Six a turn earlier.
    expect(splits.get("G")?.required).toBe(sourcesNeeded(1, 2));
    expect(splits.get("G")?.requiredBy).toBe("Wren and Six");
  });

  it("asks for more from a double pip than a single one", () => {
    const splits = splitFor(["Nissa, Ascended Animist", "Tarmogoyf"]);

    // The two {G/P} pips are payable with life, so Nissa asks for {G}{G} on
    // turn seven rather than four green pips.
    expect(splits.get("G")?.required).toBe(sourcesNeeded(2, 7));
    expect(splits.get("G")?.requiredBy).toBe("Nissa, Ascended Animist");
  });

  it("ignores hybrid pips", () => {
    const splits = splitFor(["Carnage Interpreter", "Overgrown Tomb"]);

    expect(splits.get("B")?.required).toBe(0);
    expect(splits.get("R")?.required).toBe(0);
  });

  it("reads each face of a split cost", () => {
    const splits = splitFor(["Bonecrusher Giant"]);

    // The Adventure half is the earlier, cheaper red play of the two.
    expect(splits.get("R")?.required).toBe(sourcesNeeded(1, 2));
  });

  it("reports a color the deck produces but has no spells for", () => {
    const splits = splitFor(["Island", "Island", "Island", "Tarmogoyf"]);

    expect(splits.get("U")).toEqual({
      color: "U",
      sources: 3,
      required: 0,
      requiredBy: null,
    });
  });
});

describe("isNotableColor", () => {
  const notable = (names: string[]) =>
    colorSourceSplits(names, DATA).filter(isNotableColor).map((s) => s.color);

  it("keeps a color the deck's spells ask for, however few sources it has", () => {
    expect(notable(["Tarmogoyf"])).toEqual(["G"]);
  });

  it("drops a color the deck neither needs nor produces", () => {
    expect(notable(["Tarmogoyf", "Forest", "Forest"])).toEqual(["G"]);
  });

  it("drops the off-color half of a dual a fetchland happens to reach", () => {
    // Overgrown Tomb and the fetch make two black sources in a deck with no
    // black spells — incidental, not a splash.
    expect(notable(["Wooded Foothills", "Overgrown Tomb", "Tarmogoyf"])).toEqual([
      "G",
    ]);
  });

  it("keeps a color the manabase deliberately produces", () => {
    expect(notable(["Island", "Island", "Island", "Tarmogoyf"])).toEqual(["U", "G"]);
  });
});

describe("sourcesNeeded", () => {
  it("reproduces the familiar limited figures for a single pip", () => {
    expect(sourcesNeeded(1, 1)).toBe(9);
    expect(sourcesNeeded(1, 2)).toBe(8);
    expect(sourcesNeeded(1, 3)).toBe(7);
    expect(sourcesNeeded(1, 5)).toBe(6);
  });

  it("asks for far more from a double pip", () => {
    expect(sourcesNeeded(2, 2)).toBe(14);
    expect(sourcesNeeded(2, 4)).toBe(12);
  });

  it("cannot want a pip before the turn it could be cast", () => {
    expect(sourcesNeeded(2, 1)).toBe(sourcesNeeded(2, 2));
  });

  it("wants fewer sources the later a spell is cast", () => {
    expect(sourcesNeeded(1, 6)).toBeLessThan(sourcesNeeded(1, 2));
  });
});
