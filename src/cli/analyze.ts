#!/usr/bin/env node
/**
 * Unified CLI entry point for MTG draft analysis.
 *
 * Usage:
 *   ./analyze data              # Explore mode - historical data chat
 *   ./analyze draft             # Draft mode - active draft advice (looks for data/draft/)
 *   ./analyze --resume          # Show conversation picker menu
 *
 * Flags:
 *   --dev       Use cheaper model for development
 *   --dry-run   Print prompts without API call
 *   --verbose   Show data loading progress
 */

import { config } from "dotenv";
// Load .env.local (Next.js convention) then .env as fallback
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
import * as readline from "readline";
import { resolve } from "path";

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

/** Default draft folder path */
const DEFAULT_DRAFT_PATH = "data/draft";

/**
 * Parsed command-line arguments.
 */
type ParsedArgs = {
  mode: "explore" | "draft" | "resume";
  draftPath: string;
  devMode: boolean;
  dryRun: boolean;
  verbose: boolean;
};

/**
 * Format a timestamp as relative time (e.g., "2 hours ago", "yesterday").
 */
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays === 1) return "yesterday";
  return `${diffDays} days ago`;
}

/**
 * Parse command-line arguments.
 */
function parseArgs(args: string[]): ParsedArgs {
  let mode: "explore" | "draft" | "resume" | null = null;
  let draftPath = DEFAULT_DRAFT_PATH;
  let devMode = false;
  let dryRun = false;
  let verbose = false;

  for (const arg of args) {
    if (arg === "--resume") {
      mode = "resume";
    } else if (arg === "--dev") {
      devMode = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: ./analyze <mode> [options]");
      console.log("");
      console.log("Modes:");
      console.log("  data              Explore historical draft data");
      console.log("  draft             Get advice for active draft (uses data/draft/)");
      console.log("  --resume          Resume a previous conversation");
      console.log("");
      console.log("Options:");
      console.log("  --dev             Use cheaper model (gpt-4o-mini) for development");
      console.log("  --dry-run         Print prompts without calling the API");
      console.log("  --verbose, -v     Show data loading progress");
      console.log("  --help, -h        Show this help message");
      process.exit(0);
    } else if (arg === "data") {
      mode = "explore";
    } else if (arg === "draft") {
      mode = "draft";
    } else if (!arg.startsWith("-")) {
      // Unknown positional argument - treat as draft path for draft mode
      draftPath = arg;
    }
  }

  if (!mode) {
    console.error("Error: No mode specified. Use 'data', 'draft', or '--resume'.");
    console.error("Run './analyze --help' for usage information.");
    process.exit(1);
  }

  return {
    mode,
    draftPath: resolve(draftPath),
    devMode,
    dryRun,
    verbose,
  };
}

/**
 * Get a single line of input from the user.
 */
