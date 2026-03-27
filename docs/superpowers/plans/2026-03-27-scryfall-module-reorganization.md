# Scryfall Module Reorganization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Scryfall HTTP API wrappers from build/ to core/ to fix dependency direction violation.

**Architecture:** Move fetchCard and fetchCardFuzzy to the existing core/scryfallApi.ts module. Keep file I/O cache functions in build/scryfall.ts. Update import paths.

**Tech Stack:** TypeScript, Vitest

---

## Problem

`src/build/scryfall.ts` mixes two concerns:

1. **Pure HTTP wrappers** (`fetchCard`, `fetchCardFuzzy`) -- make HTTP calls to the Scryfall API using `fetch()`, no file I/O
2. **File I/O cache operations** (`loadCache`, `saveCache`) -- use Node.js `readFileSync`, `writeFileSync`, `existsSync`

The `core/` layer (documented as "framework-agnostic logic") imports `fetchCard` and `fetchCardFuzzy` from `build/scryfall.ts`. This creates a dependency direction violation: core depends on build. The HTTP functions belong in core because they are framework-agnostic (browser-compatible `fetch()` only), while the file I/O functions correctly belong in build.

### Current import graph

```
core/sync.ts ──imports──> build/scryfall.ts { fetchCard, fetchCardFuzzy }    # VIOLATION
core/db/ingest/scryfall.ts ──imports──> build/scryfall.ts { loadCache }      # OK (build is correct home for file I/O)
build/scryfall.ts ──imports──> core/scryfallApi.ts { SCRYFALL_API_BASE, transformApiResponse, ScryfallApiResponse }
```

### Target import graph

```
core/sync.ts ──imports──> core/scryfallApi.ts { fetchCard, fetchCardFuzzy }  # FIXED
core/db/ingest/scryfall.ts ──imports──> build/scryfall.ts { loadCache }      # UNCHANGED
build/scryfall.ts ──imports──> core/scryfallApi.ts { ... }                   # UNCHANGED (only types if needed)
core/db/queries/helpers.ts ──imports──> core/scryfallApi.ts { ... }          # UNCHANGED (already correct)
```

### Observation: duplicate fetch logic in helpers.ts

`src/core/db/queries/helpers.ts` contains `fetchFromScryfallApi()` (lines 194-217) which duplicates the exact-match fetch pattern from `fetchCard`. It already imports from `core/scryfallApi`. This is not in scope for this plan but is worth noting for a future cleanup -- once `fetchCard` lives in `core/scryfallApi`, `fetchFromScryfallApi` could be refactored to delegate to it.

---

## Task 1: Move fetchCard and fetchCardFuzzy to core/scryfallApi.ts

### 1a. Add functions to `src/core/scryfallApi.ts`

- [ ] Append `fetchCard` and `fetchCardFuzzy` to the end of `src/core/scryfallApi.ts`

The functions use only `SCRYFALL_API_BASE`, `transformApiResponse`, and `ScryfallApiResponse` -- all already defined in this file. The `ScryCard` type is already imported. No new imports needed.

Add the following after the existing `transformApiResponse` function (after line 86):

