/**
 * LLM integration layer for draft analysis.
 *
 * This module provides:
 * - Tool definitions for OpenAI function calling
 * - Tool executor that routes to database queries
 * - LLM client wrapper with automatic tool handling
 *
 * @example
 * ```typescript
 * import { createLLMClient, tools } from "@/core/llm";
 *
 * const client = createLLMClient({ model: "gpt-4o-mini" });
 * const result = await client.chat(
 *   "You are an MTG draft analyst.",
 *   "What drafts has Seat 3 participated in?"
 * );
 * console.log(result.text);
 * ```
 */

// Tool definitions
export { tools, isValidToolName, type ToolName } from "./tools";

// Tool executor
export { executeTool, executeToolForLLM, type ToolResult } from "./toolExecutor";

// LLM client
export {
  createLLMClient,
  type LLMClient,
  type LLMClientOptions,
  type ModelId,
  type ChatResult,
} from "./client";

// Prompts
export { DRAFT_ANALYST_PROMPT } from "./prompts";
