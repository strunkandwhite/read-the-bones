/**
 * Colored mana source accounting for the deck builder.
 *
 * Two numbers per color: how many lands in the maindeck can produce it, and how
 * many sources the deck's most demanding spell of that color wants in order to
 * be castable on curve.
 *
 * Scryfall's `produced_mana` is not among the fields this app stores (see
 * ScryCard), so production is read off the oracle text and type line instead.
 */

import type { ScryCard } from "./types";
import { displayManaCost } from "./manaCost";

export type ManaColor = "W" | "U" | "B" | "R" | "G";

const WUBRG: readonly ManaColor[] = ["W", "U", "B", "R", "G"];

/** Basic land subtype (lowercased) to the color it taps for. */
const BASIC_TYPE_COLORS: Record<string, ManaColor> = {
  plains: "W",
  island: "U",
  swamp: "B",
  mountain: "R",
  forest: "G",
};

/** Basic lands are added by the deck builder rather than drafted, so they never
 *  reach the Scryfall cache and have to be recognized by name. */
const BASIC_LAND_NAMES: Record<string, ManaColor> = {
  Plains: "W",
  Island: "U",
  Swamp: "B",
  Mountain: "R",
  Forest: "G",
};

/** Target deck size the requirement is computed against. Fixed rather than read
 *  off the current maindeck so the numbers don't swing while a deck is being
 *  built out from nothing. */
const TARGET_DECK_SIZE = 40;

/** Probability of having the sources in hand on curve that a requirement is
 *  solved for. 0.85 reproduces the familiar limited figures — 9 sources for a
 *  single pip on turn one, 8 on turn two, 14 for a double pip on turn two. */
const CASTABILITY_THRESHOLD = 0.85;

/** A color with fewer sources than this and no spells asking for it is
 *  incidental — a fetchland reaching a dual's off-color half, typically —
 *  rather than a deliberate part of the manabase. */
const INCIDENTAL_SOURCE_FLOOR = 3;

export type ColorSourceSplit = {
  color: ManaColor;
  /** Lands in the maindeck that can produce this color. */
  sources: number;
  /** Sources wanted by the deck's most demanding spell of this color. */
  required: number;
  /** The spell that set `required`, or null when nothing asks for this color. */
  requiredBy: string | null;
};

const FACE_SEPARATOR = " // ";

/** A transforming double-faced card is cast as its front face, so a land on its
 *  back is not a land you can play. A modal one (Sink into Stupor // Soporific
 *  Springs) is. Scryfall's `layout` would say which, but it isn't stored — the
 *  transform reminder text on the back face is the tell that is. */
function isTransformingCard(card: ScryCard): boolean {
  return /\btransform/i.test(card.oracleText ?? "");
}

function faces(typeLine: string): string[] {
  return typeLine.split(FACE_SEPARATOR);
}

/** Whether a maindeck card counts as a land for source accounting: a land on
 *  every face, or the land half of a modal double-faced card. */
export function isLandSource(cardName: string, card: ScryCard | undefined): boolean {
  if (cardName in BASIC_LAND_NAMES) return true;
  if (!card) return false;

  const typeFaces = faces(card.typeLine ?? "");
  const landFaces = typeFaces.filter((face) => /\bland\b/i.test(face));
  if (landFaces.length === 0) return false;
  if (landFaces.length === typeFaces.length) return true;
  return !isTransformingCard(card);
}

/** The basic land types a land's own type line grants it, which is both what it
 *  taps for and what a fetchland can find it with. */
function basicTypesOf(cardName: string, card: ScryCard | undefined): ManaColor[] {
  const basicByName = BASIC_LAND_NAMES[cardName];
  if (basicByName) return [basicByName];
  if (!card) return [];

  const colors: ManaColor[] = [];
  for (const face of faces(card.typeLine ?? "")) {
    if (!/\bland\b/i.test(face)) continue;
    const subtypes = face.split("—")[1] ?? "";
    for (const word of subtypes.toLowerCase().split(/\W+/)) {
      const color = BASIC_TYPE_COLORS[word];
      if (color && !colors.includes(color)) colors.push(color);
    }
  }
  return colors;
}

