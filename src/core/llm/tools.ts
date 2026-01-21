/**
 * OpenAI function tool definitions for LLM-based draft analysis.
 *
 * These tools allow the LLM to query the database for draft data,
 * player statistics, and card information.
 */

import type OpenAI from "openai";

/**
 * Tool definitions for the OpenAI Responses API.
 * Each tool maps to a database query function.
 */
export const tools: OpenAI.Responses.Tool[] = [
  {
    type: "function",
    name: "list_drafts",
    description: "Find drafts by criteria (date range, name)",
    parameters: {
      type: "object",
      properties: {
        date_from: {
          type: "string",
          description: "Start date (YYYY-MM-DD format)",
        },
        date_to: {
          type: "string",
          description: "End date (YYYY-MM-DD format)",
        },
        draft_name: {
          type: "string",
          description: "Filter by draft name (partial match)",
        },
      },
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_draft",
    description: "Get draft details including number of seats and metadata",
    parameters: {
      type: "object",
      properties: {
        draft_id: {
          type: "string",
          description: "Draft ID (folder name)",
        },
      },
      required: ["draft_id"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_picks",
    description: "Get picks from a draft with optional filters. ALWAYS bound pick ranges (pick_n_min/pick_n_max) for broad analysis. Default sampling: first 120 picks overall, then expand if needed.",
    parameters: {
      type: "object",
      properties: {
        draft_id: {
          type: "string",
          description: "Draft ID (folder name)",
        },
        seat: {
          type: "integer",
          description: "Filter by seat number (1-indexed)",
        },
        pick_n_min: {
          type: "integer",
          description: "Minimum pick number (inclusive)",
        },
        pick_n_max: {
          type: "integer",
          description: "Maximum pick number (inclusive)",
        },
        card_name: {
          type: "string",
          description: "Filter by card name (partial match)",
        },
      },
      required: ["draft_id"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_available_cards",
    description:
      "Get cards that were available (not yet picked) before a specific pick. Best for point-in-time decision analysis. Avoid bulk use across many picks without user confirmation.",
    parameters: {
      type: "object",
      properties: {
        draft_id: {
          type: "string",
          description: "Draft ID (folder name)",
        },
        before_pick_n: {
          type: "integer",
          description: "Get cards available before this pick number",
        },
        color: {
          type: "string",
          description: "Filter by color identity (W/U/B/R/G for colors, C for colorless)",
        },
        type_contains: {
          type: "string",
          description: "Filter by type line substring (e.g., 'Creature', 'Instant')",
        },
      },
      required: ["draft_id", "before_pick_n"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_standings",
    description: "Get match standings for a draft, showing wins/losses for each seat",
    parameters: {
      type: "object",
      properties: {
        draft_id: {
          type: "string",
          description: "Draft ID (folder name)",
        },
      },
      required: ["draft_id"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_card_pick_stats",
    description:
      "Get aggregate pick statistics for a card across drafts (avg pick, median, weighted geomean). Use for cross-draft trends BEFORE considering multiple get_draft_pool calls.",
    parameters: {
      type: "object",
      properties: {
        card_name: {
          type: "string",
          description: "Card name to look up",
        },
        date_from: {
          type: "string",
          description: "Start date (YYYY-MM-DD)",
        },
        date_to: {
          type: "string",
          description: "End date (YYYY-MM-DD)",
        },
        draft_name: {
          type: "string",
          description: "Filter by draft name (partial match)",
        },
      },
      required: ["card_name"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "lookup_card",
    description:
      "Look up card details from Scryfall (oracle text, type line, mana cost, colors). Soft cap: 12 calls per response. If you need more cards, consider a filtered get_draft_pool instead.",
    parameters: {
      type: "object",
      properties: {
        card_name: {
          type: "string",
          description: "The exact name of the MTG card to look up",
        },
      },
      required: ["card_name"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_draft_pool",
    description:
      "Get the card pool for a draft (the cube snapshot). If draft_id is omitted, returns the most recent draft's pool. HIGH-VOLUME: Use filters (color, type_contains, name_contains) when possible. Prefer group_by='color_identity' over include_card_details=true for archetype analysis. Max 2 calls per response without user confirmation.",
    parameters: {
      type: "object",
      properties: {
        draft_id: {
          type: "string",
          description: "Draft ID (folder name), e.g. 'tarkir' or 'birds-of-paradise'. If omitted, uses the most recent draft.",
        },
        include_draft_results: {
          type: "boolean",
          description:
            "Include who drafted each card (drafted_by, drafted_pick_n). Default false. Enable only when you need seat-level attribution.",
        },
        include_card_details: {
          type: "boolean",
          description:
            "Include card metadata (mana_cost, type_line, colors). Default false. Prefer lookup_card for small sets or filtered pools instead.",
        },
        group_by: {
          type: "string",
          enum: ["none", "color_identity", "type"],
          description:
            "Grouping mode. Use 'color_identity' for archetype slices instead of include_card_details=true. Default 'none'.",
        },
        color: {
          type: "string",
          description:
            "Filter by color identity (W/U/B/R/G, C for colorless). Apply filters to reduce payload.",
        },
        type_contains: {
          type: "string",
          description:
            "Filter by type line substring (e.g. 'Creature', 'Instant'). Apply filters to reduce payload.",
        },
        name_contains: {
          type: "string",
          description: "Case-insensitive substring filter on card name.",
        },
      },
      required: [],
    },
    strict: false,
  },
];

/**
 * Tool names as a union type for type safety.
 */
export type ToolName =
  | "list_drafts"
  | "get_draft"
  | "get_picks"
  | "get_available_cards"
  | "get_standings"
  | "get_card_pick_stats"
  | "lookup_card"
  | "get_draft_pool";

/**
 * Check if a string is a valid tool name.
 */
export function isValidToolName(name: string): name is ToolName {
  const validNames: ToolName[] = [
    "list_drafts",
    "get_draft",
    "get_picks",
    "get_available_cards",
    "get_standings",
    "get_card_pick_stats",
    "lookup_card",
    "get_draft_pool",
  ];
  return validNames.includes(name as ToolName);
}
