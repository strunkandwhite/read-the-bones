# Codebase Cleanup Design

**Date:** 2026-01-20
**Status:** COMPLETE (2026-01-20)

## Problem

After the Turso migration and CLI submodule merge, the codebase contains:
- Dead code from previous iterations
- Duplicate implementations
- Stale documentation
- Type inconsistencies

## Decisions

| Area | Decision |
|------|----------|
| CLI data loading | Use Turso (remove `dataLoader.ts`) |
| Scryfall lookup | Database cache first, API fallback for unknown cards |
| Model IDs | Keep separate: CLI uses `gpt-5.2-2025-12-11`, web uses `gpt-5-mini-2025-08-07` |
| CLI documentation | Merge into root `CLAUDE.md` |
| Design docs | Keep and mark complete |

## Changes

### Phase 1: Dead Code Removal

1. **Remove `_lookupCard` parameter** from CLI LLM client functions
   - `src/cli/llmClient.ts`: Remove parameter from `getSuggestion` and `continueConversation`
   - `src/cli/suggest.ts`: Remove argument from call sites
   - `src/cli/explore.ts`: Remove `dummyLookupCard` function and argument

2. **Verify and remove `buildLegacyExploreUserPrompt`** if unused
   - `src/cli/explorePrompt.ts`: Check references, delete if dead

### Phase 2: Consolidate Scryfall Lookup

1. **Modify `src/core/db/queries.ts`** to fall back to Scryfall API when card not found in database

2. **Remove `src/cli/scryfallTool.ts`** after migration complete

3. **Consolidate Scryfall types** into one definition in `src/core/types.ts`

### Phase 3: Migrate CLI to Turso

1. **Update CLI imports** to use `tursoDataLoader.ts` instead of `dataLoader.ts`
   - `src/cli/suggest.ts`
   - Any other CLI files using `loadAllDrafts`

2. **Remove `src/build/dataLoader.ts`** after CLI migration

3. **Remove `src/build/dataLoader.test.ts`** (tests for removed code)

### Phase 4: Fix Type Inconsistencies

1. **Update `ModelId` type** in `src/core/llm/client.ts`:
   ```typescript
   export type ModelId = "gpt-5.2-2025-12-11" | "gpt-5-mini-2025-08-07" | "gpt-4o-mini";
   ```

2. **Verify CLI model references** match the updated type

### Phase 5: Documentation Updates

1. **Merge CLI docs into root CLAUDE.md**
   - Add CLI-specific information to appropriate sections
   - Delete `src/cli/CLAUDE.md`

2. **Update Turso migration design doc**
   - Mark Phase 5 complete in `docs/plans/2026-01-20-turso-migration-design.md`

3. **Review root CLAUDE.md** for accuracy after all changes

## Verification

After each phase:
- Run `pnpm test` to ensure no regressions
- Run `pnpm build` to verify production build works
- Test CLI commands manually: `pnpm suggest`, `pnpm explore`

## Files to Delete

- `src/cli/scryfallTool.ts`
- `src/cli/CLAUDE.md`
- `src/build/dataLoader.ts`
- `src/build/dataLoader.test.ts`

## Files to Modify

- `src/cli/llmClient.ts` — remove `_lookupCard` parameter
- `src/cli/suggest.ts` — update imports and call sites
- `src/cli/explore.ts` — remove dummy function, update calls
- `src/cli/explorePrompt.ts` — remove legacy function if unused
- `src/core/db/queries.ts` — add Scryfall API fallback
- `src/core/llm/client.ts` — fix ModelId type
- `src/core/types.ts` — consolidate Scryfall types
- `CLAUDE.md` — merge CLI documentation
- `docs/plans/2026-01-20-turso-migration-design.md` — mark complete
