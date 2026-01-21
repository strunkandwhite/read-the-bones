/**
 * OpenAI LLM client wrapper with tool handling.
 *
 * Uses the OpenAI Responses API (recommended for GPT-5.x) with:
 * - Automatic tool call handling loop
 * - Background mode for GPT-5 (long reasoning times)
 * - Conversation continuity via response IDs
 */

import OpenAI from "openai";
import { tools } from "./tools";
import { executeToolForLLM } from "./toolExecutor";

/**
 * Supported model identifiers.
 */
export type ModelId = "gpt-5.2-2025-12-11" | "gpt-4o-mini";

/**
 * Options for creating an LLM client.
 */
export interface LLMClientOptions {
  /** Model to use for completions */
  model: ModelId;
  /** Use background mode for long-running requests (default: true for GPT-5) */
  useBackgroundMode?: boolean;
  /** Callback for progress updates during polling (receives elapsed ms) */
  onProgress?: (elapsedMs: number) => void;
}

/**
 * Result from a chat completion.
 */
export interface ChatResult {
  /** The model's text response */
  text: string;
  /** The actual model ID used (from API response) */
  model: string;
  /** Response ID for continuing the conversation */
  responseId: string;
}

/** Polling interval for background mode (2 seconds) */
const POLL_INTERVAL_MS = 2000;

/** Maximum time to wait for a background response (10 minutes) */
const MAX_POLL_DURATION_MS = 10 * 60 * 1000;

/**
 * Sleep utility for polling.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an LLM client with the specified options.
 *
 * @param options - Client configuration
 * @returns Object with chat method
 * @throws Error if OPENAI_API_KEY is not set
 */
export function createLLMClient(options: LLMClientOptions) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is not set. " +
        "Get your API key from https://platform.openai.com/api-keys and set it with: " +
        "export OPENAI_API_KEY='your-key-here'"
    );
  }

  const client = new OpenAI({ apiKey });
  const { model, onProgress } = options;
  const isGpt5 = model.startsWith("gpt-5");
  const useBackground = options.useBackgroundMode ?? isGpt5;

  /**
   * Send a chat message and get a response.
   * Handles tool calls automatically in a loop until the model returns text.
   *
   * @param systemPrompt - Instructions for the assistant's role and context
   * @param userMessage - User message to send
   * @param previousResponseId - Optional response ID to continue a conversation
   * @returns Chat result with text, model, and response ID
   */
  async function chat(
    systemPrompt: string,
    userMessage: string,
    previousResponseId?: string
  ): Promise<ChatResult> {
    // Create the initial request
    const initialResponse = await client.responses.create({
      model,
      ...(previousResponseId
        ? { previous_response_id: previousResponseId }
        : { instructions: systemPrompt }),
      input: userMessage,
      tools,
      tool_choice: "auto",
      ...(isGpt5 && {
        reasoning: { effort: "high" },
      }),
      ...(useBackground && {
        background: true,
      }),
    });

    // Poll until complete if using background mode
    const response = useBackground
      ? await pollUntilComplete(client, initialResponse.id, onProgress)
      : initialResponse;

    // Process the response loop (handles tool calls)
    return processResponseLoop(
      client,
      response,
      model,
      useBackground,
      isGpt5,
      previousResponseId ? undefined : systemPrompt,
      onProgress
    );
  }

  /**
   * Continue an existing conversation with a follow-up message.
   *
   * @param userMessage - User message to send
   * @param previousResponseId - Response ID from the previous turn
   * @param instructions - System instructions (re-sent to ensure persistence)
   * @returns Chat result with text, model, and response ID
   */
  async function continueChat(
    userMessage: string,
    previousResponseId: string,
    instructions?: string
  ): Promise<ChatResult> {
    const initialResponse = await client.responses.create({
      model,
      input: userMessage,
      tools,
      tool_choice: "auto",
      previous_response_id: previousResponseId,
      ...(instructions && { instructions }),
      ...(isGpt5 && {
        reasoning: { effort: "high" },
      }),
      ...(useBackground && {
        background: true,
      }),
    });

    // Poll until complete if using background mode
    const response = useBackground
      ? await pollUntilComplete(client, initialResponse.id, onProgress)
      : initialResponse;

    // Process the response loop (handles tool calls)
    return processResponseLoop(
      client,
      response,
      model,
      useBackground,
      isGpt5,
      undefined,
      onProgress
    );
  }

  /**
   * Generate a short title for a conversation.
   *
   * @param previousResponseId - The last response ID from the conversation
   * @returns A short title string
   */
  async function generateTitle(previousResponseId: string): Promise<string> {
    try {
      const response = await client.responses.create({
        model: "gpt-4o-mini", // Use fast model for title generation
        input:
          "Generate a specific, descriptive title (5 words or less) for this conversation. " +
          "Focus on the concrete topic discussed (e.g., seat numbers, card names, specific stats). " +
          "Avoid generic titles like 'MTG Draft Analysis' or 'Card Discussion'. " +
          "Reply with just the title, no quotes or punctuation.",
        previous_response_id: previousResponseId,
      });

      const text = response.output_text?.trim();
      return text || "Untitled";
    } catch {
      return "Untitled";
    }
  }

  return {
    chat,
    continueChat,
    generateTitle,
  };
}

