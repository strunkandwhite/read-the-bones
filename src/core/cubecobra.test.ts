import { describe, it, expect, vi } from "vitest";
import { parseCubeCobraInput, loadCardPool } from "./cubecobra";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("parseCubeCobraInput", () => {
  it("parses cubecobra: prefix", () => {
    expect(parseCubeCobraInput("cubecobra:my_cube_id")).toBe("my_cube_id");
  });

  it("parses a CubeCobra list URL", () => {
    expect(
      parseCubeCobraInput("https://cubecobra.com/cube/list/my_cube_id"),
    ).toBe("my_cube_id");
  });

  it("parses a CubeCobra overview URL", () => {
    expect(
      parseCubeCobraInput("https://cubecobra.com/cube/overview/my_cube_id"),
    ).toBe("my_cube_id");
  });

  it("returns null for a file: input", () => {
    expect(parseCubeCobraInput("file:path/to/list.txt")).toBeNull();
  });

  it("returns null for an unrecognized string", () => {
    expect(parseCubeCobraInput("some_random_string")).toBeNull();
  });
});

describe("loadCardPool", () => {
  it("reads card names from a file", async () => {
    const { readFile } = await import("fs/promises");
    vi.mocked(readFile).mockResolvedValue(
      "Lightning Bolt\nCounterspell\n\nSwords to Plowshares\n",
    );

    const cards = await loadCardPool("file:my-cube.txt");

    expect(readFile).toHaveBeenCalledWith("my-cube.txt", "utf-8");
    expect(cards).toEqual([
      "Lightning Bolt",
      "Counterspell",
      "Swords to Plowshares",
    ]);
  });

  it("throws for unrecognized format", async () => {
    await expect(loadCardPool("garbage_input")).rejects.toThrow(
      'Unrecognized pool format: "garbage_input"',
    );
  });
});