function getInput(prompt: string): Promise<string | null> {
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

    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Show the resume picker menu and let the user select a conversation.
 */
async function showResumePicker(store: ConversationStore): Promise<Conversation | null> {
  const conversations = listConversations(store);

  if (conversations.length === 0) {
    console.log("No previous conversations found.");
    return null;
  }

  console.log();
  console.log("Recent conversations:");
  console.log();

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const modeLabel = `[${conv.mode}]`;
    const title = conv.title || "Untitled";
    const time = formatRelativeTime(conv.updatedAt);
    console.log(`${i + 1}. ${modeLabel} ${title}  (${time})`);
  }

  console.log();
  const input = await getInput("Enter number to resume, or 'q' to cancel: ");

  if (input === null || input.trim().toLowerCase() === "q") {
    return null;
  }

  const num = parseInt(input.trim(), 10);
  if (isNaN(num) || num < 1 || num > conversations.length) {
    console.log("Invalid selection.");
    return null;
  }

  return conversations[num - 1];
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const conversationsPath = resolve(DEFAULT_CONVERSATIONS_PATH);

  // Resume mode: show picker and resume selected conversation
  if (args.mode === "resume") {
    const store = loadConversations(conversationsPath);
    const selected = await showResumePicker(store);

    if (!selected) {
      return;
    }

    const resumeResponseId = getLatestResponseId(selected);
    console.log(`Resuming "${selected.title}"...`);

    // Create callback to update conversation after each response
    const onResponse = (responseId: string) => {
      const updated = addResponseId(selected, responseId);
      // Find and replace the conversation in the store
      const index = store.conversations.findIndex((c) => c.id === selected.id);
      if (index !== -1) {
        store.conversations[index] = updated;
        // Update selected reference for next call
        Object.assign(selected, updated);
      }
      saveConversations(store, conversationsPath);
    };

    try {
      let finalResponseId: string;

      if (selected.mode === "explore") {
        const result = await runExploreMode(
          { devMode: args.devMode, dryRun: args.dryRun, verbose: args.verbose, onResponse },
          resumeResponseId
        );
        finalResponseId = result.responseId;
      } else {
        const result = await runSuggestMode(
          {
            draftPath: selected.draftPath || args.draftPath,
            devMode: args.devMode,
            dryRun: args.dryRun,
            verbose: args.verbose,
            onResponse,
          },
          resumeResponseId
        );
        finalResponseId = result.responseId;
      }

      // Always regenerate title on exit (conversation may have evolved)
      if (!args.dryRun && finalResponseId !== "dry-run") {
        console.log("Updating conversation title...");
        const title = await generateTitle(finalResponseId);
        selected.title = title;
        const index = store.conversations.findIndex((c) => c.id === selected.id);
        if (index !== -1) {
          store.conversations[index] = selected;
        }
        saveConversations(store, conversationsPath);
      }
    } catch (error) {
      const message = (error as Error).message;
      console.error(`Error: ${message}`);
      process.exit(1);
    }
    return;
  }

  // Explore mode: historical data chat
  if (args.mode === "explore") {
    // Skip conversation tracking for dry-run
    if (args.dryRun) {
      try {
        await runExploreMode({ devMode: args.devMode, dryRun: true, verbose: args.verbose });
      } catch (error) {
        const message = (error as Error).message;
        console.error(`Error: ${message}`);
        process.exit(1);
      }
      return;
    }

    const store = loadConversations(conversationsPath);
    let conversation: Conversation | null = null;

    // Callback to create/update conversation after each response
    const onResponse = (responseId: string) => {
      if (!conversation) {
        // First response - create the conversation
        conversation = createConversation("explore", responseId);
        store.conversations.push(conversation);
      } else {
        // Subsequent responses - update the conversation
        conversation = addResponseId(conversation, responseId);
        const index = store.conversations.findIndex((c) => c.id === conversation!.id);
        if (index !== -1) {
          store.conversations[index] = conversation;
        }
      }
      saveConversations(store, conversationsPath);
    };

    try {
      const result = await runExploreMode({
        devMode: args.devMode,
        dryRun: false,
        verbose: args.verbose,
        onResponse,
      });

      // Generate title on exit
      if (conversation) {
        console.log("Generating conversation title...");
        const title = await generateTitle(result.responseId);
        conversation.title = title;
        const index = store.conversations.findIndex((c) => c.id === conversation!.id);
        if (index !== -1) {
          store.conversations[index] = conversation;
        }
        saveConversations(store, conversationsPath);
      }
    } catch (error) {
      const message = (error as Error).message;
      console.error(`Error: ${message}`);
      process.exit(1);
    }
    return;
  }

  // Draft mode: active draft advice
  if (args.mode === "draft") {
    // Skip conversation tracking for dry-run
    if (args.dryRun) {
      try {
        await runSuggestMode({
          draftPath: args.draftPath,
          devMode: args.devMode,
          dryRun: true,
          verbose: args.verbose,
        });
      } catch (error) {
        const message = (error as Error).message;
        console.error(`Error: ${message}`);
        process.exit(1);
      }
      return;
    }

    const store = loadConversations(conversationsPath);
    let conversation: Conversation | null = null;

    // Callback to create/update conversation after each response
    const onResponse = (responseId: string) => {
      if (!conversation) {
        // First response - create the conversation
        conversation = createConversation("draft", responseId, args.draftPath);
        store.conversations.push(conversation);
      } else {
        // Subsequent responses - update the conversation
        conversation = addResponseId(conversation, responseId);
        const index = store.conversations.findIndex((c) => c.id === conversation!.id);
        if (index !== -1) {
          store.conversations[index] = conversation;
        }
      }
      saveConversations(store, conversationsPath);
    };

    try {
      const result = await runSuggestMode({
        draftPath: args.draftPath,
        devMode: args.devMode,
        dryRun: false,
        verbose: args.verbose,
        onResponse,
      });

      // Generate title on exit
      if (conversation) {
        console.log("Generating conversation title...");
        const title = await generateTitle(result.responseId);
        conversation.title = title;
        const index = store.conversations.findIndex((c) => c.id === conversation!.id);
        if (index !== -1) {
          store.conversations[index] = conversation;
        }
        saveConversations(store, conversationsPath);
      }
    } catch (error) {
      const message = (error as Error).message;
      // Handle "draft complete" as non-error
      if (message === "Draft is complete. No picks remaining.") {
        console.log(message);
        process.exit(0);
      }
      console.error(`Error: ${message}`);
      process.exit(1);
    }
    return;
  }
}

// Run main
main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
