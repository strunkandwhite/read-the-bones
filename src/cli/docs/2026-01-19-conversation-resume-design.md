# Conversation Resume Design

Resume LLM conversations across sessions by persisting OpenAI response IDs.

## CLI Interface

The unified `./analyze` script handles three modes:

```
./analyze data          # Explore mode - historical data chat
./analyze draft         # Draft mode - active draft advice
./analyze --resume      # Show conversation picker menu
```

Additional flags work with any mode:
- `--dev` - Use cheaper model (gpt-4o-mini)
- `--dry-run` - Print prompts without API call
- `--verbose` - Show data loading progress

The `--resume` flag shows a numbered list of recent conversations:

```
Recent conversations:

1. [draft] Mana base advice for FRF         (2 hours ago)
2. [explore] Top players' creature curves   (yesterday)
3. [draft] Blue splash in Rakdos deck       (3 days ago)

Enter number to resume, or 'q' to cancel:
```

## Data Model

Conversation store lives at `src/cli/conversations.json` (gitignored).

```typescript
type Conversation = {
  id: string;                    // UUID
  title: string;                 // LLM-generated summary (~5 words)
  mode: "explore" | "draft";     // Which mode started this conversation
  draftPath?: string;            // For draft mode: which draft folder
  responseIds: string[];         // Ordered chain of OpenAI response IDs
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp (for sorting)
};

type ConversationStore = {
  conversations: Conversation[];
};
```

When you send a message, the new response ID gets appended to `responseIds`. To resume, use the last ID in the array as `previous_response_id`.

## Conversation Lifecycle

**Starting a new conversation:**
1. User runs `./analyze data` or `./analyze draft`
2. Initial LLM call returns a response ID
3. Create new `Conversation` with that response ID in the array
4. After the REPL ends, call the LLM: "Summarize this conversation in 5 words or less for a menu title"
5. Store the title and save to `conversations.json`

**Continuing within a session:**
1. Each follow-up in the REPL appends the new response ID to `responseIds`
2. `updatedAt` is refreshed
3. Save after each exchange (so we don't lose state on crash/ctrl-c)

**Resuming a previous conversation:**
1. User runs `./analyze --resume`
2. Load conversations, sort by `updatedAt` descending
3. Display numbered menu with titles and relative timestamps
4. User picks one, take last response ID from `responseIds`
5. Re-enter REPL with that ID as `previous_response_id`
6. New responses continue appending to the same conversation

## Module Structure

New and modified files in `src/cli/`:

```
src/cli/
  analyze.ts           # NEW - unified entry point
  conversations.ts     # NEW - load/save/list conversations, title generation
  types.ts             # MODIFY - add Conversation and ConversationStore types
  suggest.ts           # MODIFY - export core logic as function (not entry point)
  explore.ts           # MODIFY - export core logic as function (not entry point)
  repl.ts              # MODIFY - accept conversation ID, save after each exchange
  conversations.json   # NEW - data file (gitignored)
```

The key refactor: `suggest.ts` and `explore.ts` become libraries that export their core logic. The new `analyze.ts` handles argument parsing, mode selection, and conversation management, then delegates to the appropriate module.

```typescript
// analyze.ts (simplified)
if (args.resume) {
  await showConversationPicker();
} else if (args.mode === "data") {
  await runExploreMode(options);
} else {
  await runDraftMode(draftPath, options);
}
```

## Edge Cases & Error Handling

**Stale response IDs:**
OpenAI may expire old response IDs. If resuming fails with an API error, catch it and show: "Conversation expired. Starting fresh." - then remove that conversation from the store.

**Empty conversation list:**
If `--resume` is called with no saved conversations, show: "No previous conversations found." and exit.

**Corrupted JSON:**
If `conversations.json` fails to parse, back it up to `conversations.json.bak`, start fresh with an empty store, and warn the user.

**Ctrl-C handling:**
Save conversation state before exiting so partial conversations aren't lost. Title generation gets skipped on interrupt - use a fallback like "Untitled (interrupted)".

**Draft folder moved/deleted:**
When resuming a draft-mode conversation, if the original `draftPath` no longer exists, warn but still allow resuming (the LLM has context from before).
