#!/usr/bin/env node
/**
 * CLI entry point for draft pick suggestions.
 *
 * Usage:
 *   pnpm suggest ./data/current-draft          # Production (gpt-5)
 *   pnpm suggest ./data/current-draft --dev    # Dev mode (cheaper model)
 *   pnpm suggest ./data/current-draft --dry-run # Show prompt without API call
 */

import { config } from "dotenv";
// Load .env.local (Next.js convention) then .env as fallback
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { parseDraftState, inferDrafterColors } from "./draftState";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder";
import { getSuggestion, continueConversation } from "./llmClient";
import { Spinner } from "./spinner";
import { runRepl } from "./repl";
import { formatMarkdown } from "./formatMarkdown";
import { loadAllDraftsFromTurso } from "../build/tursoDataLoader";
import { calculateCardStats } from "../core/calculateStats";
import { loadCache } from "../build/scryfall";
import { buildCardDictionary, buildPoolCounts } from "./cardCodes";
import { parsePool } from "../core/parseCsv";
import type { SuggestOptions } from "./types";

/**
 * Options for running suggest mode.
 * Extends SuggestOptions with callback for conversation tracking.
 */
export type SuggestModeOptions = SuggestOptions & {
  /** Called after each REPL response with the new response ID */
  onResponse?: (responseId: string) => void;
};

/**
 * Result from running suggest mode.
 */
export type SuggestModeResult = {
  /** The last response ID from the session, for conversation continuity */
  responseId: string;
};

/** Default path to the Scryfall cache */
const DEFAULT_CACHE_PATH = "cache/scryfall.json";

/**
 * Parse command-line arguments into SuggestOptions.
 *
 * @param args - process.argv slice (excluding node and script path)
 * @returns Parsed options
 * @throws Error if required arguments are missing
 */
