import { describe, it, expect } from "vitest";
import { transformApiResponse, ScryfallApiResponse } from "./scryfallApi";

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
