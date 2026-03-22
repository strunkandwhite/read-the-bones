import { describe, it, expect, vi, beforeEach } from "vitest";
import { isOptedOut } from "./optOuts";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe("isOptedOut", () => {
  it("returns true for opted-out name (case insensitive)", () => {
    const optOuts = new Set(["alice"]);
    expect(isOptedOut("Alice", optOuts)).toBe(true);
    expect(isOptedOut("ALICE", optOuts)).toBe(true);
    expect(isOptedOut("alice", optOuts)).toBe(true);
  });

  it("returns false for non-opted-out name", () => {
    const optOuts = new Set(["alice"]);
    expect(isOptedOut("Bob", optOuts)).toBe(false);
  });

  it("returns false for empty opt-out set", () => {
    expect(isOptedOut("Alice", new Set())).toBe(false);
  });
});

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

  it("returns empty set when file contains invalid JSON", async () => {
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not valid json");

    const { loadOptOutNames } = await import("./optOuts");
    expect(loadOptOutNames()).toEqual(new Set());
  });
});
