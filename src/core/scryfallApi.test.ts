import { describe, it, expect, vi, beforeEach } from "vitest";
import { transformApiResponse, ScryfallApiResponse, fetchCard } from "./scryfallApi";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("transformApiResponse", () => {
  describe("normal single-faced cards", () => {
    it("should transform a standard card with all fields present", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Lightning Bolt",
        mana_cost: "{R}",
        cmc: 1,
        type_line: "Instant",
        colors: ["R"],
        color_identity: ["R"],
        oracle_text: "Lightning Bolt deals 3 damage to any target.",
        image_uris: {
          normal: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg",
          small: "https://cards.scryfall.io/small/front/lightning-bolt.jpg",
        },
      };

      const result = transformApiResponse(apiResponse);

      expect(result).toEqual({
        name: "Lightning Bolt",
        imageUri: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg",
        manaCost: "{R}",
        manaValue: 1,
        typeLine: "Instant",
        colors: ["R"],
        colorIdentity: ["R"],
        oracleText: "Lightning Bolt deals 3 damage to any target.",
      });
    });

    it("should use top-level image_uris even when card_faces exists", () => {
      // Some cards have both top-level image_uris and card_faces
      const apiResponse: ScryfallApiResponse = {
        name: "Split Card",
        image_uris: {
          normal: "https://cards.scryfall.io/normal/split.jpg",
        },
        oracle_text: "Combined text",
        card_faces: [
          {
            oracle_text: "Face 1 text",
            image_uris: { normal: "https://cards.scryfall.io/normal/face1.jpg" },
          },
          {
            oracle_text: "Face 2 text",
            image_uris: { normal: "https://cards.scryfall.io/normal/face2.jpg" },
          },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.imageUri).toBe("https://cards.scryfall.io/normal/split.jpg");
      expect(result.oracleText).toBe("Combined text");
    });
  });

  describe("double-faced cards", () => {
    it("should use image_uris from card_faces[0] when top-level is missing", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Delver of Secrets // Insectile Aberration",
        mana_cost: "{U}",
        cmc: 1,
        type_line: "Creature — Human Wizard // Creature — Human Insect",
        colors: ["U"],
        color_identity: ["U"],
        // No top-level image_uris
        card_faces: [
          {
            oracle_text: "Front face text",
            image_uris: {
              normal: "https://cards.scryfall.io/normal/front/delver-front.jpg",
            },
          },
          {
            oracle_text: "Back face text",
            image_uris: {
              normal: "https://cards.scryfall.io/normal/front/delver-back.jpg",
            },
          },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.imageUri).toBe("https://cards.scryfall.io/normal/front/delver-front.jpg");
    });

    it("should use mana_cost from card_faces[0] when top-level is missing", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki",
        cmc: 3,
        type_line: "Enchantment — Saga // Enchantment Creature — Goblin Shaman",
        color_identity: ["R"],
        // No top-level colors (Scryfall omits this for DFCs)
        card_faces: [
          {
            name: "Fable of the Mirror-Breaker",
            mana_cost: "{2}{R}",
            oracle_text: "Front face text",
            colors: ["R"],
            image_uris: {
              normal: "https://cards.scryfall.io/normal/front/fable.jpg",
            },
          },
          {
            name: "Reflection of Kiki-Jiki",
            mana_cost: "",
            oracle_text: "Back face text",
            colors: ["R"],
            image_uris: {
              normal: "https://cards.scryfall.io/normal/back/fable.jpg",
            },
          },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.manaCost).toBe("{2}{R}");
      expect(result.colors).toEqual(["R"]);
    });

    it("should derive colors from card_faces when top-level colors is missing", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Jace, Vryn's Prodigy // Jace, Telepath Unbound",
        cmc: 2,
        type_line: "Legendary Creature — Human Wizard // Legendary Planeswalker — Jace",
        color_identity: ["U"],
        card_faces: [
          {
            name: "Jace, Vryn's Prodigy",
            mana_cost: "{1}{U}",
            oracle_text: "Front face text",
            colors: ["U"],
            image_uris: {
              normal: "https://cards.scryfall.io/normal/front/jace.jpg",
            },
          },
          {
            name: "Jace, Telepath Unbound",
            mana_cost: "",
            oracle_text: "Back face text",
            colors: ["U"],
            image_uris: {
              normal: "https://cards.scryfall.io/normal/back/jace.jpg",
            },
          },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.colors).toEqual(["U"]);
    });

    it("should combine colors from multiple faces (deduplicated)", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Multi-Color DFC",
        cmc: 3,
        color_identity: ["R", "G"],
        card_faces: [
          {
            oracle_text: "Front",
            colors: ["R"],
            image_uris: { normal: "https://example.com/front.jpg" },
          },
          {
            oracle_text: "Back",
            colors: ["G"],
            image_uris: { normal: "https://example.com/back.jpg" },
          },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.colors).toEqual(["R", "G"]);
    });

    it("should return empty imageUri when neither top-level nor card_faces have it", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Text-Only Card",
        card_faces: [
          { oracle_text: "Face 1" },
          { oracle_text: "Face 2" },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.imageUri).toBe("");
    });
  });

  describe("oracle text concatenation", () => {
    it("should concatenate oracle text from card_faces with double newline", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Delver of Secrets // Insectile Aberration",
        mana_cost: "{U}",
        cmc: 1,
        type_line: "Creature — Human Wizard // Creature — Human Insect",
        colors: ["U"],
        color_identity: ["U"],
        // No top-level oracle_text
        card_faces: [
          {
            oracle_text:
              "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.",
            image_uris: {
              normal: "https://cards.scryfall.io/normal/front/delver-front.jpg",
            },
          },
          {
            oracle_text: "Flying",
            image_uris: {
              normal: "https://cards.scryfall.io/normal/front/delver-back.jpg",
            },
          },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.oracleText).toBe(
        "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.\n\nFlying"
      );
    });

    it("should handle three or more card faces", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Multi-Face Card",
        card_faces: [
          { oracle_text: "Face 1 ability" },
          { oracle_text: "Face 2 ability" },
          { oracle_text: "Face 3 ability" },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.oracleText).toBe("Face 1 ability\n\nFace 2 ability\n\nFace 3 ability");
    });
  });

  describe("missing optional fields", () => {
    it("should provide sensible defaults when only name is present", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Mystery Card",
      };

      const result = transformApiResponse(apiResponse);

      expect(result).toEqual({
        name: "Mystery Card",
        imageUri: "",
        manaCost: "",
        manaValue: 0,
        typeLine: "",
        colors: [],
        colorIdentity: [],
        oracleText: "",
      });
    });

    it("should handle partial fields correctly", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Partial Card",
        cmc: 3,
        colors: ["G"],
        // Missing: mana_cost, type_line, color_identity, oracle_text, image_uris
      };

      const result = transformApiResponse(apiResponse);

      expect(result.name).toBe("Partial Card");
      expect(result.manaValue).toBe(3);
      expect(result.colors).toEqual(["G"]);
      expect(result.manaCost).toBe("");
      expect(result.typeLine).toBe("");
      expect(result.colorIdentity).toEqual([]);
      expect(result.oracleText).toBe("");
      expect(result.imageUri).toBe("");
    });
  });

  describe("partial card_faces", () => {
    it("should skip card faces with no oracle_text", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Partial Faces Card",
        card_faces: [
          { oracle_text: "First face has text" },
          { oracle_text: "" }, // Empty string
          { oracle_text: "Third face has text" },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.oracleText).toBe("First face has text\n\nThird face has text");
    });

    it("should skip card faces with undefined oracle_text", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Mixed Faces Card",
        card_faces: [
          { oracle_text: "Has text" },
          {}, // No oracle_text property
          { oracle_text: "Also has text" },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.oracleText).toBe("Has text\n\nAlso has text");
    });

    it("should return empty string when all card faces have no oracle_text", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "No Text Card",
        card_faces: [
          { image_uris: { normal: "https://example.com/face1.jpg" } },
          { image_uris: { normal: "https://example.com/face2.jpg" } },
        ],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.oracleText).toBe("");
    });

    it("should handle single face with oracle_text", () => {
      const apiResponse: ScryfallApiResponse = {
        name: "Single Face Card",
        card_faces: [{ oracle_text: "Only face text" }],
      };

      const result = transformApiResponse(apiResponse);

      expect(result.oracleText).toBe("Only face text");
    });
  });
});

