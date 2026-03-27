import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateSeatTokens,
  resolveToken,
  getSeatTokens,
  regenerateToken,
  updateDisplayName,
  updateAutoPick,
  getSeatDisplayNames,
  getSeatSettings,
} from "./seatTokens";

function createMockClient() {
  return { execute: vi.fn() };
}

describe("generateSeatTokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates N tokens with unique values and calls INSERT for each", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({ rows: [] });

    const result = await generateSeatTokens(mockClient as never, "draft-1", 4);

    expect(result).toHaveLength(4);
    expect(mockClient.execute).toHaveBeenCalledTimes(4);

    // Each seat should be numbered 1..4
    expect(result.map((t) => t.seat)).toEqual([1, 2, 3, 4]);

    // All tokens should be unique
    const tokens = result.map((t) => t.token);
    expect(new Set(tokens).size).toBe(4);

    // Each call should be an INSERT INTO seat_tokens
    for (let i = 0; i < 4; i++) {
      expect(mockClient.execute).toHaveBeenNthCalledWith(
        i + 1,
        expect.objectContaining({
          sql: expect.stringContaining("INSERT INTO seat_tokens"),
          args: ["draft-1", i + 1, result[i].token],
        })
      );
    }
  });
});

describe("resolveToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns { draftId, seat, autoPick } for a valid token", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [{ draft_id: "draft-1", seat: 3, auto_pick: 1, display_name: null }],
    });

    const result = await resolveToken(mockClient as never, "some-token");

    expect(result).toEqual({ draftId: "draft-1", seat: 3, autoPick: true, displayName: null });
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT draft_id, seat, auto_pick, display_name"),
        args: ["some-token"],
      })
    );
  });

  it("returns null when no rows returned", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({ rows: [] });

    const result = await resolveToken(mockClient as never, "bad-token");

    expect(result).toBeNull();
  });
});

describe("getSeatTokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all tokens for a draft ordered by seat", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [
        { seat: 1, token: "tok-a", display_name: "Alice", auto_pick: 0 },
        { seat: 2, token: "tok-b", display_name: null, auto_pick: 1 },
      ],
    });

    const result = await getSeatTokens(mockClient as never, "draft-1");

    expect(result).toEqual([
      { seat: 1, token: "tok-a", displayName: "Alice", autoPick: false },
      { seat: 2, token: "tok-b", displayName: null, autoPick: true },
    ]);
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("FROM seat_tokens WHERE draft_id = ?"),
        args: ["draft-1"],
      })
    );
  });
});

describe("regenerateToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls UPDATE with a new token and returns it", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({ rows: [] });

    const newToken = await regenerateToken(mockClient as never, "draft-1", 2);

    expect(typeof newToken).toBe("string");
    expect(newToken.length).toBeGreaterThan(0);
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("UPDATE seat_tokens SET token = ?"),
        args: [newToken, "draft-1", 2],
      })
    );
  });
});

describe("updateDisplayName", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls UPDATE with the display name", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({ rows: [] });

    await updateDisplayName(mockClient as never, "draft-1", 3, "Bob");

    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("UPDATE seat_tokens SET display_name = ?"),
        args: ["Bob", "draft-1", 3],
      })
    );
  });
});

describe("updateAutoPick", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls UPDATE with 1 when enabled", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({ rows: [] });

    await updateAutoPick(mockClient as never, "draft-1", 1, true);

    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("UPDATE seat_tokens SET auto_pick = ?"),
        args: [1, "draft-1", 1],
      })
    );
  });

  it("calls UPDATE with 0 when disabled", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({ rows: [] });

    await updateAutoPick(mockClient as never, "draft-1", 2, false);

    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("UPDATE seat_tokens SET auto_pick = ?"),
        args: [0, "draft-1", 2],
      })
    );
  });
});

describe("getSeatDisplayNames", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns mapping of seat to display name, skipping nulls", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [
        { seat: 1, display_name: "Alice" },
        { seat: 2, display_name: null },
        { seat: 3, display_name: "Charlie" },
      ],
    });

    const result = await getSeatDisplayNames(mockClient as never, "draft-1");

    expect(result).toEqual({ "1": "Alice", "3": "Charlie" });
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT seat, display_name FROM seat_tokens"),
        args: ["draft-1"],
      })
    );
  });

  it("returns empty object when no display names set", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [
        { seat: 1, display_name: null },
        { seat: 2, display_name: null },
      ],
    });

    const result = await getSeatDisplayNames(mockClient as never, "draft-1");

    expect(result).toEqual({});
  });
});

describe("getSeatSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns settings for an existing seat", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [{ auto_pick: 1, display_name: "Bob" }],
    });

    const result = await getSeatSettings(mockClient as never, "draft-1", 2);

    expect(result).toEqual({ autoPick: true, displayName: "Bob" });
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT auto_pick, display_name"),
        args: ["draft-1", 2],
      })
    );
  });

  it("returns null when seat not found", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({ rows: [] });

    const result = await getSeatSettings(mockClient as never, "draft-1", 99);

    expect(result).toBeNull();
  });

  it("returns autoPick false when auto_pick is 0", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [{ auto_pick: 0, display_name: null }],
    });

    const result = await getSeatSettings(mockClient as never, "draft-1", 1);

    expect(result).toEqual({ autoPick: false, displayName: null });
  });
});
