# Conversation Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable resuming LLM conversations across sessions via persisted response IDs.

**Architecture:** New unified `analyze.ts` entry point delegates to `suggest.ts` or `explore.ts` based on arguments. A `conversations.ts` module handles persistence of conversation chains to a JSON file. The REPL saves state after each exchange and generates titles on exit.

**Tech Stack:** TypeScript, Node.js readline, OpenAI Responses API, UUID generation

---

### Task 1: Add Conversation Types

**Files:**
- Modify: `src/cli/types.ts:49` (append after SuggestOptions)

**Step 1: Write the types**

Add these types at the end of `types.ts`:

```typescript
/**
 * A conversation is a chain of LLM responses that can be resumed.
 */
export type Conversation = {
  /** Unique identifier */
  id: string;
  /** LLM-generated summary (~5 words) */
  title: string;
  /** Which mode started this conversation */
  mode: "explore" | "draft";
  /** For draft mode: which draft folder was used */
  draftPath?: string;
  /** Ordered chain of OpenAI response IDs */
  responseIds: string[];
  /** ISO timestamp when conversation started */
  createdAt: string;
  /** ISO timestamp of last activity (for sorting) */
  updatedAt: string;
};

/**
 * Persistent store for all conversations.
 */
export type ConversationStore = {
  conversations: Conversation[];
};
```

**Step 2: Verify types compile**

Run: `cd src/cli && npx tsc --noEmit types.ts`
Expected: No errors

**Step 3: Commit**

```bash
cd src/cli && git add types.ts && git commit -m "feat: add Conversation types"
```

---

### Task 2: Create conversations.ts with Load/Save

**Files:**
- Create: `src/cli/conversations.ts`
- Create: `src/cli/conversations.test.ts`

**Step 1: Write the failing test**

Create `src/cli/conversations.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { loadConversations, saveConversations } from "./conversations";
import type { ConversationStore } from "./types";

const TEST_PATH = "src/cli/test-conversations.json";

describe("conversations", () => {
  beforeEach(() => {
    if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
  });

  afterEach(() => {
    if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
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
      writeFileSync(TEST_PATH, JSON.stringify(existing, null, 2));

      const store = loadConversations(TEST_PATH);
      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].title).toBe("Test conversation");
    });

    it("should backup and reset when JSON is corrupted", () => {
      writeFileSync(TEST_PATH, "{ invalid json }}}");

      const store = loadConversations(TEST_PATH);
      expect(store.conversations).toEqual([]);
      expect(existsSync(TEST_PATH + ".bak")).toBe(true);

      // Cleanup backup
      unlinkSync(TEST_PATH + ".bak");
    });
  });

  describe("saveConversations", () => {
    it("should save conversations to file", () => {
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
```

**Step 2: Run test to verify it fails**

Run: `cd src/cli && npx vitest run conversations.test.ts`
Expected: FAIL with "Cannot find module './conversations'"

**Step 3: Write minimal implementation**

Create `src/cli/conversations.ts`:

```typescript
/**
 * Conversation persistence for resuming LLM sessions.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import type { ConversationStore } from "./types";

/** Default path for conversation storage */
export const DEFAULT_CONVERSATIONS_PATH = "src/cli/conversations.json";

/**
 * Load conversations from disk.
 * Returns empty store if file doesn't exist.
 * Backs up and resets if JSON is corrupted.
 */
export function loadConversations(path: string = DEFAULT_CONVERSATIONS_PATH): ConversationStore {
  if (!existsSync(path)) {
    return { conversations: [] };
  }

  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as ConversationStore;
  } catch {
    // Backup corrupted file and start fresh
    console.warn(`Warning: Corrupted conversations file, backing up to ${path}.bak`);
    renameSync(path, path + ".bak");
    return { conversations: [] };
  }
}

/**
 * Save conversations to disk.
 */
export function saveConversations(
  store: ConversationStore,
  path: string = DEFAULT_CONVERSATIONS_PATH
): void {
  writeFileSync(path, JSON.stringify(store, null, 2));
}
```

**Step 4: Run tests to verify they pass**

Run: `cd src/cli && npx vitest run conversations.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd src/cli && git add conversations.ts conversations.test.ts && git commit -m "feat: add conversation load/save"
```

---

### Task 3: Add Conversation Helper Functions

**Files:**
- Modify: `src/cli/conversations.ts`
- Modify: `src/cli/conversations.test.ts`

**Step 1: Write failing tests for helpers**

Add to `conversations.test.ts`:

```typescript
import {
  loadConversations,
  saveConversations,
  createConversation,
  addResponseId,
  getLatestResponseId,
  listConversations,
} from "./conversations";

// ... existing tests ...

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
  it("should append response ID and update timestamp", () => {
    const convo = createConversation("explore", "resp-1");
    const originalUpdated = convo.updatedAt;

    // Small delay to ensure timestamp changes
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
```