// Sample Scryfall API responses for fetchCard tests
const mockLightningBoltResponse = {
  name: "Lightning Bolt",
  mana_cost: "{R}",
  cmc: 1,
  type_line: "Instant",
  colors: ["R"],
  color_identity: ["R"],
  oracle_text: "Lightning Bolt deals 3 damage to any target.",
  image_uris: {
    normal: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg",
    small: "https://cards.scryfall.io/small/front/lightning-bolt.jpg",
  },
};

// Double-faced card response (image_uris and oracle_text on card_faces)
const mockDoubleFacedResponse = {
  name: "Delver of Secrets // Insectile Aberration",
  mana_cost: "{U}",
  cmc: 1,
  type_line: "Creature — Human Wizard // Creature — Human Insect",
  colors: ["U"],
  color_identity: ["U"],
  card_faces: [
    {
      oracle_text:
        "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.",
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/delver-front.jpg",
      },
    },
    {
      oracle_text: "Flying",
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/delver-back.jpg",
      },
    },
  ],
};

// DFC response without top-level colors (as Scryfall actually returns for transform cards)
const mockDfcNoTopLevelColorsResponse = {
  name: "Jace, Vryn's Prodigy // Jace, Telepath Unbound",
  cmc: 2,
  type_line:
    "Legendary Creature — Human Wizard // Legendary Planeswalker — Jace",
  color_identity: ["U"],
  // No top-level colors — Scryfall puts them on card_faces for DFCs
  card_faces: [
    {
      name: "Jace, Vryn's Prodigy",
      mana_cost: "{1}{U}",
      oracle_text: "{T}: Draw a card, then discard a card.",
      colors: ["U"],
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/jace.jpg",
      },
    },
    {
      name: "Jace, Telepath Unbound",
      mana_cost: "",
      oracle_text: "Back face text",
      colors: ["U"],
      image_uris: {
        normal: "https://cards.scryfall.io/normal/back/jace.jpg",
      },
    },
  ],
};