function parseArgs(args: string[]): SuggestOptions {
  let draftPath = "";
  let devMode = false;
  let dryRun = false;
  let verbose = false;

  for (const arg of args) {
    if (arg === "--dev") {
      devMode = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (!arg.startsWith("-")) {
      draftPath = arg;
    }
  }

  if (!draftPath) {
    throw new Error(
      "Usage: pnpm suggest <draft-folder> [--dev] [--dry-run] [--verbose]\n\n" +
        "Arguments:\n" +
        "  draft-folder  Path to the draft folder (must contain picks.csv and pool.csv)\n\n" +
        "Options:\n" +
        "  --dev       Use cheaper model (gpt-4o-mini) for development\n" +
        "  --dry-run   Print prompts without calling the API\n" +
        "  --verbose   Show data loading progress"
    );
  }

  return {
    draftPath: resolve(draftPath),
    devMode,
    dryRun,
    verbose,
  };
}

/**
 * Print the output header with pick information.
 *
 * @param userPickNumber - User's pick number (how many picks user has made + 1)
 * @param overallPickNumber - The overall pick number in the draft
 * @param picksUntilUser - Number of picks until user's turn
 */
function printHeader(
  userPickNumber: number,
  overallPickNumber: number,
  picksUntilUser: number
): void {
  const line = "═".repeat(60);

  let urgencyNote = "";
  if (picksUntilUser === 0) {
    urgencyNote = " - your turn!";
  } else if (picksUntilUser === 1) {
    urgencyNote = " - 1 pick away";
  } else if (picksUntilUser <= 3) {
    urgencyNote = ` - ${picksUntilUser} picks away`;
  }

  console.log();
  console.log(line);
  console.log(` Your pick #${userPickNumber} (${overallPickNumber} overall)${urgencyNote}`);
  console.log(line);
  console.log();
}

/**
 * Run the suggest mode with the given options.
 * This is the core logic extracted from main() for use by analyze.ts.
 *
 * @param options - Suggest mode options (draftPath, devMode, dryRun, verbose)
 * @param resumeResponseId - Optional response ID to resume a previous conversation
 * @returns The last response ID from the session
 */
export async function runSuggestMode(
  options: SuggestModeOptions,
  resumeResponseId?: string
): Promise<SuggestModeResult> {
  const { draftPath, devMode, dryRun, verbose, onResponse } = options;

  // Check draft folder exists
  if (!existsSync(draftPath)) {
    throw new Error(`Draft folder not found: ${draftPath}`);
  }

  // Check for required files
  const picksPath = join(draftPath, "picks.csv");
  const poolPath = join(draftPath, "pool.csv");

  if (!existsSync(picksPath)) {
    throw new Error(`Missing picks.csv in ${draftPath}`);
  }

  if (!existsSync(poolPath)) {
    throw new Error(`Missing pool.csv in ${draftPath}`);
  }

  // Check for API key if not in dry-run mode and not resuming
  if (!dryRun && !resumeResponseId && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "Set OPENAI_API_KEY environment variable.\n" +
        "Get your API key from https://platform.openai.com/api-keys"
    );
  }

  // Read draft CSV files
  const picksCsvContent = readFileSync(picksPath, "utf-8");
  const poolCsvContent = readFileSync(poolPath, "utf-8");

  // Parse draft state
  let draftState;
  try {
    draftState = parseDraftState(picksCsvContent, poolCsvContent);
  } catch (error) {
    const message = (error as Error).message;
    // Check for user not found error and provide helpful message
    if (message.includes("not found in drafter list")) {
      throw new Error(
        `${message}\n\nMake sure the picks.csv has your drafter name in row 3.`
      );
    }
    throw new Error(`Error parsing draft: ${message}`);
  }

  // Check if draft is complete (only if not resuming)
  if (!resumeResponseId && draftState.availableCards.length === 0) {
    throw new Error("Draft is complete. No picks remaining.");
  }

  // Determine model to request
  const requestedModel = devMode ? "gpt-4o-mini" : "gpt-5.2-2025-12-11";

  // If resuming, send a summary request before entering REPL
  if (resumeResponseId) {

    const spinner = new Spinner("Getting summary...");
    try {
      spinner.start();
      const result = await continueConversation(
        "We're resuming this conversation after an interruption. Give me a brief summary of what we've been discussing.",
        resumeResponseId,
        {
          devMode,
          model: requestedModel,
          onProgress: (elapsedMs) => {
            const secs = Math.floor(elapsedMs / 1000);
            spinner.updateMessage(`Getting summary... (${secs}s)`);
          },
        }
      );
      spinner.stop();

      // Call onResponse with the new response ID
      onResponse?.(result.responseId);

      console.log("─".repeat(60));
      console.log();
      console.log(formatMarkdown(result.text));
      console.log();
      console.log("─".repeat(60));
      console.log();
      console.log("Ask follow-up questions, or type 'exit' to quit.");
      console.log();

      const finalResponseId = await runRepl(result.responseId, { devMode, model: requestedModel, onResponse });
      return { responseId: finalResponseId };
    } catch (error) {
      spinner.stop();
      throw error;
    }
  }

  // Load historical data from all drafts (from Turso database)
  const { picks: historicalPicks } = await loadAllDraftsFromTurso(undefined, {
    quiet: !verbose,
  });
  const historicalStats = calculateCardStats(historicalPicks);

  // Load Scryfall cache
  const cachePath = resolve(DEFAULT_CACHE_PATH);
  const scryfallCache = loadCache(cachePath);

  // Infer colors for each drafter
  const drafterColors = new Map<string, string[]>();
  for (const drafter of draftState.drafters) {
    const picks = draftState.allPicks.get(drafter) ?? [];
    const colors = inferDrafterColors(picks, scryfallCache);
    drafterColors.set(drafter, colors);
  }

  // Build card dictionary for prompt compression
  // Collect all cards: available + all picked
  const allCards = [
    ...draftState.availableCards,
    ...Array.from(draftState.allPicks.values()).flat(),
  ];
  const cardDict = buildCardDictionary(allCards);

  // Build pool counts from raw pool CSV (for tracking duplicates)
  const rawPool = parsePool(poolCsvContent);
  const poolCounts = buildPoolCounts(rawPool);

  // Build prompts
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(
    draftState,
    historicalStats,
    drafterColors,
    scryfallCache,
    cardDict,
    poolCounts
  );

  // If dry-run, print prompts and return placeholder
  if (dryRun) {
    console.log("=== SYSTEM PROMPT ===\n");
    console.log(systemPrompt);
    console.log("\n=== USER PROMPT ===\n");
    console.log(userPrompt);
    console.log("\n=== END DRY RUN ===");
    return { responseId: "dry-run" };
  }

  // Print header
  const overallPickNumber = draftState.currentPickNumber + draftState.picksUntilUser;
  printHeader(draftState.userPicks.length + 1, overallPickNumber, draftState.picksUntilUser);

  // Get suggestion from LLM
  const spinner = new Spinner("Thinking...");
  try {
    spinner.start();
    const result = await getSuggestion(systemPrompt, userPrompt, {
      devMode,
      model: requestedModel,
      onProgress: (elapsedMs) => {
        const secs = Math.floor(elapsedMs / 1000);
        spinner.updateMessage(`Thinking... (${secs}s)`);
      },
    });
    spinner.stop();

    console.log(`[model: ${result.model}]`);
    console.log();
    console.log("─".repeat(60));
    console.log();
    console.log(formatMarkdown(result.text));
    console.log();
    console.log("─".repeat(60));
    console.log();
    console.log("Ask follow-up questions, or type 'exit' to quit.");
    console.log();

    // Notify callback of initial response
    onResponse?.(result.responseId);

    // Enter interactive REPL
    const finalResponseId = await runRepl(result.responseId, { devMode, model: requestedModel, onResponse });
    return { responseId: finalResponseId };
  } catch (error) {
    spinner.stop();
    const message = (error as Error).message;
    throw new Error(`Error getting suggestion: ${message}`);
  }
}

/**
 * Main entry point for the suggest command.
 */
async function main(): Promise<void> {
  // Parse command-line arguments
  let options: SuggestOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  try {
    await runSuggestMode(options);
  } catch (error) {
    const message = (error as Error).message;
    // Handle "draft complete" as a non-error exit
    if (message === "Draft is complete. No picks remaining.") {
      console.log(message);
      process.exit(0);
    }
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

// Run main only when this file is the entry point
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
  });
}
