#!/usr/bin/env node
/**
 * CLI entry point for exploring historical draft data (tool-based).
 *
 * Uses LLM tools to query the Turso database instead of stuffing all data
 * into the prompt. The LLM retrieves what it needs and cites sources.
 *
 * Usage:
 *   ./analyze data           # Production (gpt-5.2)
 *   ./analyze data --dev     # Dev mode (cheaper model)
 *   ./analyze data --dry-run # Show prompt without API call
 */

import { config } from "dotenv";
// Load .env.local (Next.js convention) then .env as fallback
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

import { buildExploreSystemPrompt, buildExploreUserPrompt } from "./explorePrompt";
import { createCliClient, continueConversation, type LlmOptions } from "./llmClient";
import { Spinner } from "./spinner";
import { runRepl } from "./repl";
import { formatMarkdown } from "./formatMarkdown";

/**
 * CLI options for the explore command.
 */
type ExploreOptions = {
  devMode: boolean;
  dryRun: boolean;
};

/**
 * Options for running explore mode.
 * Same as ExploreOptions for API consistency with other modes.
 */
export type ExploreModeOptions = {
  devMode: boolean;
  dryRun: boolean;
  /** Show verbose logging (default: false) */
  verbose?: boolean;
  /** Called after each REPL response with the new response ID */
  onResponse?: (responseId: string) => void;
};

/**
 * Result from running explore mode.
 */
export type ExploreModeResult = {
  /** The last response ID from the session, for conversation continuity */
  responseId: string;
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
      console.log("Usage: ./analyze data [--dev] [--dry-run]");
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
 * Run the explore mode with the given options.
 * This is the core logic extracted from main() for use by analyze.ts.
 *
 * @param options - Explore mode options (devMode, dryRun)
 * @param resumeResponseId - Optional response ID to resume a previous conversation
 * @returns The last response ID from the session
 */
export async function runExploreMode(
  options: ExploreModeOptions,
  resumeResponseId?: string
): Promise<ExploreModeResult> {
  const { devMode, dryRun, verbose = false, onResponse } = options;

  // Determine model
  const requestedModel = devMode ? "gpt-4o-mini" : "gpt-5.2-2025-12-11";

  // Create LLM options
  const llmOptions: LlmOptions = {
    devMode,
    model: requestedModel,
  };

  // If resuming, send a summary request before entering REPL
  if (resumeResponseId) {
    const spinner = new Spinner("Getting summary...");
    try {
      spinner.start();
      const result = await continueConversation(
        "We're resuming this conversation after an interruption. Give me a brief summary of what we've been discussing.",
        resumeResponseId,
        {
          ...llmOptions,
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

  // Check for API key if not in dry-run mode
  if (!dryRun && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "Set OPENAI_API_KEY environment variable.\n" +
        "Get your API key from https://platform.openai.com/api-keys"
    );
  }

  // Build prompts (tool-based, no data stuffing)
  const systemPrompt = buildExploreSystemPrompt();
  const userPrompt = buildExploreUserPrompt();

  if (verbose) {
    console.log("Using tool-based retrieval mode (no data loaded into prompt)");
    console.log();
  }

  // Dry-run mode: print prompts and return placeholder
  if (dryRun) {
    console.log("=== SYSTEM PROMPT ===\n");
    console.log(systemPrompt);
    console.log("\n=== USER PROMPT ===\n");
    console.log(userPrompt);
    console.log("\n=== END DRY RUN ===");
    return { responseId: "dry-run" };
  }

  // Create client and send initial message
  const client = createCliClient({
    ...llmOptions,
    onProgress: (elapsedMs) => {
      // This will be used during the initial connection
    },
  });

  const spinner = new Spinner("Connecting...");
  try {
    spinner.start();
    const result = await client.chat(systemPrompt, userPrompt);
    spinner.stop();

    console.log(`[model: ${result.model}]`);
    console.log();
    console.log("─".repeat(60));
    console.log();
    console.log(formatMarkdown(result.text));
    console.log();
    console.log("─".repeat(60));
    console.log();
    console.log("Ask questions about the data, or type 'exit' to quit.");
    console.log();

    // Notify callback of initial response
    onResponse?.(result.responseId);

    // Enter REPL
    const finalResponseId = await runRepl(result.responseId, { devMode, model: requestedModel, onResponse });
    return { responseId: finalResponseId };
  } catch (error) {
    spinner.stop();
    const message = (error as Error).message;
    throw new Error(`Error connecting: ${message}`);
  }
}

/**
 * Main entry point for the explore command.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  try {
    await runExploreMode(options);
  } catch (error) {
    const message = (error as Error).message;
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
