import { describe, it, expect } from "vitest";
import { isLand, isFrontFaceLand, isCreature } from "./cardTypes";

describe("isLand", () => {
  it("accepts a plain land", () => {
    expect(isLand("Land")).toBe(true);
    expect(isLand("Basic Land — Island")).toBe(true);
  });

  // The case the four old predicates disagreed on: the deck builder filed it
  // as a land while the mana-source readout counted it as a colored spell.
  it("accepts a transforming card whose back face is a land", () => {
    expect(isLand("Legendary Enchantment // Legendary Land")).toBe(true);
  });

  it("rejects a card that only mentions land in its type words", () => {
    expect(isLand("Creature — Landwalker")).toBe(false);
  });

  it("rejects a non-land", () => {
    expect(isLand("Instant")).toBe(false);
  });
});

describe("isFrontFaceLand", () => {
  it("is false for a spell that transforms into a land", () => {
    expect(isFrontFaceLand("Legendary Enchantment // Legendary Land")).toBe(false);
  });

  it("is true for a land with a land back", () => {
    expect(isFrontFaceLand("Land // Land")).toBe(true);
  });
});

describe("isCreature", () => {
  it("accepts either face", () => {
    expect(isCreature("Creature — Human")).toBe(true);
    expect(isCreature("Sorcery // Creature — Werewolf")).toBe(true);
    expect(isCreature("Artifact")).toBe(false);
  });
});
