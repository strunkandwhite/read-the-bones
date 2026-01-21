/**
 * LLM client for CLI - thin wrapper around src/core/llm/client.ts.
 *
 * Provides backward-compatible exports for existing CLI code while
 * delegating to the core LLM client with database tools.
 */

import {
  createLLMClient,
  type LLMClient,
  type LLMClientOptions,
  type ChatResult,
  type ModelId,
} from "../core/llm/client";

// Re-export core types
export type { LLMClient, LLMClientOptions, ChatResult, ModelId };
export { createLLMClient };

/**
 * Options for LLM requests (backward compatibility).
 */
export type LlmOptions = {
  /** Use cheaper/faster model for development and testing */
  devMode: boolean;
  /** Model ID to use */
  model: string;
  /** Optional callback for progress updates during polling (receives elapsed ms) */
  onProgress?: (elapsedMs: number) => void;
};

/**
 * Result from the LLM request (backward compatibility).
 */
export type SuggestionResult = ChatResult;

/**
 * Create an LLM client configured for CLI use.
 *
 * @param options - LLM options
 * @returns Configured LLM client
 */
export function createCliClient(options: LlmOptions): LLMClient {
  return createLLMClient({
    model: options.model as ModelId,
    onProgress: options.onProgress,
  });
}

/**
 * Get a response from the LLM (backward compatible wrapper).
 *
 * @param systemPrompt - Instructions for the assistant's role and context
 * @param userPrompt - User message with the current draft state and question
 * @param options - LLM configuration options
 * @returns Object with the model's text response and actual model used
 */
export async function getSuggestion(
  systemPrompt: string,
  userPrompt: string,
  options: LlmOptions
): Promise<SuggestionResult> {
  const client = createCliClient(options);
  return client.chat(systemPrompt, userPrompt);
}

/**
 * Continue an existing conversation with a follow-up message.
 *
 * @param userMessage - The user's follow-up message
 * @param previousResponseId - Response ID from the previous turn
 * @param options - LLM configuration options
 * @returns Object with the model's text response, model used, and new response ID
 */
export async function continueConversation(
  userMessage: string,
  previousResponseId: string,
  options: LlmOptions
): Promise<SuggestionResult> {
  const client = createCliClient(options);
  return client.continueChat(userMessage, previousResponseId);
}

/**
 * Generate a short title for a conversation.
 *
 * @param previousResponseId - The last response ID from the conversation
 * @returns A short title string
 */
export async function generateTitle(previousResponseId: string): Promise<string> {
  // Create a minimal client just for title generation
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "Untitled";
  }

  try {
    const client = createLLMClient({
      model: "gpt-4o-mini",
    });
    return client.generateTitle(previousResponseId);
  } catch {
    return "Untitled";
  }
}
