import { describe, it, expect } from "vitest";
import { displayManaCost } from "./manaCost";

describe("displayManaCost", () => {
  it("returns only the front half of a prepared card's cost", () => {
    expect(
      displayManaCost({
        manaCost: "{1}{B} // {B}{B}",
        oracleText:
          "When this creature enters, you may sacrifice another creature. If you do, this creature becomes prepared. (While it's prepared, you may cast a copy of the other half.)",
      })
    ).toBe("{1}{B}");
  });

  it('matches the "enters prepared" phrasing too', () => {
    expect(
      displayManaCost({
        manaCost: "{2}{U} // {U}",
        oracleText:
          "Flash\nFlying, vigilance\nThis creature enters prepared. (While it's prepared, you may cast a copy of the other half.)",
      })
    ).toBe("{2}{U}");
  });

  it("leaves a split card's cost untouched", () => {
    expect(
      displayManaCost({
        manaCost: "{G} // {1}{B}",
        oracleText: "Put two 1/1 green Insect creature tokens onto the battlefield.",
      })
    ).toBe("{G} // {1}{B}");
  });

  it("leaves an Adventure's cost untouched", () => {
    expect(
      displayManaCost({
        manaCost: "{2}{R} // {1}{R}",
        oracleText:
          "Whenever this creature becomes the target of a spell, it deals 2 damage to that spell's controller.",
      })
    ).toBe("{2}{R} // {1}{R}");
  });

  it("leaves a single-face cost untouched", () => {
    expect(
      displayManaCost({
        manaCost: "{2}{U}{U}",
        oracleText: "Counter target spell.",
      })
    ).toBe("{2}{U}{U}");
  });

  it("leaves a prepared card with no face separator untouched", () => {
    expect(
      displayManaCost({
        manaCost: "{1}{B}",
        oracleText: "This creature enters prepared.",
      })
    ).toBe("{1}{B}");
  });

  it("returns an empty string for a missing card", () => {
    expect(displayManaCost(undefined)).toBe("");
  });

  it("returns an empty string for an empty cost", () => {
    expect(displayManaCost({ manaCost: "", oracleText: "Lands are lands." })).toBe("");
  });
});
