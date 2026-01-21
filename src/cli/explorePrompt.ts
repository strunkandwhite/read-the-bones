/**
 * Prompt builder for the explore command (tool-based retrieval).
 *
 * Instead of stuffing all draft data into prompts, we now instruct the LLM
 * to use database tools to query for specific information, with citation requirements.
 */

import { DRAFT_ANALYST_PROMPT } from "../core/llm";

/**
 * Build the system prompt for tool-based exploration mode.
 *
 * This prompt instructs the LLM to:
 * 1. Use tools to query the database before making claims
 * 2. Cite sources in a specific format
 * 3. Never hallucinate or infer data not returned by tools
 */
export function buildExploreSystemPrompt(): string {
  return DRAFT_ANALYST_PROMPT;
}

/**
 * Build the initial user prompt for tool-based exploration.
 *
 * Since we're not stuffing data into prompts anymore, this just
 * provides initial context and asks the model to acknowledge readiness.
 */
export function buildExploreUserPrompt(): string {
  return `The draft database is ready. You have access to tools to query historical draft data.

Before we begin, please:
1. Call list_drafts to see what drafts are available
2. Acknowledge you're ready to answer questions about draft history

Keep your initial response brief (2-3 sentences max).`;
}
