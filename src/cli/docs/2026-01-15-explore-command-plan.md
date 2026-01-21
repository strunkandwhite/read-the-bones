# Explore Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `./scratch` CLI command for general Q&A about historical draft data.

**Architecture:** Extract shared REPL from suggest.ts, create new entry point that loads all draft data and formats it as a prompt for the LLM.

**Tech Stack:** TypeScript, OpenAI Responses API (via existing llmClient.ts)

---

## Task 1: Extract REPL to Shared Module

**Files:**
- Create: `src/cli/repl.ts`
- Modify: `src/cli/suggest.ts`

**Step 1: Create repl.ts with extracted REPL loop**

```typescript
/**
 * Shared REPL loop for CLI tools.
 */

import * as readline from "readline";
import { continueConversation } from "./llmClient";
import { lookupCard } from "./scryfallTool";
import { Spinner } from "./spinner";

/**
 * Options for the REPL loop.
 */
export type ReplOptions = {
  devMode: boolean;
  model: string;
};

/**
 * Get one line of input from the user.
 * Returns null on SIGINT or EOF.
 */
function getInput(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let answered = false;

    rl.on("SIGINT", () => {
      if (!answered) {
        answered = true;
        rl.close();
        resolve(null);
      }
    });

    rl.on("close", () => {
      if (!answered) {
        answered = true;
        resolve(null);
      }
    });

    rl.question("> ", (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Run the interactive REPL for follow-up questions.
 *
 * @param responseId - Response ID from initial LLM call
 * @param options - LLM options (devMode, model)
 */
export async function runRepl(responseId: string, options: ReplOptions): Promise<void> {
  let currentResponseId = responseId;

  while (true) {
    const input = await getInput();

    if (input === null) {
      console.log("\nSession ended.");
      break;
    }

    const trimmed = input.trim();

    if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit" || trimmed === "/quit") {
      console.log("Session ended.");
      break;
    }

    if (!trimmed) {
      continue;
    }

    const spinner = new Spinner("Thinking...");
    try {
      spinner.start();
      const result = await continueConversation(trimmed, currentResponseId, lookupCard, options);
      spinner.stop();

      console.log();
      console.log("─".repeat(60));
      console.log();
      console.log(result.text);
      console.log();

      currentResponseId = result.responseId;
    } catch (error) {
      spinner.stop();
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      console.log();
    }
  }
}
```

**Step 2: Update suggest.ts to use extracted REPL**

Replace the `runRepl` function and its helper with an import:

```typescript
// Add to imports (after other local imports)
import { runRepl } from "./repl";
```

Remove lines 107-197 (the `runRepl` function and `getInput` helper).

Remove the `readline` import since it's no longer needed:

```typescript
// Remove this line
import * as readline from "readline";
```

**Step 3: Run suggest.ts to verify it still works**

```bash
cd /Users/arpanet/code/read-the-bones
./analyze data/innistrad --dry-run
```

Expected: Prompts print without errors.

**Step 4: Commit in submodule**

```bash
cd /Users/arpanet/code/read-the-bones/src/cli
git add repl.ts suggest.ts
git commit -m "refactor: extract REPL loop to shared module"
```

---

## Task 2: Create Explore Prompt Builder

**Files:**
- Create: `src/cli/explorePrompt.ts`

**Step 1: Create explorePrompt.ts**

```typescript
/**
 * Prompt builder for the explore command.
 *
 * Formats all historical draft data (picks, matches, pools) into a prompt
 * for general Q&A about player performance, card analysis, and archetypes.
 */

import type { CardPick, DraftMetadata } from "../core/types";
import type { MatchResult } from "../core/parseMatches";
import { parseMatches } from "../core/parseMatches";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Build the system prompt for exploration mode.
 */
export function buildExploreSystemPrompt(): string {
  return `You are an MTG draft analyst with access to historical rotisserie draft data.

You can answer questions about:
- Player performance (win rates, pick tendencies, color preferences)
- Card performance (correlation with wins, pick patterns)
- Archetype analysis (which strategies win most)
- Draft trends across time

CRITICAL: Output plain text only. NEVER use markdown formatting. No **, no #, no bullets (*/-), no code blocks. Just plain text with line breaks.

