import { describe, it, expect, beforeEach, vi } from "vitest";
import { vol } from "memfs";

// Mock fs module before importing modules that use it
vi.mock("fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

import {
  loadConversations,
  saveConversations,
  createConversation,
  addResponseId,
  getLatestResponseId,
  listConversations,
} from "./conversations";
import type { ConversationStore } from "./types";

const TEST_PATH = "/app/conversations.json";

describe("conversations", () => {
  beforeEach(() => {
    vol.reset();
  });

  describe("loadConversations", () => {
    it("should return empty store when file does not exist", () => {
      const store = loadConversations(TEST_PATH);
      expect(store.conversations).toEqual([]);
    });

    it("should load existing conversations from file", () => {
      const existing: ConversationStore = {
        conversations: [
          {
            id: "test-id",
            title: "Test conversation",
            mode: "explore",
            responseIds: ["resp-1"],
            createdAt: "2026-01-19T00:00:00Z",
            updatedAt: "2026-01-19T00:00:00Z",
          },
        ],
      };
      vol.fromJSON({
        [TEST_PATH]: JSON.stringify(existing, null, 2),
      });

      const store = loadConversations(TEST_PATH);
      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].title).toBe("Test conversation");
    });

    it("should backup and reset when JSON is corrupted", () => {
      vol.fromJSON({
        [TEST_PATH]: "{ invalid json }}}",
      });

      const store = loadConversations(TEST_PATH);
      expect(store.conversations).toEqual([]);

      // Verify backup was created
      const fsState = vol.toJSON();
      expect(fsState[TEST_PATH + ".bak"]).toBe("{ invalid json }}}");
    });
  });

  describe("saveConversations", () => {
    it("should save conversations to file", () => {
      // Create parent directory
      vol.mkdirSync("/app", { recursive: true });

      const store: ConversationStore = {
        conversations: [
          {
            id: "save-test",
            title: "Saved convo",
            mode: "draft",
            draftPath: "/some/path",
            responseIds: ["resp-a", "resp-b"],
            createdAt: "2026-01-19T00:00:00Z",
            updatedAt: "2026-01-19T01:00:00Z",
          },
        ],
      };

      saveConversations(store, TEST_PATH);

      const loaded = loadConversations(TEST_PATH);
      expect(loaded.conversations[0].id).toBe("save-test");
      expect(loaded.conversations[0].responseIds).toEqual(["resp-a", "resp-b"]);
    });
  });
});

describe("createConversation", () => {
  it("should create a conversation with correct fields", () => {
    const convo = createConversation("explore", "resp-123");

    expect(convo.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(convo.title).toBe("Untitled");
    expect(convo.mode).toBe("explore");
    expect(convo.responseIds).toEqual(["resp-123"]);
    expect(convo.draftPath).toBeUndefined();
  });

  it("should include draftPath for draft mode", () => {
    const convo = createConversation("draft", "resp-456", "/data/my-draft");

    expect(convo.mode).toBe("draft");
    expect(convo.draftPath).toBe("/data/my-draft");
  });
});

describe("addResponseId", () => {
  it("should append response ID and update timestamp", async () => {
    const convo = createConversation("explore", "resp-1");
    const originalUpdated = convo.updatedAt;

    // Small delay to ensure timestamp changes
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = addResponseId(convo, "resp-2");

    expect(updated.responseIds).toEqual(["resp-1", "resp-2"]);
    expect(updated.updatedAt).not.toBe(originalUpdated);
  });
});

describe("getLatestResponseId", () => {
  it("should return the last response ID", () => {
    const convo = createConversation("explore", "resp-1");
    convo.responseIds.push("resp-2", "resp-3");

    expect(getLatestResponseId(convo)).toBe("resp-3");
  });
});

describe("listConversations", () => {
  it("should return conversations sorted by updatedAt descending", () => {
    const store: ConversationStore = {
      conversations: [
        {
          id: "old",
          title: "Old",
          mode: "explore",
          responseIds: ["r1"],
          createdAt: "2026-01-17T00:00:00Z",
          updatedAt: "2026-01-17T00:00:00Z",
        },
        {
          id: "new",
          title: "New",
          mode: "explore",
          responseIds: ["r2"],
          createdAt: "2026-01-19T00:00:00Z",
          updatedAt: "2026-01-19T00:00:00Z",
        },
        {
          id: "mid",
          title: "Mid",
          mode: "draft",
          responseIds: ["r3"],
          createdAt: "2026-01-18T00:00:00Z",
          updatedAt: "2026-01-18T00:00:00Z",
        },
      ],
    };

    const sorted = listConversations(store);

    expect(sorted[0].id).toBe("new");
    expect(sorted[1].id).toBe("mid");
    expect(sorted[2].id).toBe("old");
  });
});