```typescript
/**
 * Fetch a single card from the Scryfall API.
 *
 * @param cardName - The exact card name to look up
 * @returns The card data, or null if not found
 */
export async function fetchCard(cardName: string): Promise<ScryCard | null> {
  const encodedName = encodeURIComponent(cardName);
  const url = `${SCRYFALL_API_BASE}/cards/named?exact=${encodedName}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        console.warn(`[Scryfall] Card not found: "${cardName}"`);
        return null;
      }
      console.warn(
        `[Scryfall] API error for "${cardName}": ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = (await response.json()) as ScryfallApiResponse;
    return transformApiResponse(data);
  } catch (error) {
    console.warn(`[Scryfall] Failed to fetch "${cardName}":`, error);
    return null;
  }
}

/**
 * Fetch a single card using Scryfall's fuzzy name matching.
 * Handles Omen Paths digital names and other alternate names.
 */
export async function fetchCardFuzzy(cardName: string): Promise<ScryCard | null> {
  const encodedName = encodeURIComponent(cardName);
  const url = `${SCRYFALL_API_BASE}/cards/named?fuzzy=${encodedName}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      console.warn(
        `[Scryfall] Fuzzy API error for "${cardName}": ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = (await response.json()) as ScryfallApiResponse;
    return transformApiResponse(data);
  } catch (error) {
    console.warn(`[Scryfall] Failed fuzzy fetch "${cardName}":`, error);
    return null;
  }
}
```

### 1b. Remove functions from `src/build/scryfall.ts`

- [ ] Delete `fetchCard` (lines 16-46) and `fetchCardFuzzy` (lines 47-75) from `src/build/scryfall.ts`
- [ ] Remove the now-unused imports: `SCRYFALL_API_BASE`, `transformApiResponse`, and `ScryfallApiResponse` from the import statement on lines 9-13
- [ ] Remove the `ScryCard` type import on line 8 only if `loadCache` and `saveCache` still use it (they do -- keep it)

After this change, `src/build/scryfall.ts` should contain only:

```typescript
/**
 * Scryfall file-based cache operations.
 * Uses Node.js fs for reading/writing cache files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { ScryCard } from "../core/types";
import { cardNameKey } from "../core/parseSheetRows";

// loadCache and saveCache functions (unchanged)
```

The import of `SCRYFALL_API_BASE`, `transformApiResponse`, and `ScryfallApiResponse` from `../core/scryfallApi` should be removed entirely since `loadCache` and `saveCache` do not use them.

### 1c. Verify: run typecheck and tests

- [ ] Run `pnpm typecheck` -- expect pass
- [ ] Run `pnpm test` -- expect failures in `src/build/scryfall.test.ts` (fetchCard tests will fail since the import moved) and `src/core/__tests__/sync.test.ts` (mock path is wrong). These are fixed in Tasks 2 and 3.

---

## Task 2: Update import paths in consumer modules

### 2a. Update `src/core/sync.ts`

- [ ] Change line 10 from:
  ```typescript
  import { fetchCard, fetchCardFuzzy } from "../build/scryfall";
  ```
  to:
  ```typescript
  import { fetchCard, fetchCardFuzzy } from "./scryfallApi";
  ```

### 2b. Verify `src/core/db/ingest/scryfall.ts` is unchanged

- [ ] Confirm line 4 still reads:
  ```typescript
  import { loadCache } from "../../../build/scryfall";
  ```
  This import stays because `loadCache` remains in `build/scryfall.ts`.

### 2c. Verify: run typecheck

- [ ] Run `pnpm typecheck` -- expect pass

---

## Task 3: Move and update tests

### 3a. Split `src/build/scryfall.test.ts`

The current test file tests both `fetchCard` (HTTP) and `loadCache`/`saveCache` (file I/O). After the move:

- `fetchCard` tests belong with `core/scryfallApi.test.ts`
- `loadCache`/`saveCache` tests stay in `build/scryfall.test.ts`

- [ ] Move the `fetchCard` describe block (lines 92-287) and its test fixtures (`mockLightningBoltResponse`, `mockDoubleFacedResponse`, `mockDfcNoTopLevelColorsResponse` at lines 23-90) from `src/build/scryfall.test.ts` to `src/core/scryfallApi.test.ts`

In `src/core/scryfallApi.test.ts`, add:
- Import `fetchCard` from `./scryfallApi` (add to existing import on line 2)
- The mock fetch setup: `const mockFetch = vi.fn(); vi.stubGlobal("fetch", mockFetch);`
- The three mock response objects
- The entire `describe("fetchCard", ...)` block

- [ ] Update `src/build/scryfall.test.ts`:
  - Remove `fetchCard` from the import on line 10 (keep `loadCache, saveCache`)
  - Remove the mock fetch setup (lines 15-16: `const mockFetch = vi.fn(); vi.stubGlobal("fetch", mockFetch);`)
  - Remove mock response objects (lines 23-90)
  - Remove the entire `describe("fetchCard", ...)` block (lines 92-287)
  - The file should only contain the `loadCache` and `saveCache` test suites with their `memfs` setup

After changes, `src/build/scryfall.test.ts` should look like:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { vol } from "memfs";

vi.mock("fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

import { loadCache, saveCache } from "./scryfall";
import type { ScryCard } from "../core/types";
import { cardNameKey } from "../core/parseSheetRows";

const TEST_CACHE_DIR = "/cache/test";
const TEST_CACHE_PATH = `${TEST_CACHE_DIR}/scryfall-test.json`;

describe("loadCache", () => {
  // ... existing tests unchanged
});

describe("saveCache", () => {
  // ... existing tests unchanged
});
```

### 3b. Update mock path in `src/core/__tests__/sync.test.ts`

- [ ] Change line 12 from:
  ```typescript
  vi.mock("../../build/scryfall", () => ({
    fetchCard: vi.fn().mockResolvedValue(null),
    fetchCardFuzzy: vi.fn().mockResolvedValue(null),
  }));
  ```
  to:
  ```typescript
  vi.mock("../scryfallApi", () => ({
    // Re-export the real transformApiResponse and types; only mock the fetch functions
    ...vi.importActual("../scryfallApi"),
    fetchCard: vi.fn().mockResolvedValue(null),
    fetchCardFuzzy: vi.fn().mockResolvedValue(null),
  }));
  ```

  Note: Using spread of `importActual` ensures `transformApiResponse`, `SCRYFALL_API_BASE`, and type exports remain available if any transitive import needs them. If this causes issues with the async nature of `importActual`, an alternative is to mock only the two functions and let the rest pass through:

  ```typescript
  vi.mock("../scryfallApi", async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      fetchCard: vi.fn().mockResolvedValue(null),
      fetchCardFuzzy: vi.fn().mockResolvedValue(null),
    };
  });
  ```

### 3c. Verify: run all tests

- [ ] Run `pnpm test` -- expect all tests pass
- [ ] Run `pnpm typecheck` -- expect pass

---

## Task 4: Final verification

- [ ] Run `pnpm typecheck` -- confirm no type errors
- [ ] Run `pnpm lint` -- confirm no lint errors
- [ ] Run `pnpm knip` -- confirm no unused exports flagged for the moved functions
- [ ] Run `pnpm test` -- confirm all tests pass
- [ ] Verify no circular dependencies: `core/scryfallApi.ts` imports only from `./types` (no build/ imports). `build/scryfall.ts` imports from `../core/types` and `../core/parseSheetRows` (no circular path back to build/).

### Circular dependency check

After the move, the dependency graph for the affected files:

```
core/scryfallApi.ts → core/types.ts                    (leaf, no cycles)
core/sync.ts → core/scryfallApi.ts                     (OK: core → core)
core/db/ingest/scryfall.ts → build/scryfall.ts          (OK: core → build for file I/O)
build/scryfall.ts → core/types.ts, core/parseSheetRows  (OK: build → core)
core/db/queries/helpers.ts → core/scryfallApi.ts        (OK: core → core, already existed)
```

No circular dependencies are introduced.

- [ ] Commit with message: "Move Scryfall HTTP wrappers from build/ to core/ to fix dependency direction"

---

## Files touched

| File | Action |
|------|--------|
| `src/core/scryfallApi.ts` | Add `fetchCard` and `fetchCardFuzzy` |
| `src/build/scryfall.ts` | Remove `fetchCard`, `fetchCardFuzzy`, and unused imports |
| `src/core/sync.ts` | Update import path (line 10) |
| `src/core/scryfallApi.test.ts` | Add `fetchCard` tests and mock fixtures |
| `src/build/scryfall.test.ts` | Remove `fetchCard` tests and mock fixtures |
| `src/core/__tests__/sync.test.ts` | Update mock path (line 12) |