The data follows. Answer questions based only on this data.`;
}

/**
 * Format match results for a single draft.
 */
function formatMatches(matches: MatchResult[]): string {
  if (matches.length === 0) {
    return "  (no match data)";
  }

  const lines: string[] = [];
  for (const match of matches) {
    const winner =
      match.player1GamesWon > match.player2GamesWon
        ? match.player1
        : match.player2GamesWon > match.player1GamesWon
          ? match.player2
          : "tie";
    lines.push(
      `  ${match.player1} vs ${match.player2}: ${match.player1GamesWon}-${match.player2GamesWon} (${winner} wins)`
    );
  }
  return lines.join("\n");
}

/**
 * Format picks by player for a single draft.
 */
function formatPicksByPlayer(picks: CardPick[], draftId: string): string {
  // Filter to this draft and group by player
  const draftPicks = picks.filter((p) => p.draftId === draftId);
  const byPlayer = new Map<string, string[]>();

  for (const pick of draftPicks) {
    if (!byPlayer.has(pick.drafterName)) {
      byPlayer.set(pick.drafterName, []);
    }
    byPlayer.get(pick.drafterName)!.push(pick.cardName);
  }

  const lines: string[] = [];
  for (const [player, cards] of byPlayer) {
    lines.push(`  ${player}: ${cards.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Load raw match results from a draft folder.
 */
function loadRawMatches(dataDir: string, draftId: string): MatchResult[] {
  const matchesPath = join(dataDir, draftId, "matches.csv");
  if (!existsSync(matchesPath)) {
    return [];
  }
  const csv = readFileSync(matchesPath, "utf-8");
  return parseMatches(csv);
}

/**
 * Build the user prompt with all historical data.
 *
 * @param picks - All picks from all drafts
 * @param draftIds - List of draft IDs
 * @param draftMetadata - Metadata for each draft
 * @param dataDir - Path to data directory (for loading raw matches)
 * @param currentPool - Card pool from most recent draft
 */
export function buildExploreUserPrompt(
  picks: CardPick[],
  draftIds: string[],
  draftMetadata: Map<string, DraftMetadata>,
  dataDir: string,
  currentPool: string[]
): string {
  const sections: string[] = [];

  // Sort drafts by date (oldest first for chronological narrative)
  const sortedDraftIds = [...draftIds].sort((a, b) => {
    const dateA = draftMetadata.get(a)?.date ?? "1970-01-01";
    const dateB = draftMetadata.get(b)?.date ?? "1970-01-01";
    return dateA.localeCompare(dateB);
  });

  // Format each draft
  for (const draftId of sortedDraftIds) {
    const meta = draftMetadata.get(draftId);
    const numDrafters = meta?.numDrafters ?? "?";
    const date = meta?.date ?? "unknown";

    const draftSection: string[] = [];
    draftSection.push(`=== DRAFT: ${draftId} (${numDrafters} players, ${date}) ===`);
    draftSection.push("");

    // Match results
    const matches = loadRawMatches(dataDir, draftId);
    draftSection.push("MATCH RESULTS:");
    draftSection.push(formatMatches(matches));
    draftSection.push("");

    // Picks by player
    draftSection.push("PICKS BY PLAYER:");
    draftSection.push(formatPicksByPlayer(picks, draftId));

    sections.push(draftSection.join("\n"));
  }

  // Add current pool at the end
  sections.push(`=== CARD POOL (${currentPool.length} cards, from most recent draft) ===`);
  sections.push(currentPool.join(", "));

  return sections.join("\n\n");
}
```

**Step 2: Commit**

```bash
cd /Users/arpanet/code/read-the-bones/src/cli
git add explorePrompt.ts
git commit -m "feat: add prompt builder for explore command"
```

---

## Task 3: Create Explore Entry Point

**Files:**
- Create: `src/cli/explore.ts`

**Step 1: Create explore.ts**

```typescript
#!/usr/bin/env node
/**
 * CLI entry point for exploring historical draft data.
 *
 * Usage:
 *   ./scratch              # Production (gpt-5)
 *   ./scratch --dev        # Dev mode (cheaper model)
 *   ./scratch --dry-run    # Show prompt without API call
 */

import "dotenv/config";
import { resolve } from "path";

import { buildExploreSystemPrompt, buildExploreUserPrompt } from "./explorePrompt";
import { getSuggestion } from "./llmClient";
import { lookupCard } from "./scryfallTool";
import { Spinner } from "./spinner";
import { runRepl } from "./repl";
import { loadAllDrafts, getCurrentCubeCards } from "../build/dataLoader";

/** Default path to the data directory */
const DEFAULT_DATA_DIR = "data";

/**
 * CLI options for the explore command.
 */
type ExploreOptions = {
  devMode: boolean;
  dryRun: boolean;
};

/**
 * Parse command-line arguments.
 */
function parseArgs(args: string[]): ExploreOptions {
  let devMode = false;
  let dryRun = false;

  for (const arg of args) {
    if (arg === "--dev") {
      devMode = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: ./scratch [--dev] [--dry-run]");
      console.log("");
      console.log("Explore historical draft data with an LLM.");
      console.log("");
      console.log("Options:");
      console.log("  --dev       Use cheaper model (gpt-4o-mini) for development");
      console.log("  --dry-run   Print prompts without calling the API");
      process.exit(0);
    }
  }

  return { devMode, dryRun };
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { devMode, dryRun } = options;

  // Check for API key if not in dry-run mode
  if (!dryRun && !process.env.OPENAI_API_KEY) {
    console.error(
      "Error: Set OPENAI_API_KEY environment variable.\n" +
        "Get your API key from https://platform.openai.com/api-keys"
    );
    process.exit(1);
  }

  // Load all draft data
  const dataDir = resolve(DEFAULT_DATA_DIR);
  console.log("Loading draft data...");

  const { picks, draftIds, draftMetadata, matchStats } = await loadAllDrafts(dataDir);

  if (draftIds.length === 0) {
    console.error("Error: No drafts found in data/");
    process.exit(1);
  }

  // Require at least one draft with match data
  if (matchStats.size === 0) {
    console.error("Error: No match data found. At least one draft must have matches.csv");
    process.exit(1);
  }

  // Get current pool
  const currentPool = Array.from(getCurrentCubeCards(dataDir));

  console.log(`Loaded ${draftIds.length} drafts (${matchStats.size} with match data)`);
  console.log(`Pool: ${currentPool.length} cards`);
  console.log();

  // Build prompts
  const systemPrompt = buildExploreSystemPrompt();
  const userPrompt = buildExploreUserPrompt(picks, draftIds, draftMetadata, dataDir, currentPool);

  // Dry-run mode: print prompts and exit
  if (dryRun) {
    console.log("=== SYSTEM PROMPT ===\n");
    console.log(systemPrompt);
    console.log("\n=== USER PROMPT ===\n");
    console.log(userPrompt);
    console.log("\n=== END DRY RUN ===");
    process.exit(0);
  }

  // Determine model
  const requestedModel = devMode ? "gpt-4o-mini" : "gpt-5.2-2025-12-11";

  // Initial prompt to get the conversation started
  const initialQuestion = "What questions can you answer about this draft data?";

  const spinner = new Spinner("Connecting...");
  try {
    spinner.start();
    const result = await getSuggestion(
      systemPrompt,
      userPrompt + "\n\n" + initialQuestion,
      lookupCard,
      { devMode, model: requestedModel }
    );
    spinner.stop();

    console.log(`[model: ${result.model}]`);
    console.log();
    console.log("─".repeat(60));
    console.log();
    console.log(result.text);
    console.log();
    console.log("─".repeat(60));
    console.log();
    console.log("Ask questions about the data, or type 'exit' to quit.");
    console.log();

    // Enter REPL
    await runRepl(result.responseId, { devMode, model: requestedModel });
  } catch (error) {
    spinner.stop();
    const message = (error as Error).message;
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
```

**Step 2: Commit**

```bash
cd /Users/arpanet/code/read-the-bones/src/cli
git add explore.ts
git commit -m "feat: add explore command entry point"
```

---

## Task 4: Create Shell Script and Update Gitignore

**Files:**
- Create: `scratch` (in parent repo root)
- Modify: `.gitignore` (in parent repo root)

**Step 1: Create scratch script**

```bash
#!/usr/bin/env bash
npx tsx src/cli/explore.ts "$@"
```

**Step 2: Make it executable**

```bash
chmod +x /Users/arpanet/code/read-the-bones/scratch
```

**Step 3: Add to .gitignore**

Add `scratch` to the parent repo's `.gitignore` (it's already there based on earlier check, so verify).

**Step 4: Test dry-run**

```bash
cd /Users/arpanet/code/read-the-bones
./scratch --dry-run
```

Expected: System and user prompts print showing all draft data.

**Step 5: Test with API (optional)**

```bash
./scratch --dev
```

Expected: LLM responds with capabilities, REPL accepts follow-up questions.

---

## Task 5: Update Submodule Reference

**Files:**
- Modify: Parent repo's submodule reference

**Step 1: Commit submodule changes in parent repo**

```bash
cd /Users/arpanet/code/read-the-bones
git add src/cli
git commit -m "Update CLI submodule ref with explore command"
```

---

## Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | repl.ts, suggest.ts | Extract shared REPL loop |
| 2 | explorePrompt.ts | Create prompt builder |
| 3 | explore.ts | Create entry point |
| 4 | scratch, .gitignore | Shell script wrapper |
| 5 | (submodule ref) | Update parent repo |
