# Interactive Suggest Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `pnpm suggest` interactive - enter a REPL after initial recommendation for follow-up questions.

**Architecture:** Use OpenAI Responses API's `previous_response_id` to maintain conversation state. Add `continueConversation()` function for follow-ups. REPL uses Node's readline module.

**Tech Stack:** TypeScript, OpenAI Responses API, Node readline

---

## Task 1: Update SuggestionResult to include responseId

**Files:**
- Modify: `src/cli/llmClient.ts:47-52`

**Step 1: Update SuggestionResult type**

Change the type definition to include responseId:

```typescript
export type SuggestionResult = {
  /** The model's text response */
  text: string;
  /** The actual model ID used (from API response) */
  model: string;
  /** Response ID for continuing the conversation */
  responseId: string;
};
```

**Step 2: Update return statements in getSuggestion**

Find the two return statements (lines 117 and 129) and add `responseId`:

Line ~117:
```typescript
return { text: textContent.text, model: actualModel, responseId: currentResponse.id };
```

Line ~129:
```typescript
return { text: currentResponse.output_text, model: actualModel, responseId: currentResponse.id };
```

**Step 3: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/cli/llmClient.ts
git commit -m "feat(llm): add responseId to SuggestionResult"
```

---

## Task 2: Add continueConversation function

**Files:**
- Modify: `src/cli/llmClient.ts` (add new function after getSuggestion)

**Step 1: Add the continueConversation function**

Add after the `getSuggestion` function (before `executeFunctionCall`):

```typescript
/**
 * Continue an existing conversation with a follow-up message.
 *
 * Uses the Responses API's previous_response_id to maintain conversation context.
 * The system prompt is already established from the initial call.
 *
 * @param userMessage - The user's follow-up message
 * @param previousResponseId - Response ID from the previous turn
 * @param lookupCard - Callback to look up card details
 * @param options - LLM configuration options
 * @returns Object with the model's text response, model used, and new response ID
 * @throws Error if OPENAI_API_KEY is not set or API calls fail
 */
export async function continueConversation(
  userMessage: string,
  previousResponseId: string,
  lookupCard: (name: string) => Promise<string>,
  options: LlmOptions
): Promise<SuggestionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set.");
  }

  const client = new OpenAI({ apiKey });
  const model = options.model;
  const isGpt5 = model.startsWith("gpt-5");

  let currentResponse = await client.responses.create({
    model,
    input: userMessage,
    tools,
    tool_choice: "auto",
    previous_response_id: previousResponseId,
    ...(isGpt5 && { reasoning: { effort: "medium" } }),
  });

  while (true) {
    const actualModel = currentResponse.model;

    // Check for final text output
    const textOutput = currentResponse.output.find(
      (item) => item.type === "message"
    );

    if (textOutput && textOutput.type === "message") {
      const textContent = textOutput.content.find(
        (c) => c.type === "output_text"
      );
      if (textContent && textContent.type === "output_text") {
        return { text: textContent.text, model: actualModel, responseId: currentResponse.id };
      }
    }

    // Check for function calls
    const functionCalls = currentResponse.output.filter(
      (item) => item.type === "function_call"
    );

    if (functionCalls.length === 0) {
      if (currentResponse.output_text) {
        return { text: currentResponse.output_text, model: actualModel, responseId: currentResponse.id };
      }
      throw new Error("No output from OpenAI Responses API");
    }

    // Process function calls
    const toolResults: OpenAI.Responses.ResponseInputItem[] = [];

    for (const call of functionCalls) {
      if (call.type !== "function_call") continue;

      const result = await executeFunctionCall(call, lookupCard);
      toolResults.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: result,
      });
    }

    // Continue with tool results
    currentResponse = await client.responses.create({
      model,
      input: toolResults,
      tools,
      tool_choice: "auto",
      previous_response_id: currentResponse.id,
      ...(isGpt5 && { reasoning: { effort: "medium" } }),
    });
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/cli/llmClient.ts
git commit -m "feat(llm): add continueConversation for follow-up messages"
```

---

## Task 3: Add REPL loop to suggest.ts

**Files:**
- Modify: `src/cli/suggest.ts`

**Step 1: Add readline import**

Add to imports at the top:

```typescript
import * as readline from "readline";
```

**Step 2: Update llmClient import**

Change the import to include continueConversation:

```typescript
import { getSuggestion, continueConversation } from "./llmClient";
```

**Step 3: Add runRepl function**

Add before the `main` function:

```typescript
/**
 * Run the interactive REPL for follow-up questions.
 *
 * @param responseId - Response ID from initial suggestion
 * @param options - LLM options (devMode, model)
 */
async function runRepl(
  responseId: string,
  options: { devMode: boolean; model: string }
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let currentResponseId = responseId;

  const prompt = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();

      // Check for exit commands
      if (
        trimmed === "exit" ||
        trimmed === "quit" ||
        trimmed === "/exit" ||
        trimmed === "/quit"
      ) {
        console.log("Session ended.");
        rl.close();
        return;
      }

      // Skip empty input
      if (!trimmed) {
        prompt();
        return;
      }

      // Get follow-up response
      try {
        const result = await continueConversation(
          trimmed,
          currentResponseId,
          lookupCard,
          options
        );

        console.log();
        console.log(result.text);
        console.log();

        currentResponseId = result.responseId;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
        console.log();
      }

      prompt();
    });
  };

  // Handle Ctrl+D (EOF)
  rl.on("close", () => {
    console.log("\nSession ended.");
    process.exit(0);
  });

  prompt();
}
```

**Step 4: Update main to call runRepl**

Replace the try/catch block at the end of main (lines 227-240) with:

```typescript
  // Get suggestion from LLM
  try {
    const result = await getSuggestion(systemPrompt, userPrompt, lookupCard, {
      devMode,
      model: requestedModel,
    });

    console.log(result.text);
    console.log();
    console.log(`[model: ${result.model}]`);
    console.log();

    // Enter interactive REPL
    await runRepl(result.responseId, { devMode, model: requestedModel });
  } catch (error) {
    const message = (error as Error).message;
    console.error(`Error getting suggestion: ${message}`);
    process.exit(1);
  }
```

**Step 5: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add src/cli/suggest.ts
git commit -m "feat(suggest): add interactive REPL for follow-up questions"
```

---

## Task 4: Manual integration test

**Step 1: Run with --dev flag**

Run: `pnpm suggest data/tarkir-fate-reforged --dev`

Expected:
- Header prints
- Initial recommendation prints
- Model prints
- `> ` prompt appears

**Step 2: Test follow-up question**

Type: `why not snapcaster?`

Expected:
- LLM responds with explanation
- New `> ` prompt appears

**Step 3: Test exit**

Type: `exit`

Expected: `Session ended.` prints and process exits

**Step 4: Test Ctrl+C**

Run again, then press Ctrl+C

Expected: Process exits immediately

**Step 5: Commit any fixes if needed**

If any issues found, fix and commit.

---

## Task 5: Final cleanup

**Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests pass (no changes to tested code)

**Step 2: Run typecheck**

Run: `pnpm tsc --noEmit`
Expected: No errors

**Step 3: Final commit if any cleanup needed**

If any final adjustments, commit them.
