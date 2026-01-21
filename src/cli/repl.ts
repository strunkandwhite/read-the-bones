/**
 * Shared REPL loop for CLI tools.
 */

import * as readline from "readline";
import { createCliClient, type LlmOptions } from "./llmClient";
import { Spinner } from "./spinner";
import { formatMarkdown } from "./formatMarkdown";

/**
 * Options for the REPL loop.
 */
export type ReplOptions = {
  devMode: boolean;
  model: string;
  /** Called after each response with the new response ID */
  onResponse?: (responseId: string) => void;
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
 * @returns The final response ID from the session
 */
export async function runRepl(responseId: string, options: ReplOptions): Promise<string> {
  let currentResponseId = responseId;

  // Create client options
  const llmOptions: LlmOptions = {
    devMode: options.devMode,
    model: options.model,
  };

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

    console.log();
    const spinner = new Spinner("Thinking...");
    try {
      spinner.start();

      // Create a new client for each continuation to get fresh progress callback
      const client = createCliClient({
        ...llmOptions,
        onProgress: (elapsedMs) => {
          const secs = Math.floor(elapsedMs / 1000);
          spinner.updateMessage(`Thinking... (${secs}s)`);
        },
      });

      const result = await client.continueChat(trimmed, currentResponseId);
      spinner.stop();

      console.log();
      console.log("─".repeat(60));
      console.log();
      console.log(formatMarkdown(result.text));
      console.log();

      currentResponseId = result.responseId;
      options.onResponse?.(currentResponseId);
    } catch (error) {
      spinner.stop();
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      console.log();
    }
  }

  return currentResponseId;
}
