/**
 * Tool executor that routes tool calls to database query functions.
 *
 * This module provides the bridge between LLM tool calls and the
 * actual database queries defined in src/core/db/queries.ts.
 */

import * as queries from "../db/queries";
import { isValidToolName, type ToolName } from "./tools";

/**
 * Result of executing a tool - either success with data or error.
 */
export type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

/**
 * Execute a tool by name with the given arguments.
 *
 * @param name - The tool name to execute
 * @param args - Arguments parsed from the LLM's function call
 * @returns Result object with success/data or error
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (!isValidToolName(name)) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  try {
    const data = await executeToolImpl(name, args);
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: message };
  }
}

/**
 * Internal implementation that routes to the appropriate query function.
 */
async function executeToolImpl(
  name: ToolName,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "list_drafts":
      return queries.listDrafts({
        date_from: args.date_from as string | undefined,
        date_to: args.date_to as string | undefined,
        draft_name: args.draft_name as string | undefined,
      });

    case "get_draft": {
      const draftId = args.draft_id as string;
      if (!draftId) {
        throw new Error("draft_id is required");
      }
      const result = await queries.getDraft(draftId);
      if (!result) {
        throw new Error(`Draft not found: ${draftId}`);
      }
      return result;
    }

    case "get_picks": {
      const draftId = args.draft_id as string;
      if (!draftId) {
        throw new Error("draft_id is required");
      }
      return queries.getPicks({
        draft_id: draftId,
        seat: args.seat as number | undefined,
        pick_n_min: args.pick_n_min as number | undefined,
        pick_n_max: args.pick_n_max as number | undefined,
        card_name: args.card_name as string | undefined,
      });
    }

    case "get_available_cards": {
      const draftId = args.draft_id as string;
      const beforePickN = args.before_pick_n as number;
      if (!draftId) {
        throw new Error("draft_id is required");
      }
      if (beforePickN === undefined) {
        throw new Error("before_pick_n is required");
      }
      return queries.getAvailableCards({
        draft_id: draftId,
        before_pick_n: beforePickN,
        color: args.color as string | undefined,
        type_contains: args.type_contains as string | undefined,
      });
    }

    case "get_standings": {
      const draftId = args.draft_id as string;
      if (!draftId) {
        throw new Error("draft_id is required");
      }
      return queries.getStandings(draftId);
    }

    case "get_card_pick_stats": {
      const cardName = args.card_name as string;
      if (!cardName) {
        throw new Error("card_name is required");
      }
      const result = await queries.getCardPickStats({
        card_name: cardName,
        date_from: args.date_from as string | undefined,
        date_to: args.date_to as string | undefined,
        draft_name: args.draft_name as string | undefined,
      });
      if (!result) {
        throw new Error(`Card not found: ${cardName}`);
      }
      return result;
    }

    case "lookup_card": {
      const cardName = args.card_name as string;
      if (!cardName) {
        throw new Error("card_name is required");
      }
      const result = await queries.lookupCard(cardName);
      if (!result) {
        throw new Error(`Card not found: ${cardName}`);
      }
      return result;
    }

    case "get_draft_pool": {
      let draftId = args.draft_id as string | undefined;
      if (!draftId) {
        // Get the most recent draft
        const drafts = await queries.listDrafts();
        if (drafts.length === 0) {
          throw new Error("No drafts found in database");
        }
        draftId = drafts[0].draft_id;
      }
      const result = await queries.getDraftPool({
        draft_id: draftId,
        include_draft_results: args.include_draft_results as boolean | undefined,
        include_card_details: args.include_card_details as boolean | undefined,
        group_by: args.group_by as "none" | "color_identity" | "type" | undefined,
        color: args.color as string | undefined,
        type_contains: args.type_contains as string | undefined,
        name_contains: args.name_contains as string | undefined,
      });
      if (!result) {
        throw new Error(`Draft not found: ${draftId}`);
      }
      return result;
    }
  }
}

/**
 * Execute a tool and return the result as a JSON string.
 * This is the format expected by the OpenAI function call output.
 *
 * @param name - The tool name to execute
 * @param argsJson - JSON string of arguments from the LLM
 * @returns JSON string result for the function call output
 */
export async function executeToolForLLM(
  name: string,
  argsJson: string
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ error: "Invalid JSON arguments" });
  }

  const result = await executeTool(name, args);

  if (result.success) {
    return JSON.stringify(result.data);
  } else {
    return JSON.stringify({ error: result.error });
  }
}