/**
 * Colors a land taps for, read off its `Add …` clauses.
 *
 * Scoped to the Add clause rather than the whole line because a creature-land's
 * activation cost carries colored pips of its own — Celestial Colonnade's
 * "{3}{W}{U}: …becomes a 4/4" is not mana it produces.
 *
 * A clause whose activation cost sacrifices something (Phyrexian Tower's
 * "{T}, Sacrifice a creature: Add {B}{B}") is skipped: that is not mana the
 * land can be relied on for. Fetchlands also sacrifice, but they produce no
 * mana directly and are resolved through their search clause instead.
 */
function addedColors(card: ScryCard): ManaColor[] {
  const colors: ManaColor[] = [];
  const push = (color: ManaColor) => {
    if (!colors.includes(color)) colors.push(color);
  };

  for (const line of (card.oracleText ?? "").split("\n")) {
    const [cost, ...effect] = line.split(":");
    if (effect.length > 0 && /\bsacrifice\b/i.test(cost)) continue;

    for (const match of line.matchAll(/\bAdd\b([^.]*)/gi)) {
      const clause = match[1];
      if (/one mana of any color/i.test(clause)) {
        WUBRG.forEach(push);
        continue;
      }
      for (const symbol of clause.matchAll(/\{([WUBRG])\}/g)) {
        push(symbol[1] as ManaColor);
      }
    }
  }
  return colors;
}

/** The basic land types a fetchland searches for, or "basic" when it takes any
 *  basic land card (Prismatic Vista, Evolving Wilds). Null when not a fetch. */
function fetchTargets(card: ScryCard): ManaColor[] | "basic" | null {
  const match = /Search your library for (?:an?|up to one) ([^.]*?) card/i.exec(
    card.oracleText ?? "",
  );
  if (!match) return null;

  const phrase = match[1].toLowerCase();
  if (phrase.includes("basic land")) return "basic";

  const types: ManaColor[] = [];
  for (const word of phrase.split(/\W+/)) {
    const color = BASIC_TYPE_COLORS[word];
    if (color && !types.includes(color)) types.push(color);
  }
  return types.length > 0 ? types : null;
}

type LandEntry = {
  name: string;
  /** Colors the land taps for on its own. */
  direct: ManaColor[];
  /** Basic land types it has, which is what a fetchland finds it by. */
  basicTypes: ManaColor[];
  isBasic: boolean;
  fetches: ManaColor[] | "basic" | null;
};

function toLandEntry(name: string, card: ScryCard | undefined): LandEntry {
  const basicTypes = basicTypesOf(name, card);
  const direct = [...basicTypes];
  if (card) {
    // A land that becomes a basic land type of its controller's choosing
    // (Multiversal Passage) can be any of them.
    if (/choose a basic land type/i.test(card.oracleText ?? "")) {
      for (const color of WUBRG) if (!direct.includes(color)) direct.push(color);
    }
    for (const color of addedColors(card)) {
      if (!direct.includes(color)) direct.push(color);
    }
  }
  return {
    name,
    direct,
    basicTypes,
    isBasic: name in BASIC_LAND_NAMES || /\bbasic land\b/i.test(card?.typeLine ?? ""),
    fetches: card ? fetchTargets(card) : null,
  };
}

/**
 * Colors each land in the maindeck can produce, with fetchlands resolved
 * against the lands actually available to find.
 *
 * A fetchland counts as a full source for every color it can reach, so Wooded
 * Foothills in a deck holding Overgrown Tomb is a black source as well as a red
 * and a green one.
 */
function landColorSources(lands: LandEntry[]): Map<ManaColor, number> {
  const counts = new Map<ManaColor, number>();
  const add = (color: ManaColor) => counts.set(color, (counts.get(color) ?? 0) + 1);

  for (const land of lands) {
    const { fetches } = land;
    if (fetches !== null && land.direct.length === 0) {
      const reachable = new Set<ManaColor>();
      for (const target of lands) {
        if (target === land) continue;
        const findable =
          fetches === "basic"
            ? target.isBasic
            : target.basicTypes.some((type) => fetches.includes(type));
        if (findable) for (const color of target.direct) reachable.add(color);
      }
      for (const color of reachable) add(color);
      continue;
    }
    for (const color of land.direct) add(color);
  }
  return counts;
}

/** The mana value of a single face's cost string. */
function manaValueOfCost(cost: string): number {
  let total = 0;
  for (const [, symbol] of cost.matchAll(/\{([^}]+)\}/g)) {
    if (/^\d+$/.test(symbol)) {
      total += Number(symbol);
    } else if (/^[XYZ]$/i.test(symbol)) {
      continue;
    } else if (symbol.includes("/")) {
      // Twobrid ({2/W}) is worth two; every other hybrid or Phyrexian pip, one.
      const generic = /^(\d+)\//.exec(symbol);
      total += generic ? Number(generic[1]) : 1;
    } else {
      total += 1;
    }
  }
  return total;
}

