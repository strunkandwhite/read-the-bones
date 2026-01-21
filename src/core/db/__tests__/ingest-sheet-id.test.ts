/**
 * Tests that createDraft() correctly handles the sheetId parameter.
 *
 * Uses a mock libsql client to capture the SQL and args passed to execute().
 */

import { describe, it, expect, vi } from "vitest";
import { createDraft } from "../ingest/db-helpers";

function createMockClient() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

const baseArgs = {
  draftId: "test-draft",
  draftName: "Test Draft",
  draftDate: "2026-01-01",
  cubeSnapshotId: 1,
  importHash: "abc123",
  numSeats: 10,
  isComplete: true,
  bannedCards: null,
} as const;

describe("createDraft sheet_id support", () => {
  it("passes sheetId to INSERT args when provided", async () => {
    const client = createMockClient();
    const sheetId = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgV";

    await createDraft(
      client as never,
      baseArgs.draftId,
      baseArgs.draftName,
      baseArgs.draftDate,
      baseArgs.cubeSnapshotId,
      baseArgs.importHash,
      baseArgs.numSeats,
      baseArgs.isComplete,
      sheetId,
      baseArgs.bannedCards
    );

    expect(client.execute).toHaveBeenCalledOnce();
    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("sheet_id");
    expect(call.args).toContain(sheetId);
  });

  it("passes null when sheetId is null", async () => {
    const client = createMockClient();

    await createDraft(
      client as never,
      baseArgs.draftId,
      baseArgs.draftName,
      baseArgs.draftDate,
      baseArgs.cubeSnapshotId,
      baseArgs.importHash,
      baseArgs.numSeats,
      baseArgs.isComplete,
      null,
      baseArgs.bannedCards
    );

    expect(client.execute).toHaveBeenCalledOnce();
    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("sheet_id");
    // sheetId is the 8th arg (0-indexed: index 7)
    const sheetIdIndex = call.sql
      .match(/INSERT INTO drafts\s*\(([^)]+)\)/)![1]
      .split(",")
      .map((s: string) => s.trim())
      .indexOf("sheet_id");
    expect(call.args[sheetIdIndex]).toBeNull();
  });

  it("INSERT has matching column and placeholder count", async () => {
    const client = createMockClient();

    await createDraft(
      client as never,
      baseArgs.draftId,
      baseArgs.draftName,
      baseArgs.draftDate,
      baseArgs.cubeSnapshotId,
      baseArgs.importHash,
      baseArgs.numSeats,
      baseArgs.isComplete,
      null,
      baseArgs.bannedCards
    );

    const call = client.execute.mock.calls[0][0];
    const columnMatch = call.sql.match(/INSERT INTO drafts\s*\(([^)]+)\)/);
    const valuesMatch = call.sql.match(/VALUES\s*\(([^)]+)\)/);
    expect(columnMatch).not.toBeNull();
    expect(valuesMatch).not.toBeNull();

    const columns = columnMatch![1].split(",").map((s: string) => s.trim());
    const placeholders = valuesMatch![1].split(",").map((s: string) => s.trim());
    expect(columns).toHaveLength(placeholders.length);
    expect(call.args).toHaveLength(columns.length);
  });
});