describe("fetchCard", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should fetch and transform a card from the API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockLightningBoltResponse,
    });

    const card = await fetchCard("Lightning Bolt");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.scryfall.com/cards/named?exact=Lightning%20Bolt"
    );
    expect(card).toEqual({
      name: "Lightning Bolt",
      imageUri: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    });
  });

  it("should return null for 404 (card not found)", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const card = await fetchCard("Nonexistent Card");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith('[Scryfall] Card not found: "Nonexistent Card"');

    consoleWarn.mockRestore();
  });

  it("should return null and log warning for API errors", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const card = await fetchCard("Lightning Bolt");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Scryfall] API error for "Lightning Bolt": 500 Internal Server Error'
    );

    consoleWarn.mockRestore();
  });

  it("should return null and log warning for network errors", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const card = await fetchCard("Lightning Bolt");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalled();

    consoleWarn.mockRestore();
  });

  it("should return null and log warning for malformed JSON response", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    });

    const card = await fetchCard("Lightning Bolt");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Scryfall] Failed to fetch "Lightning Bolt":',
      expect.any(Error)
    );

    consoleWarn.mockRestore();
  });

  it("should return null and log warning for 429 rate limiting response", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    const card = await fetchCard("Lightning Bolt");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Scryfall] API error for "Lightning Bolt": 429 Too Many Requests'
    );

    consoleWarn.mockRestore();
  });

  it("should handle double-faced cards", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockDoubleFacedResponse,
    });

    const card = await fetchCard("Delver of Secrets");

    expect(card).toEqual({
      name: "Delver of Secrets // Insectile Aberration",
      imageUri: "https://cards.scryfall.io/normal/front/delver-front.jpg",
      manaCost: "{U}",
      manaValue: 1,
      typeLine: "Creature — Human Wizard // Creature — Human Insect",
      colors: ["U"],
      colorIdentity: ["U"],
      oracleText:
        "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.\n\nFlying",
    });
  });

  it("should derive colors from card_faces when top-level colors is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockDfcNoTopLevelColorsResponse,
    });

    const card = await fetchCard("Jace, Vryn's Prodigy");

    expect(card).not.toBeNull();
    expect(card!.colors).toEqual(["U"]);
    expect(card!.name).toBe("Jace, Vryn's Prodigy // Jace, Telepath Unbound");
  });

  it("should URL-encode special characters in card names", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ...mockLightningBoltResponse,
        name: "Phelia, Exuberant Shepherd",
      }),
    });

    await fetchCard("Phelia, Exuberant Shepherd");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.scryfall.com/cards/named?exact=Phelia%2C%20Exuberant%20Shepherd"
    );
  });

  it("should handle cards with missing optional fields", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        name: "Mystery Card",
        // All optional fields missing
      }),
    });

    const card = await fetchCard("Mystery Card");

    expect(card).toEqual({
      name: "Mystery Card",
      imageUri: "",
      manaCost: "",
      manaValue: 0,
      typeLine: "",
      colors: [],
      colorIdentity: [],
      oracleText: "",
    });
  });
});