/**
 * Poll a background response until it reaches a terminal state.
 */
async function pollUntilComplete(
  client: OpenAI,
  responseId: string,
  onProgress?: (elapsedMs: number) => void
): Promise<OpenAI.Responses.Response> {
  const startTime = Date.now();
  let response = await client.responses.retrieve(responseId);

  while (response.status === "queued" || response.status === "in_progress") {
    await sleep(POLL_INTERVAL_MS);
    const elapsed = Date.now() - startTime;

    if (elapsed > MAX_POLL_DURATION_MS) {
      throw new Error(
        `Response polling timed out after ${Math.floor(elapsed / 1000)}s. ` +
          `Response ID: ${responseId}`
      );
    }

    onProgress?.(elapsed);
    response = await client.responses.retrieve(responseId);
  }

  if (response.status === "failed") {
    const error = (response as { error?: { message?: string } }).error;
    throw new Error(`Response failed: ${error?.message || "Unknown error"}`);
  }

  return response;
}

/**
 * Process the response loop - handles function calls until final text output.
 */
async function processResponseLoop(
  client: OpenAI,
  initialResponse: OpenAI.Responses.Response,
  model: ModelId,
  useBackground: boolean,
  isGpt5: boolean,
  instructions?: string,
  onProgress?: (elapsedMs: number) => void
): Promise<ChatResult> {
  const MAX_TOOL_ITERATIONS = 50;
  let currentResponse = initialResponse;
  let iteration = 0;

  while (iteration++ < MAX_TOOL_ITERATIONS) {
    const actualModel = currentResponse.model;

    // Check for final text output in message
    const textOutput = currentResponse.output.find((item) => item.type === "message");

    if (textOutput && textOutput.type === "message") {
      const textContent = textOutput.content.find((c) => c.type === "output_text");
      if (textContent && textContent.type === "output_text") {
        return { text: textContent.text, model: actualModel, responseId: currentResponse.id };
      }
    }

    // Check for function calls
    const functionCalls = currentResponse.output.filter(
      (item) => item.type === "function_call"
    );

    if (functionCalls.length === 0) {
      // No function calls - check output_text directly
      if (currentResponse.output_text) {
        return {
          text: currentResponse.output_text,
          model: actualModel,
          responseId: currentResponse.id,
        };
      }
      throw new Error("No output from OpenAI Responses API");
    }

    // Process function calls and gather results
    const toolResults: OpenAI.Responses.ResponseInputItem[] = [];

    for (const call of functionCalls) {
      if (call.type !== "function_call") continue;

      const result = await executeToolForLLM(call.name, call.arguments);
      toolResults.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: result,
      });
    }

    // Continue with tool results
    const loopResponse = await client.responses.create({
      model,
      ...(instructions && { instructions }),
      input: toolResults,
      tools,
      tool_choice: "auto",
      previous_response_id: currentResponse.id,
      ...(isGpt5 && {
        reasoning: { effort: "high" },
      }),
      ...(useBackground && {
        background: true,
      }),
    });

    // Poll until complete if using background mode
    currentResponse = useBackground
      ? await pollUntilComplete(client, loopResponse.id, onProgress)
      : loopResponse;
  }

  // If we get here, we exceeded the max iterations
  throw new Error(
    `Tool calling loop exceeded ${MAX_TOOL_ITERATIONS} iterations`
  );
}

/**
 * Type for the LLM client returned by createLLMClient.
 */
export type LLMClient = ReturnType<typeof createLLMClient>;