**Step 2: Run test to verify it fails**

Run: `cd src/cli && npx vitest run conversations.test.ts`
Expected: FAIL with "createConversation is not exported"

**Step 3: Add helper implementations**

Add to `src/cli/conversations.ts`:

```typescript
import { randomUUID } from "crypto";
import type { Conversation, ConversationStore } from "./types";

// ... existing code ...

/**
 * Create a new conversation.
 */
export function createConversation(
  mode: "explore" | "draft",
  initialResponseId: string,
  draftPath?: string
): Conversation {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: "Untitled",
    mode,
    ...(draftPath && { draftPath }),
    responseIds: [initialResponseId],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Add a response ID to a conversation and update timestamp.
 */
export function addResponseId(conversation: Conversation, responseId: string): Conversation {
  return {
    ...conversation,
    responseIds: [...conversation.responseIds, responseId],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get the latest response ID for resuming.
 */
export function getLatestResponseId(conversation: Conversation): string {
  return conversation.responseIds[conversation.responseIds.length - 1];
}

/**
 * List conversations sorted by most recent first.
 */
export function listConversations(store: ConversationStore): Conversation[] {
  return [...store.conversations].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `cd src/cli && npx vitest run conversations.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd src/cli && git add conversations.ts conversations.test.ts && git commit -m "feat: add conversation helper functions"
```

---

### Task 4: Add Title Generation to LLM Client

**Files:**
- Modify: `src/cli/llmClient.ts`

**Step 1: Add generateTitle function**

Add to the end of `src/cli/llmClient.ts`:

```typescript
/**
 * Generate a short title for a conversation.
 * Asks the LLM to summarize the conversation in ~5 words.
 *
 * @param previousResponseId - The last response ID from the conversation
 * @param options - LLM configuration options
 * @returns A short title string
 */
export async function generateTitle(
  previousResponseId: string,
  options: LlmOptions
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "Untitled";
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: "gpt-4o-mini", // Always use cheap model for titles
      input: "Summarize our conversation in 5 words or less for a menu title. Reply with just the title, no quotes or punctuation.",
      previous_response_id: previousResponseId,
    });

    const text = response.output_text?.trim();
    return text || "Untitled";
  } catch {
    return "Untitled";
  }
}
```

**Step 2: Verify it compiles**

Run: `cd src/cli && npx tsc --noEmit llmClient.ts`
Expected: No errors

**Step 3: Commit**

```bash
cd src/cli && git add llmClient.ts && git commit -m "feat: add generateTitle for conversation summaries"
```

---

### Task 5: Add .gitignore Entry for conversations.json

**Files:**
- Modify: `src/cli/.gitignore`

**Step 1: Add gitignore entry**

Append to `src/cli/.gitignore`:

```
conversations.json
```

**Step 2: Commit**

```bash
cd src/cli && git add .gitignore && git commit -m "chore: ignore conversations.json"
```

---

### Task 6: Refactor suggest.ts to Export Core Logic

**Files:**
- Modify: `src/cli/suggest.ts`

**Step 1: Extract runSuggestMode function**

Refactor `suggest.ts` to export a `runSuggestMode` function that can be called from `analyze.ts`. The function should:
- Accept `draftPath`, `options`, and optional `conversationId` for resumed conversations
- Return the final `responseId` for conversation tracking
- Not handle its own argument parsing (that moves to `analyze.ts`)

Keep the existing `main()` for backwards compatibility but have it call `runSuggestMode`.

The signature should be:

```typescript
export type SuggestModeOptions = {
  draftPath: string;
  devMode: boolean;
  dryRun: boolean;
  verbose: boolean;
};

export type SuggestModeResult = {
  responseId: string;
};

export async function runSuggestMode(
  options: SuggestModeOptions,
  resumeResponseId?: string
): Promise<SuggestModeResult>;
```

**Step 2: Verify existing tests still pass**

Run: `cd src/cli && npx vitest run`
Expected: All tests pass

**Step 3: Commit**

```bash
cd src/cli && git add suggest.ts && git commit -m "refactor: export runSuggestMode from suggest.ts"
```

---

### Task 7: Refactor explore.ts to Export Core Logic

**Files:**
- Modify: `src/cli/explore.ts`

**Step 1: Extract runExploreMode function**

Same pattern as Task 6. Export a `runExploreMode` function:

```typescript
export type ExploreModeOptions = {
  devMode: boolean;
  dryRun: boolean;
};

export type ExploreModeResult = {
  responseId: string;
};

