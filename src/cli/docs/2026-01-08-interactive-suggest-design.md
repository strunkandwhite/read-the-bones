# Interactive Suggest Design

## Overview

Make `pnpm suggest` interactive - after showing initial recommendations, enter a REPL for follow-up questions about the draft.

## Command Interface

`pnpm suggest <folder>` becomes interactive by default. Existing flags work unchanged:
- `--dev` - Use cheaper model (gpt-4o-mini)
- `--dry-run` - Print prompts and exit (no REPL)

## Startup Flow

1. Parse args, validate draft folder
2. Load draft state (picks.csv, pool.csv)
3. Load historical stats and Scryfall cache
4. Build system/user prompts
5. Print header: `Your pick #9 (89 overall)`
6. Call LLM, print initial recommendation
7. Enter REPL loop

## REPL Loop

```
> why not snapcaster?
[LLM responds...]

> what if Seat 4 takes the tarn
[LLM responds...]

> exit
Session ended.
```

**Input prompt:** `> `

**Exit triggers:**
- `exit`, `quit`, `/quit`, `/exit` - clean exit
- Ctrl+C - immediate exit
- Ctrl+D (EOF) - clean exit

**Empty input:** Show prompt again (no API call)

## API Integration

Use Responses API conversation threading via `previous_response_id`.

**Initial call:** Returns response ID along with text and model.

**Follow-up calls:**
```typescript
const response = await client.responses.create({
  model,
  input: userMessage,
  tools,
  tool_choice: "auto",
  previous_response_id: lastResponseId,
  ...(isGpt5 && { reasoning: { effort: "medium" } }),
});
```

No `instructions` on follow-ups - system prompt established on first call.

Tool calls (`lookup_card`) continue to work mid-conversation.

## Code Changes

### src/cli/llmClient.ts

Update `getSuggestion()` to return response ID:
```typescript
export type SuggestionResult = {
  text: string;
  model: string;
  responseId: string;
};
```

Add new function for follow-ups:
```typescript
export async function continueConversation(
  userMessage: string,
  previousResponseId: string,
  lookupCard: (name: string) => Promise<string>,
  options: LlmOptions
): Promise<SuggestionResult>
```

### src/cli/suggest.ts

Add REPL loop after initial recommendation:
```typescript
async function runRepl(
  responseId: string,
  lookupCard: (name: string) => Promise<string>,
  options: LlmOptions
): Promise<void>
```

Uses Node's `readline` module for input.

## Error Handling

If API call fails mid-conversation, print error and show prompt again (don't exit REPL).
