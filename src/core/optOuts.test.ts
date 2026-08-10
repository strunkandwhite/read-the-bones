import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe("loadOptOutNames", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns empty set when file does not exist", async () => {
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { loadOptOutNames } = await import("./optOuts");
    expect(loadOptOutNames()).toEqual(new Set());
  });

  it("returns lowercase names from JSON file", async () => {
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(["Alice", "BOB"]),
    );

    const { loadOptOutNames } = await import("./optOuts");
    const result = loadOptOutNames();
    expect(result).toEqual(new Set(["alice", "bob"]));
  });

  it("throws rather than silently reporting no opt-outs on malformed JSON", async () => {
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('["Player One",]');

    const { loadOptOutNames } = await import("./optOuts");
    expect(() => loadOptOutNames()).toThrow(/\.opt-outs\.json/);
  });

  it("throws when the file parses but is not an array of strings", async () => {
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ names: ["Player One"] }),
    );

    const { loadOptOutNames } = await import("./optOuts");
    expect(() => loadOptOutNames()).toThrow(/\.opt-outs\.json/);
  });
});
