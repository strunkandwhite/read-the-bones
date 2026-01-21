/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCardImage } from "./useCardImage";

// Mock the card data context
vi.mock("./CardDataContext", () => ({
  useCardData: () => ({
    cards: [
      {
        cardName: "Lightning Bolt",
        scryfall: { imageUri: "https://cards.scryfall.io/normal/bolt.jpg" },
      },
      {
        cardName: "Counterspell",
        scryfall: { imageUri: "https://cards.scryfall.io/normal/counter.jpg" },
      },
    ],
  }),
}));

describe("useCardImage", () => {
  it("returns image URL for card in local data", () => {
    const { result } = renderHook(() => useCardImage("Lightning Bolt"));
    expect(result.current).toBe("https://cards.scryfall.io/normal/bolt.jpg");
  });

  it("matches card names case-insensitively", () => {
    const { result } = renderHook(() => useCardImage("lightning bolt"));
    expect(result.current).toBe("https://cards.scryfall.io/normal/bolt.jpg");
  });

  it("strips numeric suffixes from card names", () => {
    const { result } = renderHook(() => useCardImage("Lightning Bolt 2"));
    expect(result.current).toBe("https://cards.scryfall.io/normal/bolt.jpg");
  });

  it("returns Scryfall fallback URL for unknown cards", () => {
    const { result } = renderHook(() => useCardImage("Unknown Card"));
    expect(result.current).toBe(
      "https://api.scryfall.com/cards/named?exact=Unknown%20Card&format=image"
    );
  });
});
