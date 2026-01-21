/**
 * Tests that createDraft() correctly handles the bannedCards parameter.
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
  sheetId: null,
} as const;

describe("createDraft banned cards support", () => {
  it("passes bannedCards JSON string to INSERT args", async () => {
    const client = createMockClient();
    const bannedCards = JSON.stringify(["Lightning Bolt", "Ancestral Recall"]);

    await createDraft(
      client as never,
      baseArgs.draftId,
      baseArgs.draftName,
      baseArgs.draftDate,
      baseArgs.cubeSnapshotId,
      baseArgs.importHash,
      baseArgs.numSeats,
      baseArgs.isComplete,
      baseArgs.sheetId,
      bannedCards
    );

    expect(client.execute).toHaveBeenCalledOnce();
    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("banned_cards");
    expect(call.args).toContain(bannedCards);
  });

  it("passes null when bannedCards is null", async () => {
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
      baseArgs.sheetId,
      null
    );

    expect(client.execute).toHaveBeenCalledOnce();
    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("banned_cards");
    // bannedCards is the last arg
    expect(call.args[call.args.length - 1]).toBeNull();
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
      baseArgs.sheetId,
      null
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
