/**
 * API route for LLM chat queries.
 *
 * Accepts POST requests with a user message, processes them using the LLM
 * client with tool-based retrieval, and returns responses with citations.
 */

import { NextRequest, NextResponse } from "next/server";
import { createLLMClient, DRAFT_ANALYST_PROMPT } from "../../../core/llm";

/** Model to use for web API queries */
const WEB_MODEL = "gpt-5.2-2025-12-11" as const;

/**
 * Request body schema for the chat API.
 */
interface ChatRequest {
  message: string;
  previousResponseId?: string;
}

/**
 * Response body schema for the chat API.
 */
interface ChatResponse {
  text: string;
  responseId: string;
  model: string;
}

/**
 * Error response schema.
 */
interface ErrorResponse {
  error: string;
}

/**
 * POST /api/chat
 *
 * Process a chat message with the LLM.
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<ChatResponse | ErrorResponse>> {
  try {
    // Parse and validate request body
    const body = (await request.json()) as ChatRequest;

    if (!body.message || typeof body.message !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid 'message' field" },
        { status: 400 }
      );
    }

    if (
      body.previousResponseId !== undefined &&
      typeof body.previousResponseId !== "string"
    ) {
      return NextResponse.json(
        { error: "Invalid 'previousResponseId' field - must be a string" },
        { status: 400 }
      );
    }

    // Create LLM client
    const client = createLLMClient({
      model: WEB_MODEL,
      // Web requests don't use background mode for faster responses
      useBackgroundMode: false,
    });

    // Process the chat request
    const result = body.previousResponseId
      ? await client.continueChat(body.message, body.previousResponseId, DRAFT_ANALYST_PROMPT)
      : await client.chat(DRAFT_ANALYST_PROMPT, body.message);

    return NextResponse.json({
      text: result.text,
      responseId: result.responseId,
      model: result.model,
    });
  } catch (error) {
    // Log the error for debugging
    console.error("Chat API error:", error);

    // Handle specific error cases
    if (error instanceof Error) {
      // API key not set
      if (error.message.includes("OPENAI_API_KEY")) {
        return NextResponse.json(
          { error: "OpenAI API key not configured" },
          { status: 500 }
        );
      }

      // Response timeout
      if (error.message.includes("timed out")) {
        return NextResponse.json(
          { error: "Request timed out - please try again" },
          { status: 504 }
        );
      }

      // Response failed
      if (error.message.includes("Response failed")) {
        return NextResponse.json(
          { error: "LLM request failed - please try again" },
          { status: 502 }
        );
      }
    }

    // Generic error
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
