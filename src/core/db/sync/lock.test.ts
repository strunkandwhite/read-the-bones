import { describe, it, expect } from "vitest";
import type { Client } from "@libsql/client";
import { getLiveDraftingDrafts } from "./lock";
import { createMemDb, insertDraft } from "../__tests__/testDb";

async function addDraft(
  client: Client,
  draftId: string,
  opts: { phase: string; inApp: boolean; sheetId?: string }
): Promise<void> {
  await insertDraft(client, draftId, { phase: opts.phase });
  await client.execute({
    sql: `UPDATE drafts SET in_app = ?, sheet_id = ? WHERE draft_id = ?`,
    args: [opts.inApp ? 1 : 0, opts.sheetId ?? null, draftId],
  });
}

describe("getLiveDraftingDrafts", () => {
  it("returns in-app drafts that are currently drafting", async () => {
    const client = await createMemDb();
    await addDraft(client, "live-drafting", { phase: "drafting", inApp: true });

    expect(await getLiveDraftingDrafts(client)).toEqual(["live-drafting"]);
  });

  it("ignores in-app drafts in any other phase", async () => {
    const client = await createMemDb();
    await addDraft(client, "live-setup", { phase: "setup", inApp: true });
    await addDraft(client, "live-playing", { phase: "playing", inApp: true });
    await addDraft(client, "live-complete", { phase: "complete", inApp: true });

    expect(await getLiveDraftingDrafts(client)).toEqual([]);
  });

  it("ignores drafts that are not in-app", async () => {
    const client = await createMemDb();
    await addDraft(client, "sheet-drafting", { phase: "drafting", inApp: false, sheetId: "abc" });

    expect(await getLiveDraftingDrafts(client)).toEqual([]);
  });

  it("returns every eligible draft, in id order", async () => {
    const client = await createMemDb();
    await addDraft(client, "b-draft", { phase: "drafting", inApp: true });
    await addDraft(client, "a-draft", { phase: "drafting", inApp: true });

    expect(await getLiveDraftingDrafts(client)).toEqual(["a-draft", "b-draft"]);
  });
});
