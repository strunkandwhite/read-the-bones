import { describe, it, expect, vi, afterEach } from "vitest";
import { parseCubeCobraInput, fetchCubeCobraList, loadCardPool } from "./cubecobra";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("parseCubeCobraInput", () => {
  it("parses cubecobra: prefix", () => {
    expect(parseCubeCobraInput("cubecobra:my_cube_id")).toBe("my_cube_id");
  });

  it("parses a CubeCobra list URL", () => {
    expect(parseCubeCobraInput("https://cubecobra.com/cube/list/my_cube_id")).toBe("my_cube_id");
  });

  it("parses a CubeCobra overview URL", () => {
    expect(parseCubeCobraInput("https://cubecobra.com/cube/overview/my_cube_id")).toBe(
      "my_cube_id"
    );
  });

  it("returns null for a file: input", () => {
    expect(parseCubeCobraInput("file:path/to/list.txt")).toBeNull();
  });

  it("returns null for an unrecognized string", () => {
    expect(parseCubeCobraInput("some_random_string")).toBeNull();
  });
});

describe("fetchCubeCobraList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches cube list from CubeCobra API and returns card names", async () => {
    const cubeText = "Lightning Bolt\nCounterspell\nSwords to Plowshares\n";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(cubeText, { status: 200 }));

    const cards = await fetchCubeCobraList("my_cube");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://cubecobra.com/cube/api/cubelist/my_cube"
    );
    expect(cards).toEqual(["Lightning Bolt", "Counterspell", "Swords to Plowshares"]);
  });

  it("trims whitespace and filters blank lines", async () => {
    const cubeText = "  Lightning Bolt  \n\n  Counterspell\n\n";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(cubeText, { status: 200 }));

    const cards = await fetchCubeCobraList("my_cube");

    expect(cards).toEqual(["Lightning Bolt", "Counterspell"]);
  });

  it("throws when the API returns a non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    await expect(fetchCubeCobraList("bad_cube")).rejects.toThrow(
      'CubeCobra API returned 404 for cube "bad_cube"'
    );
  });

  it("encodes special characters in the cube ID", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Lightning Bolt\n", { status: 200 })
    );

    await fetchCubeCobraList("cube with spaces");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://cubecobra.com/cube/api/cubelist/cube%20with%20spaces"
    );
  });
});

describe("loadCardPool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads card names from a file", async () => {
    const { readFile } = await import("fs/promises");
    vi.mocked(readFile).mockResolvedValue("Lightning Bolt\nCounterspell\n\nSwords to Plowshares\n");

    const cards = await loadCardPool("file:my-cube.txt");

    expect(readFile).toHaveBeenCalledWith("my-cube.txt", "utf-8");
    expect(cards).toEqual(["Lightning Bolt", "Counterspell", "Swords to Plowshares"]);
  });

  it("fetches from CubeCobra when given a cubecobra: prefix", async () => {
    const cubeText = "Force of Will\nBrainstorm\n";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(cubeText, { status: 200 }));

    const cards = await loadCardPool("cubecobra:my_cube_id");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://cubecobra.com/cube/api/cubelist/my_cube_id"
    );
    expect(cards).toEqual(["Force of Will", "Brainstorm"]);
  });

  it("fetches from CubeCobra when given a CubeCobra URL", async () => {
    const cubeText = "Dark Ritual\n";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(cubeText, { status: 200 }));

    const cards = await loadCardPool("https://cubecobra.com/cube/list/xyz789");

    expect(globalThis.fetch).toHaveBeenCalledWith("https://cubecobra.com/cube/api/cubelist/xyz789");
    expect(cards).toEqual(["Dark Ritual"]);
  });

  it("throws for unrecognized format", async () => {
    await expect(loadCardPool("garbage_input")).rejects.toThrow(
      'Unrecognized pool format: "garbage_input"'
    );
  });
});