export async function runExploreMode(
  options: ExploreModeOptions,
  resumeResponseId?: string
): Promise<ExploreModeResult>;
```

**Step 2: Verify it compiles**

Run: `cd src/cli && npx tsc --noEmit explore.ts`
Expected: No errors

**Step 3: Commit**

```bash
cd src/cli && git add explore.ts && git commit -m "refactor: export runExploreMode from explore.ts"
```

---

### Task 8: Update REPL to Support Conversation Tracking

**Files:**
- Modify: `src/cli/repl.ts`

**Step 1: Add conversation callback support**

Update `runRepl` to accept an optional callback that's called after each response:

```typescript
export type ReplOptions = {
  devMode: boolean;
  model: string;
  /** Called after each response with the new response ID */
  onResponse?: (responseId: string) => void;
};
```

Call `onResponse` after each successful LLM response in the REPL loop.

**Step 2: Verify it compiles**

Run: `cd src/cli && npx tsc --noEmit repl.ts`
Expected: No errors

**Step 3: Commit**

```bash
cd src/cli && git add repl.ts && git commit -m "feat: add onResponse callback to REPL"
```

---

### Task 9: Create Unified analyze.ts Entry Point

**Files:**
- Create: `src/cli/analyze.ts`

**Step 1: Create the entry point**

Create `src/cli/analyze.ts` with:
- Argument parsing for `data`, `draft`, `--resume`, `--dev`, `--dry-run`, `--verbose`
- Mode detection based on first positional argument
- Conversation management (create on start, save after each response, title on exit)
- Resume menu when `--resume` is passed

```typescript
#!/usr/bin/env node
/**
 * Unified CLI entry point for draft analysis.
 *
 * Usage:
 *   ./analyze data              # Explore historical data
 *   ./analyze draft             # Get pick suggestions for active draft
 *   ./analyze --resume          # Resume a previous conversation
 */

import "dotenv/config";
import * as readline from "readline";

import { runSuggestMode } from "./suggest";
import { runExploreMode } from "./explore";
import {
  loadConversations,
  saveConversations,
  createConversation,
  addResponseId,
  getLatestResponseId,
  listConversations,
  DEFAULT_CONVERSATIONS_PATH,
} from "./conversations";
import { generateTitle } from "./llmClient";
import type { Conversation, ConversationStore } from "./types";

// ... argument parsing ...
// ... mode detection ...
// ... conversation picker for --resume ...
// ... main logic ...
```

**Step 2: Test manually**

Run: `cd src/cli && npx tsx analyze.ts data --dry-run`
Expected: Should show explore prompts

Run: `cd src/cli && npx tsx analyze.ts --resume`
Expected: Should show "No previous conversations found." or list of conversations

**Step 3: Commit**

```bash
cd src/cli && git add analyze.ts && git commit -m "feat: add unified analyze.ts entry point"
```

---

### Task 10: Update Wrapper Script

**Files:**
- Modify: `/Users/arpanet/code/read-the-bones/analyze` (in parent repo)

**Step 1: Update script to use analyze.ts**

Change the analyze script to call the new entry point:

```bash
#!/usr/bin/env bash
npx tsx src/cli/analyze.ts "$@"
```

**Step 2: Remove scratch script or make it alias**

The `scratch` script can either be removed or updated to be an alias:

```bash
#!/usr/bin/env bash
npx tsx src/cli/analyze.ts data "$@"
```

**Step 3: Test the wrapper**

Run: `./analyze --resume`
Expected: Should show conversation list or "No previous conversations found."

**Step 4: Commit (in parent repo)**

```bash
git add analyze scratch && git commit -m "chore: update wrapper scripts for unified CLI"
```

---

### Task 11: Integration Testing

**Step 1: Test full flow manually**

1. Start a new explore conversation:
   ```bash
   ./analyze data --dev
   ```
   Ask a question, then type `exit`

2. Verify conversation was saved:
   ```bash
   cat src/cli/conversations.json
   ```
   Should show one conversation with a title

3. Resume the conversation:
   ```bash
   ./analyze --resume
   ```
   Select the conversation, ask a follow-up

4. Verify response ID was appended:
   ```bash
   cat src/cli/conversations.json
   ```
   Should show multiple responseIds

**Step 2: Test draft mode**

```bash
./analyze draft --dev  # With an active draft in data/
```

**Step 3: Commit submodule update**

```bash
cd src/cli && git add -A && git commit -m "feat: complete conversation resume implementation"
git push
cd ../.. && git add src/cli && git commit -m "Update submodule ref" && git push
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add Conversation types | types.ts |
| 2 | Create load/save functions | conversations.ts, conversations.test.ts |
| 3 | Add helper functions | conversations.ts, conversations.test.ts |
| 4 | Add title generation | llmClient.ts |
| 5 | Gitignore conversations.json | .gitignore |
| 6 | Refactor suggest.ts | suggest.ts |
| 7 | Refactor explore.ts | explore.ts |
| 8 | Update REPL with callback | repl.ts |
| 9 | Create analyze.ts | analyze.ts |
| 10 | Update wrapper scripts | analyze, scratch |
| 11 | Integration testing | - |