/**
 * Colored pips a face demands, by color.
 *
 * Hybrid and Phyrexian pips are left out: either is payable another way, so
 * {B/R}{B/R} asks for no particular number of black or red sources.
 */
function pipsOfCost(cost: string): Map<ManaColor, number> {
  const pips = new Map<ManaColor, number>();
  for (const [, symbol] of cost.matchAll(/\{([WUBRG])\}/g)) {
    const color = symbol as ManaColor;
    pips.set(color, (pips.get(color) ?? 0) + 1);
  }
  return pips;
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let total = 0;
  for (let i = 0; i < k; i++) total += Math.log(n - i) - Math.log(i + 1);
  return total;
}

/** P(at least `wanted` of `successes` among `drawn` cards from `deckSize`). */
function hypergeometricAtLeast(
  deckSize: number,
  successes: number,
  drawn: number,
  wanted: number,
): number {
  let probability = 0;
  for (let i = wanted; i <= Math.min(successes, drawn); i++) {
    probability += Math.exp(
      logChoose(successes, i) +
        logChoose(deckSize - successes, drawn - i) -
        logChoose(deckSize, drawn),
    );
  }
  return probability;
}

const requirementCache = new Map<string, number>();

/**
 * Sources needed to have `pips` of a color in play by `turn` with probability
 * CASTABILITY_THRESHOLD, drawing on the play with no mulligans — seven cards
 * plus one per turn after the first.
 */
export function sourcesNeeded(pips: number, turn: number): number {
  const effectiveTurn = Math.max(turn, pips, 1);
  const key = `${pips}:${effectiveTurn}`;
  const cached = requirementCache.get(key);
  if (cached !== undefined) return cached;

  const drawn = Math.min(6 + effectiveTurn, TARGET_DECK_SIZE);
  let needed = TARGET_DECK_SIZE;
  for (let sources = pips; sources <= TARGET_DECK_SIZE; sources++) {
    if (
      hypergeometricAtLeast(TARGET_DECK_SIZE, sources, drawn, pips) >=
      CASTABILITY_THRESHOLD
    ) {
      needed = sources;
      break;
    }
  }
  requirementCache.set(key, needed);
  return needed;
}

/**
 * Actual and wanted colored mana sources for a maindeck.
 *
 * Cards counted as lands are left out of the requirement side: a modal
 * double-faced land is in the deck to be played as a land, so its front half's
 * cost is not something the manabase has to support.
 *
 * All five colors are returned, in WUBRG order; see isNotableColor for the ones
 * worth showing.
 */
export function colorSourceSplits(
  cardNames: string[],
  scryfallData: Map<string, ScryCard>,
): ColorSourceSplit[] {
  const lands: LandEntry[] = [];
  const spells: Array<{ name: string; card: ScryCard }> = [];

  for (const name of cardNames) {
    const card = scryfallData.get(name);
    if (isLandSource(name, card)) {
      lands.push(toLandEntry(name, card));
    } else if (card) {
      spells.push({ name, card });
    }
  }

  const sources = landColorSources(lands);

  const required = new Map<ManaColor, { count: number; card: string }>();
  for (const { name, card } of spells) {
    for (const face of displayManaCost(card).split(FACE_SEPARATOR)) {
      const turn = manaValueOfCost(face);
      for (const [color, pips] of pipsOfCost(face)) {
        const needed = sourcesNeeded(pips, turn);
        if (needed > (required.get(color)?.count ?? 0)) {
          required.set(color, { count: needed, card: name });
        }
      }
    }
  }

  return WUBRG.map((color) => ({
    color,
    sources: sources.get(color) ?? 0,
    required: required.get(color)?.count ?? 0,
    requiredBy: required.get(color)?.card ?? null,
  }));
}

/** Whether a color is part of what the deck is trying to do — either its spells
 *  ask for it, or its manabase makes more of it than a fetchland reaching an
 *  off-color dual would explain. */
export function isNotableColor(split: ColorSourceSplit): boolean {
  return split.required > 0 || split.sources >= INCIDENTAL_SOURCE_FLOOR;
}
