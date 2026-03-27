# Deep Clean Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 47 findings across architecture, security, performance, code quality, and documentation identified in the 2026-03-27 deep clean audit.

**Architecture:** Extract shared utilities first (sha256, parseBannedCards, error classes, isLocal), then update consumers. Security and performance fixes build on the shared utilities. Documentation updates come last.

**Tech Stack:** Next.js, TypeScript, Turso/libsql, Vitest

---

## Chunk 1: Shared Utilities

These tasks create reusable helpers that later tasks depend on. No dependencies between them — all can run in parallel.

### Task 1: Extract `sha256Short` helper and deduplicate hash computation

**Findings:** Q2, Q3, Q5

The SHA-256-truncate-to-16-hex pattern appears in 4 places. `computeCubeHash` and `hashPool` are functionally identical. The ingestion hash computation is duplicated in `getCards.ts` and `getDraftStats.ts`.

**Files:**
- Modify: `src/core/db/sync/domains.ts` — export `sha256Short`
- Modify: `src/core/db/ingest/utils.ts` — replace `computeCubeHash` with import from domains
- Modify: `src/core/getCards.ts:74-77` — extract ingestion hash to shared helper
- Modify: `src/core/getDraftStats.ts:224-227` — use shared ingestion hash helper
- Test: `src/core/db/sync/__tests__/domains.test.ts` — add test for `sha256Short`

- [ ] **Step 1: Export `sha256Short` from domains.ts**

In `src/core/db/sync/domains.ts`, rename the private `sha256` to `sha256Short` and export it:

```ts
// Change from:
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// To:
export function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
```

Update all internal references in the same file (`hashPool`, `hashPicks`, `hashMatches`) from `sha256(...)` to `sha256Short(...)`.

- [ ] **Step 2: Add `computeIngestionHash` to domains.ts**

Add this function to `src/core/db/sync/domains.ts`:

```ts
/**
 * Compute a cache fingerprint from draft domain hashes.
 * Used by getCards and getDraftStats to detect data changes.
 */
export function computeIngestionHash(
  rows: Array<{ pool_hash: unknown; picks_hash: unknown; matches_hash: unknown }>
): string {
  const combined = rows
    .map((r) => `${r.pool_hash ?? ""}:${r.picks_hash ?? ""}:${r.matches_hash ?? ""}`)
    .join("|");
  return sha256Short(combined);
}
```

- [ ] **Step 3: Replace `computeCubeHash` in ingest/utils.ts**

In `src/core/db/ingest/utils.ts`, replace the `computeCubeHash` implementation with a re-export from domains:

```ts
// Remove the createHash import (if no longer needed)
// Remove the computeCubeHash implementation

// Add:
export { hashPool as computeCubeHash } from "../sync/domains";
```

Remove the `import { createHash } from "crypto"` if `computeCubeHash` was the only user.

- [ ] **Step 4: Use `computeIngestionHash` in getCards.ts**

In `src/core/getCards.ts`, replace lines 73-77:

```ts
// Remove:
import { createHash } from "crypto";

// Add:
import { computeIngestionHash } from "./db/sync/domains";

// Replace lines 74-77:
const ingestionHash = computeIngestionHash(
  draftsResult.rows as Array<{ pool_hash: unknown; picks_hash: unknown; matches_hash: unknown }>
);
```

- [ ] **Step 5: Use `computeIngestionHash` in getDraftStats.ts**

In `src/core/getDraftStats.ts`, replace lines 223-227:

```ts
// Remove:
import { createHash } from "crypto";

// Add:
import { computeIngestionHash } from "./db/sync/domains";

// Replace lines 224-227:
const ingestionHash = computeIngestionHash(
  draftsResult.rows as Array<{ pool_hash: unknown; picks_hash: unknown; matches_hash: unknown }>
);
```

- [ ] **Step 6: Add tests for new exports**

Add to `src/core/db/sync/__tests__/domains.test.ts`:

```ts
import { sha256Short, computeIngestionHash } from "../domains";

describe("sha256Short", () => {
  it("returns a 16-character hex string", () => {
    const result = sha256Short("test input");
    expect(result).toHaveLength(16);
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns same hash for same input", () => {
    expect(sha256Short("hello")).toBe(sha256Short("hello"));
  });

  it("returns different hash for different input", () => {
    expect(sha256Short("a")).not.toBe(sha256Short("b"));
  });
});

describe("computeIngestionHash", () => {
  it("computes hash from draft domain hashes", () => {
    const rows = [
      { pool_hash: "abc", picks_hash: "def", matches_hash: "ghi" },
    ];
    const hash = computeIngestionHash(rows);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles null hashes", () => {
    const rows = [
      { pool_hash: null, picks_hash: null, matches_hash: null },
    ];
    const hash = computeIngestionHash(rows);
    expect(hash).toHaveLength(16);
  });

  it("returns different hash for different inputs", () => {
    const rows1 = [{ pool_hash: "a", picks_hash: "b", matches_hash: "c" }];
    const rows2 = [{ pool_hash: "x", picks_hash: "y", matches_hash: "z" }];
    expect(computeIngestionHash(rows1)).not.toBe(computeIngestionHash(rows2));
  });
});
```

- [ ] **Step 7: Run tests and verify**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm test -- --run src/core/db/sync/__tests__/domains.test.ts`

- [ ] **Step 8: Run typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck`

- [ ] **Step 9: Commit**

```bash
git add src/core/db/sync/domains.ts src/core/db/ingest/utils.ts src/core/getCards.ts src/core/getDraftStats.ts src/core/db/sync/__tests__/domains.test.ts
git commit -m "refactor: extract sha256Short and computeIngestionHash, deduplicate hash helpers"
```

---

### Task 2: Extract `parseBannedCards` helper

**Findings:** Q1

Banned cards JSON parsing is duplicated in 6 places with varying error handling.

**Files:**
- Modify: `src/core/db/queries/helpers.ts` — add `parseBannedCards`
- Modify: `src/core/getCards.ts:113-123` — use helper
- Modify: `src/core/processPick.ts:33-35` — use helper
- Modify: `src/core/db/queries/drafts.ts:92-100` — use helper
- Modify: `src/core/db/queries/picks.ts:155-165` — use helper
- Modify: `src/core/db/queries/search.ts:61-75` — use helper
- Modify: `src/app/api/drafts/[id]/board/route.ts:60-62` — use helper
- Test: existing tests should continue passing

- [ ] **Step 1: Add `parseBannedCards` to helpers.ts**

Add to `src/core/db/queries/helpers.ts`:

```ts
/**
 * Parse banned cards JSON from database column.
 * Returns a lowercase Set for O(1) lookups, or an empty Set on null/malformed input.
 */
export function parseBannedCards(json: string | null): Set<string> {
  if (!json) return new Set();
  try {
    const names = JSON.parse(json) as string[];
    return new Set(names.map((n) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Parse banned cards JSON from database column as a raw name array.
 * Used when original casing is needed (e.g., API responses, display).
 */
export function parseBannedCardNames(json: string | null): string[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Update `getCards.ts`**

In `src/core/getCards.ts`, replace lines 113-123:

```ts
// Add import:
import { parseBannedCardNames } from "./db/queries/helpers";

// Replace the banned cards block (keep cardNameKey for ban lookup keys — it strips
// DFC back-faces and numeric suffixes, which plain toLowerCase does not):
const bannedCardsJson = row.banned_cards as string | null;
const bannedNames = parseBannedCardNames(bannedCardsJson);
if (bannedNames.length > 0) {
  const banKeys = new Set(bannedNames.map(n => cardNameKey(n)));
  bannedCardsByDraft.set(draftId, banKeys);
  bannedCardNamesByDraft.set(draftId, bannedNames);
}
```

Note: `getCards.ts` must continue using `cardNameKey()` (not plain `.toLowerCase()`) for the ban key Set because `cardNameKey` also strips numeric suffixes ("Scalding Tarn 2" → "scalding tarn") and DFC back-faces. The `parseBannedCardNames` helper replaces only the JSON parsing + try/catch, not the normalization.

- [ ] **Step 3: Update `processPick.ts`**

In `src/core/processPick.ts`, replace lines 33-35 and 54-57:

```ts
// Add import:
import { parseBannedCards } from "./db/queries/helpers";

// Replace lines 33-35:
const bannedCards = parseBannedCards(row.banned_cards as string | null);

// Replace lines 54-57:
if (bannedCards.has(input.cardName.toLowerCase())) {
  throw new Error(`${input.cardName} is banned`);
}
```

Remove the old `bannedLower` variable.

- [ ] **Step 4: Update `drafts.ts`**

In `src/core/db/queries/drafts.ts`, replace lines 92-100:

```ts
// Add import:
import { parseBannedCardNames } from "./helpers";

// Replace:
const bannedCards = parseBannedCardNames(draft.banned_cards as string | null);

// Update return:
banned_cards: bannedCards.length > 0 ? bannedCards : null,
```

- [ ] **Step 5: Update `picks.ts`**

In `src/core/db/queries/picks.ts`, replace lines 154-165:

```ts
// Add import:
import { parseBannedCards } from "./helpers";

// Replace:
const bannedCards = parseBannedCards(bannedCardsRaw);
```

The rest of the code that checks `bannedCards.has(name.toLowerCase())` stays the same since `parseBannedCards` already returns a lowercase Set.

- [ ] **Step 6: Update `search.ts`**

In `src/core/db/queries/search.ts`, replace lines 61-75:

```ts
// Add import:
import { parseBannedCards } from "./helpers";

// Replace:
const bannedCards = parseBannedCards(bannedCardsRaw);
```

- [ ] **Step 7: Update `board/route.ts`**

In `src/app/api/drafts/[id]/board/route.ts`, replace lines 60-62:

```ts
// Add import:
import { parseBannedCardNames } from "@/core/db/queries/helpers";

// Replace:
const bannedCards = parseBannedCardNames(d.banned_cards as string | null);
```

- [ ] **Step 8: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 9: Commit**

```bash
git add src/core/db/queries/helpers.ts src/core/getCards.ts src/core/processPick.ts src/core/db/queries/drafts.ts src/core/db/queries/picks.ts src/core/db/queries/search.ts src/app/api/drafts/\[id\]/board/route.ts
git commit -m "refactor: extract parseBannedCards helper, deduplicate 6 call sites"
```

---

### Task 3: Create structured error classes

**Findings:** A5

The pick route dispatches HTTP status codes by string-matching on `error.message`. This is fragile.

**Files:**
- Create: `src/core/errors.ts`
- Modify: `src/core/tokenAuth.ts` — throw typed errors
- Modify: `src/core/processPick.ts` — throw typed errors
- Modify: `src/app/api/drafts/[id]/pick/route.ts` — use `instanceof` dispatch
- Modify: `src/app/api/drafts/[id]/match/route.ts` — use `instanceof` dispatch
- Modify: `src/app/api/drafts/[id]/queue/route.ts` — use `instanceof` dispatch
- Modify: `src/app/api/drafts/[id]/seat-settings/route.ts` — use `instanceof` dispatch
- Test: `src/core/errors.test.ts`

- [ ] **Step 1: Create error classes**

Create `src/core/errors.ts`:

```ts
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class AuthError extends AppError {
  constructor(message: string) {
    super(message, 401);
    this.name = "AuthError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}
```

- [ ] **Step 2: Write test for error classes**

Create `src/core/errors.test.ts`:

```ts
import { AppError, AuthError, ValidationError, NotFoundError, ConflictError } from "./errors";

describe("error classes", () => {
  it("AppError has statusCode", () => {
    const err = new AppError("test", 418);
    expect(err.message).toBe("test");
    expect(err.statusCode).toBe(418);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it("AuthError defaults to 401", () => {
    const err = new AuthError("bad token");
    expect(err.statusCode).toBe(401);
    expect(err).toBeInstanceOf(AppError);
  });

  it("ValidationError defaults to 400", () => {
    const err = new ValidationError("invalid");
    expect(err.statusCode).toBe(400);
  });

  it("NotFoundError defaults to 404", () => {
    const err = new NotFoundError("missing");
    expect(err.statusCode).toBe(404);
  });

  it("ConflictError defaults to 409", () => {
    const err = new ConflictError("conflict");
    expect(err.statusCode).toBe(409);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm test -- --run src/core/errors.test.ts`

- [ ] **Step 4: Update `tokenAuth.ts`**

Replace `throw new Error(...)` with typed errors:

```ts
import { AuthError } from './errors';

export async function authenticateSeat(...) {
  const token = extractToken(request);
  if (!token) throw new AuthError('Missing seat token');
  const resolved = await resolveToken(client, token);
  if (!resolved) throw new AuthError('Invalid seat token');
  if (resolved.draftId !== draftId) throw new AuthError('Token does not match draft');
  return { seat: resolved.seat, autoPick: resolved.autoPick };
}
```

- [ ] **Step 5: Update `processPick.ts`**

```ts
import { ValidationError, NotFoundError, ConflictError } from './errors';

// Line 28:
if (draft.rows.length === 0) throw new NotFoundError('Draft not found');

// Line 38:
throw new ValidationError(`Draft is in '${phase}' phase, not 'drafting'`);

// Line 48:
if (!next) throw new ValidationError('All picks are made');

// Line 50:
throw new ValidationError(`It's seat ${next.seat}'s turn, not seat ${input.seat}'s`);

// Line 56:
throw new ValidationError(`${input.cardName} is banned`);

// Line 64:
throw new ValidationError(`${input.cardName} has already been picked`);

// Line 89:
throw new ConflictError('pick_n already exists — retry');
```

- [ ] **Step 6: Update `pick/route.ts`**

Replace the string-matching catch block:

```ts
import { AppError } from "@/core/errors";

// Replace catch block:
} catch (error) {
  if (error instanceof AppError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  console.error("[/api/drafts/[id]/pick] Error:", error);
  return NextResponse.json({ error: "Pick failed" }, { status: 500 });
}
```

- [ ] **Step 7: Update `match/route.ts`**

```ts
import { AppError } from "@/core/errors";

// Replace catch block (line 47-53):
} catch (error) {
  if (error instanceof AppError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  console.error("[/api/drafts/[id]/match] Error:", error);
  return NextResponse.json({ error: "Failed to report match" }, { status: 500 });
}
```

- [ ] **Step 8: Update `queue/route.ts`**

Apply same pattern to both GET and PUT catch blocks:

```ts
import { AppError } from "@/core/errors";

// In both catch blocks, replace string matching:
} catch (error) {
  if (error instanceof AppError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  console.error("[/api/drafts/[id]/queue] Error:", error);
  return NextResponse.json({ error: "Failed" }, { status: 500 });
}
```

- [ ] **Step 9: Update `seat-settings/route.ts`**

Same pattern:

```ts
import { AppError } from "@/core/errors";

// Replace catch block:
} catch (error) {
  if (error instanceof AppError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  console.error("[/api/drafts/[id]/seat-settings] Error:", error);
  return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
}
```

- [ ] **Step 10: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 11: Commit**

```bash
git add src/core/errors.ts src/core/errors.test.ts src/core/tokenAuth.ts src/core/processPick.ts src/app/api/drafts/\[id\]/pick/route.ts src/app/api/drafts/\[id\]/match/route.ts src/app/api/drafts/\[id\]/queue/route.ts src/app/api/drafts/\[id\]/seat-settings/route.ts
git commit -m "refactor: replace string-matching error dispatch with typed error classes"
```

---

### Task 4: Extract `isLocalHost` helpers

**Findings:** A10

The `isLocal` check is duplicated 4 times with 2 slightly different implementations.

**Files:**
- Create: `src/core/isLocal.ts`
- Modify: `src/app/page.tsx:22-23` — use helper
- Modify: `src/app/drafts/[id]/page.tsx:16-17` — use helper
- Modify: `src/app/api/cards/route.ts:20-22` — use helper
- Modify: `src/app/hooks/useCardData.ts:35-38` — use helper
- Test: `src/core/isLocal.test.ts`

- [ ] **Step 1: Create `isLocal.ts`**

Create `src/core/isLocal.ts`:

```ts
/**
 * Server-side localhost detection from Host header.
 * Used in server components and API routes.
 */
export function isLocalHost(host: string): boolean {
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

/**
 * Client-side localhost detection from window.location.
 * Returns false during SSR.
 */
export function isLocalClient(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}
```

- [ ] **Step 2: Write tests**

Create `src/core/isLocal.test.ts`:

```ts
import { isLocalHost, isLocalClient } from "./isLocal";

describe("isLocalHost", () => {
  it("returns true for localhost", () => {
    expect(isLocalHost("localhost:3000")).toBe(true);
  });
  it("returns true for 127.0.0.1", () => {
    expect(isLocalHost("127.0.0.1:3000")).toBe(true);
  });
  it("returns false for production host", () => {
    expect(isLocalHost("readthebones.vercel.app")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isLocalHost("")).toBe(false);
  });
});

describe("isLocalClient", () => {
  it("returns false in non-browser environment", () => {
    expect(isLocalClient()).toBe(false);
  });
});
```

- [ ] **Step 3: Run test**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm test -- --run src/core/isLocal.test.ts`

- [ ] **Step 4: Update all 4 consumers**

In `src/app/page.tsx`:
```ts
import { isLocalHost } from "@/core/isLocal";
// Replace: const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
const isLocal = isLocalHost(host);
```

In `src/app/drafts/[id]/page.tsx`:
```ts
import { isLocalHost } from "@/core/isLocal";
const isLocal = isLocalHost(host);
```

In `src/app/api/cards/route.ts`:
```ts
import { isLocalHost } from "@/core/isLocal";
const isLocal = isLocalHost(host);
```

In `src/app/hooks/useCardData.ts`:
```ts
import { isLocalClient } from "@/core/isLocal";
// Replace the 3-line check:
const isLocal = isLocalClient();
```

- [ ] **Step 5: Run typecheck and tests**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add src/core/isLocal.ts src/core/isLocal.test.ts src/app/page.tsx src/app/drafts/\[id\]/page.tsx src/app/api/cards/route.ts src/app/hooks/useCardData.ts
git commit -m "refactor: extract isLocal helpers, deduplicate 4 call sites"
```

---

## Chunk 2: Security & Validation

Depends on Task 3 (error classes).

### Task 5: Add authentication to POST `/api/sync`

**Findings:** S1

The POST handler has no auth — anyone can trigger syncs.

**Files:**
- Modify: `src/app/api/sync/route.ts:162-176`
- Modify: `src/app/api/sync/route.test.ts` (if exists, update tests)

- [ ] **Step 1: Add CRON_SECRET check to POST handler**

In `src/app/api/sync/route.ts`, modify the POST function to accept and validate a request:

```ts
export async function POST(request: NextRequest) {
  // Accept auth from either header (cron) or from a known origin (UI button)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  // Allow if valid CRON_SECRET is provided, OR if request comes from same origin
  const origin = request.headers.get("origin") ?? "";
  const host = request.headers.get("host") ?? "";
  const isSameOrigin = origin.includes(host) && host.length > 0;
  const isAuthedByCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isAuthedByCron && !isSameOrigin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const client = await getClient();

    // Rate limiting
    if (await isRateLimited(client)) {
      return NextResponse.json({ status: "rate_limited" }, { status: 429 });
    }

    return await runSync();
  } catch (error) {
    console.error("[sync] Unexpected error:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sync/route.ts
git commit -m "security: add origin check to POST /api/sync to prevent unauthenticated triggers"
```

---

### Task 6: Add validation to match route

**Findings:** S2

`wins`, `losses`, `opponent_seat` are not validated as integers or non-negative.

**Files:**
- Modify: `src/app/api/drafts/[id]/match/route.ts:14-18`
- Test: `src/app/api/drafts/[id]/match/route.test.ts` (if exists)

- [ ] **Step 1: Add integer and range validation**

In `src/app/api/drafts/[id]/match/route.ts`, after the null checks (line 18), add:

```ts
// Validate types
if (!Number.isInteger(opponent_seat) || !Number.isInteger(wins) || !Number.isInteger(losses)) {
  return NextResponse.json({ error: "opponent_seat, wins, and losses must be integers" }, { status: 400 });
}
if (wins < 0 || losses < 0) {
  return NextResponse.json({ error: "wins and losses must be non-negative" }, { status: 400 });
}
if (opponent_seat < 1) {
  return NextResponse.json({ error: "opponent_seat must be >= 1" }, { status: 400 });
}
```

- [ ] **Step 2: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/drafts/\[id\]/match/route.ts
git commit -m "security: validate match result fields as non-negative integers"
```

---

### Task 7: Add `display_name` length limit and array validation

**Findings:** S4, S6

`display_name` has no length limit. Queue PUT doesn't validate body is an array.

**Files:**
- Modify: `src/app/api/drafts/[id]/seat-settings/route.ts:20-22`
- Modify: `src/app/api/drafts/[id]/queue/route.ts:33-34`

- [ ] **Step 1: Add display_name length limit**

In `src/app/api/drafts/[id]/seat-settings/route.ts`, after `const body = await request.json()` (line 15), add:

```ts
if (body.display_name !== undefined && typeof body.display_name === "string" && body.display_name.length > 50) {
  return NextResponse.json({ error: "display_name must be 50 characters or fewer" }, { status: 400 });
}
```

- [ ] **Step 2: Add array validation to queue PUT**

In `src/app/api/drafts/[id]/queue/route.ts`, after line 33 (`const body = await request.json()`), add:

```ts
if (!Array.isArray(body)) {
  return NextResponse.json({ error: "Request body must be an array" }, { status: 400 });
}
```

- [ ] **Step 3: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 4: Commit**

```bash
git add src/app/api/drafts/\[id\]/seat-settings/route.ts src/app/api/drafts/\[id\]/queue/route.ts
git commit -m "security: add display_name length limit and queue body array validation"
```

---

## Chunk 3: Performance

### Task 8: Batch pickQueue operations

**Findings:** P1, P2

`setQueue` and `removeCardFromAllQueues` make N+1 individual queries instead of using `client.batch()`.

**Files:**
- Modify: `src/core/db/queries/pickQueue.ts`
- Test: `src/core/db/queries/pickQueue.test.ts` — update test expectations

- [ ] **Step 1: Rewrite `setQueue` to use batch**

```ts
export async function setQueue(
  client: Client,
  draftId: string,
  seat: number,
  cardIds: number[],
): Promise<void> {
  const statements = [
    { sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ?`, args: [draftId, seat] },
    ...cardIds.map((cardId, i) => ({
      sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id) VALUES (?, ?, ?, ?)`,
      args: [draftId, seat, i + 1, cardId],
    })),
  ];
  await client.batch(statements);
}
```

- [ ] **Step 2: Rewrite `removeCardFromAllQueues` to use UPDATE**

Replace the current N+1 approach with a single DELETE + a priority renumbering approach:

```ts
export async function removeCardFromAllQueues(
  client: Client,
  draftId: string,
  cardId: number,
): Promise<void> {
  // Delete the card from all queues
  await client.execute({
    sql: `DELETE FROM pick_queue WHERE draft_id = ? AND card_id = ?`,
    args: [draftId, cardId],
  });

  // Get affected seats that need priority renumbering
  const seats = await client.execute({
    sql: `SELECT DISTINCT seat FROM pick_queue WHERE draft_id = ? ORDER BY seat`,
    args: [draftId],
  });

  // Renumber priorities per seat using a batch
  if (seats.rows.length > 0) {
    const renumberStatements = [];
    for (const row of seats.rows) {
      const seat = row.seat as number;
      const entries = await client.execute({
        sql: `SELECT card_id FROM pick_queue WHERE draft_id = ? AND seat = ? ORDER BY priority`,
        args: [draftId, seat],
      });
      // Delete + re-insert with correct priorities
      renumberStatements.push({
        sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ?`,
        args: [draftId, seat],
      });
      for (let i = 0; i < entries.rows.length; i++) {
        renumberStatements.push({
          sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id) VALUES (?, ?, ?, ?)`,
          args: [draftId, seat, i + 1, entries.rows[i].card_id],
        });
      }
    }
    if (renumberStatements.length > 0) {
      await client.batch(renumberStatements);
    }
  }
}
```

- [ ] **Step 3: Update tests**

The mock client needs a `batch` method. Update `createMockClient` and rewrite the `setQueue` and `removeCardFromAllQueues` tests:

```ts
function createMockClient() {
  return {
    execute: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
  } as unknown as Client & { execute: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> };
}
```

Rewrite `setQueue` test to check `batch` is called with correct statements:

```ts
describe("setQueue", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("batches delete + inserts in correct priority order", async () => {
    await setQueue(client, "draft-1", 2, [10, 20, 30]);

    expect(client.batch).toHaveBeenCalledOnce();
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(4); // 1 delete + 3 inserts
    expect(statements[0].sql).toContain("DELETE");
    expect(statements[0].args).toEqual(["draft-1", 2]);
    expect(statements[1].args).toEqual(["draft-1", 2, 1, 10]);
    expect(statements[2].args).toEqual(["draft-1", 2, 2, 20]);
    expect(statements[3].args).toEqual(["draft-1", 2, 3, 30]);
  });
});
```

Rewrite `removeCardFromAllQueues` test — it still uses `execute` for the initial DELETE and SELECT queries, then `batch` for the renumbering:

```ts
describe("removeCardFromAllQueues", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("deletes the card and batches renumbered entries", async () => {
    // execute call 1: DELETE the card
    client.execute.mockResolvedValueOnce({ rows: [] });
    // execute call 2: SELECT DISTINCT seats
    client.execute.mockResolvedValueOnce({ rows: [{ seat: 1 }] });
    // execute call 3: SELECT remaining cards for seat 1
    client.execute.mockResolvedValueOnce({
      rows: [{ card_id: 20 }, { card_id: 30 }],
    });

    await removeCardFromAllQueues(client, "draft-1", 10);

    // Verify execute calls for DELETE + SELECTs
    expect(client.execute.mock.calls[0][0].args).toEqual(["draft-1", 10]);
    expect(client.execute.mock.calls[1][0].sql).toContain("DISTINCT seat");

    // Verify batch call for renumbering
    expect(client.batch).toHaveBeenCalledOnce();
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(3); // 1 delete + 2 inserts
    expect(statements[0].sql).toContain("DELETE");
    expect(statements[1].args).toEqual(["draft-1", 1, 1, 20]);
    expect(statements[2].args).toEqual(["draft-1", 1, 2, 30]);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm test -- --run src/core/db/queries/pickQueue.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/pickQueue.ts src/core/db/queries/pickQueue.test.ts
git commit -m "perf: batch pickQueue operations to reduce N+1 round trips to Turso"
```

---

### Task 9: Batch card name resolution in queue PUT route

**Findings:** P3

Each card name is resolved with a separate query.

**Files:**
- Modify: `src/app/api/drafts/[id]/queue/route.ts:36-46`

- [ ] **Step 1: Replace sequential queries with batch lookup**

In the PUT handler, replace lines 36-46:

```ts
// Batch resolve card names to IDs
const placeholders = cardNames.map(() => "?").join(", ");
const result = await client.execute({
  sql: `SELECT card_id, name FROM cards WHERE name IN (${placeholders})`,
  args: cardNames,
});

const nameToId = new Map<string, number>();
for (const row of result.rows) {
  nameToId.set(row.name as string, row.card_id as number);
}

const cardIds: number[] = [];
for (const name of cardNames) {
  const id = nameToId.get(name);
  if (id === undefined) {
    return NextResponse.json({ error: `Card not found: ${name}` }, { status: 400 });
  }
  cardIds.push(id);
}
```

- [ ] **Step 2: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/drafts/\[id\]/queue/route.ts
git commit -m "perf: batch card name resolution in queue PUT route"
```

---

### Task 10: Use `batchInsertCubeSnapshotCards` in `db-helpers.ts`

**Findings:** P6

`ensureCubeSnapshot` inserts cards one at a time instead of using the existing batch function.

**Files:**
- Modify: `src/core/db/ingest/db-helpers.ts:116-145`

- [ ] **Step 1: Import and use batch function**

At the top of `src/core/db/ingest/db-helpers.ts`:

```ts
import { batchInsertCubeSnapshotCards } from "../sync/batch";
```

Replace both insert loops (lines 121-126 and 140-144). Each loop is in a separate code path ending with `return`, but to avoid lint issues, use distinct variable names:

```ts
// In the "recreate stale snapshot" block (replaces lines 121-126):
const staleEntries = [...cardIds.values()].map(({ cardId, qty }) => ({ cardId, qty }));
await batchInsertCubeSnapshotCards(client, cubeSnapshotId, staleEntries);

// In the "create new snapshot" block (replaces lines 140-144):
const newEntries = [...cardIds.values()].map(({ cardId, qty }) => ({ cardId, qty }));
await batchInsertCubeSnapshotCards(client, cubeSnapshotId, newEntries);
```

- [ ] **Step 2: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 3: Commit**

```bash
git add src/core/db/ingest/db-helpers.ts
git commit -m "perf: use batchInsertCubeSnapshotCards instead of sequential inserts in ensureCubeSnapshot"
```

---

## Chunk 4: Code Quality & Architecture

### Task 11: Use `parseScryfallJson` in `getDraftStats` and `board/route`

**Findings:** P5, Q6

`getDraftStats` uses raw `JSON.parse` on scryfall_json. `board/route.ts` has inline try/catch parsing.

**Files:**
- Modify: `src/core/getDraftStats.ts:119-121`
- Modify: `src/app/api/drafts/[id]/board/route.ts:32-40`

- [ ] **Step 1: Update `getDraftStats.ts`**

```ts
// Add import:
import { parseScryfallJson } from "./db/queries/helpers";

// Replace line 119-121:
const scryfall = parseScryfallJson(row.scryfall_json as string | null);
const colors: string[] = scryfall?.color_identity ?? [];
```

- [ ] **Step 2: Update `board/route.ts`**

```ts
// Add import (if not already importing from helpers for parseBannedCardNames):
import { transformScryfallJson } from "@/core/db/queries/helpers";

// Replace lines 30-48 pick mapping to use transformScryfallJson:
const picks = picksResult.rows.map((r) => {
  const sf = transformScryfallJson(r.scryfall_json as string | null, r.name as string);
  return {
    pickN: r.pick_n as number,
    seat: r.seat as number,
    cardName: r.name as string,
    oracleId: r.oracle_id as string,
    colorIdentity: sf?.colorIdentity ?? [],
    manaCost: sf?.manaCost ?? "",
  };
});
```

- [ ] **Step 3: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 4: Commit**

```bash
git add src/core/getDraftStats.ts src/app/api/drafts/\[id\]/board/route.ts
git commit -m "refactor: use parseScryfallJson/transformScryfallJson instead of raw JSON.parse"
```

---

### Task 12: Use `derivePickSeat` in PageClient

**Findings:** Q4

`PageClient` re-implements simplified snake draft logic instead of using `snakeDraft.ts:derivePickSeat`.

**Files:**
- Modify: `src/app/components/PageClient.tsx:229-246`

- [ ] **Step 1: Replace inline snake logic**

In `src/app/components/PageClient.tsx`, add import:

```ts
import { derivePickSeat, getTotalPicks } from "@/core/snakeDraft";
```

Replace lines 230-246 with:

```ts
const consecutivePicks = (() => {
  if (!isMyTurn || !liveDraftStatus.status || mySeat === null) return 0;
  const { latestPickN, numSeats, picksPerPlayer } = liveDraftStatus.status;
  const totalPicks = getTotalPicks(numSeats, picksPerPlayer);
  let count = 0;
  let pickN = latestPickN + 1;
  while (pickN <= totalPicks) {
    const { seat } = derivePickSeat(pickN, { numSeats, picksPerPlayer });
    if (seat !== mySeat) break;
    count++;
    pickN++;
  }
  return count;
})();
```

- [ ] **Step 2: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 3: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "refactor: use derivePickSeat from snakeDraft.ts instead of inline logic in PageClient"
```

---

### Task 13: Extract `useScrollLock` hook

**Findings:** A6, A9

Both `PageClient` and `DraftBoardModal` independently manage `document.body.style.overflow`. The `DraftBoardModal` also has an unreachable `if (!isOpen) return null`.

**Files:**
- Create: `src/app/hooks/useScrollLock.ts`
- Modify: `src/app/components/PageClient.tsx:141-162`
- Modify: `src/app/components/draft-board/DraftBoardModal.tsx:39-55`

- [ ] **Step 1: Create `useScrollLock` hook**

Create `src/app/hooks/useScrollLock.ts`:

```ts
"use client";

import { useEffect, useRef } from "react";

/**
 * Lock body scroll when `locked` is true.
 * Multiple callers are safe: only restores overflow when this specific
 * hook instance unlocks. Uses a ref to store the previous overflow value
 * so StrictMode double-firing and SSR don't cause issues.
 */
export function useScrollLock(locked: boolean): void {
  const previousOverflow = useRef<string | null>(null);

  useEffect(() => {
    if (!locked) return;

    previousOverflow.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow.current ?? "";
      previousOverflow.current = null;
    };
  }, [locked]);
}
```

- [ ] **Step 2: Update `PageClient.tsx`**

Replace the scroll-locking part of the effect (lines 142-147 and 160):

```ts
import { useScrollLock } from "@/app/hooks/useScrollLock";

// Add near the other hooks:
useScrollLock(deckBuilderModalOpen);

// Simplify the effect to only handle Escape key:
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && draftBoardOpen) {
      setDraftBoardOpen(false);
    }
    if (e.key === "Escape" && deckBuilderModalOpen) {
      setDeckBuilderModalOpen(false);
    }
  }
  document.addEventListener("keydown", handleKeyDown);
  return () => {
    document.removeEventListener("keydown", handleKeyDown);
  };
}, [deckBuilderModalOpen, draftBoardOpen]);
```

- [ ] **Step 3: Update `DraftBoardModal.tsx`**

Replace the scroll-locking effect and remove the unreachable guard:

```ts
import { useScrollLock } from "@/app/hooks/useScrollLock";

// Replace the useEffect with:
useScrollLock(isOpen);

useEffect(() => {
  if (!isOpen) return;

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }

  document.addEventListener("keydown", handleKeyDown);
  return () => {
    document.removeEventListener("keydown", handleKeyDown);
  };
}, [isOpen, onClose]);

// Remove the `if (!isOpen) return null;` line — parent already conditionally renders
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm typecheck && pnpm test`

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useScrollLock.ts src/app/components/PageClient.tsx src/app/components/draft-board/DraftBoardModal.tsx
git commit -m "refactor: extract useScrollLock hook with ref-counting, deduplicate scroll locking"
```

---

### Task 14: Clean up knip config

**Findings:** Q8

Knip config has a redundant entry for `src/core/db/migrate.ts` (it's already covered by `src/app/**/*.{ts,tsx}` patterns — actually no, migrate.ts is under `src/core/`, which is covered by the `project` glob but the `entry` glob `src/app/**` wouldn't catch it. Check if it's actually redundant).

**Files:**
- Modify: `knip.json`

- [ ] **Step 1: Remove redundant entry**

Knip reports `src/core/db/migrate.ts` as a redundant entry pattern because the `db:migrate` script in `package.json` (`tsx src/core/db/migrate.ts`) already marks it as an entry. Remove it from `knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": [
    "src/app/**/*.{ts,tsx}",
    "scripts/*.ts"
  ],
  "project": ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
  "ignore": ["src/core/db/schema.ts"],
  "ignoreDependencies": [
    "tailwindcss",
    "@tailwindcss/typography"
  ],
  "ignoreExportsUsedInFile": true
}
```

- [ ] **Step 2: Verify knip still passes**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm knip`

Expected: No errors. The "Configuration hints (1)" message about the redundant entry should disappear. If knip now reports `migrate.ts` as unused, re-add it and skip this task.

- [ ] **Step 3: Commit**

```bash
git add knip.json
git commit -m "chore: remove redundant knip entry for migrate.ts (auto-detected from package.json scripts)"
```

---

## Chunk 5: Documentation

### Task 15: Update README.md

**Findings:** D1, D2, D3, D4, D5, D16

README has stale CSV workflow, missing routes, missing features.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite stale sections**

Update `README.md` with:

1. **"What It Does"** — Replace "Parses draft CSV files" with accurate description:
   - "Syncs draft data from Google Sheets via the Sheets API"

2. **"Adding Draft Data"** — Replace the CSV workflow with the current workflow:
   ```
   1. Create a draft: `pnpm draft:create --name "Draft Name" --date 2026-01-15 --sheet-id <google-sheet-id>`
   2. Sync data: `pnpm sync` (fetches picks and matches from Google Sheets into Turso)
   3. Optionally add decklists: add sealeddeck.tech URLs to `data/decklists.txt`, then `pnpm decklists`
   ```

3. **REST API table** — Add missing routes: `/api/cards/search`, `/api/decks/winning`. Add a separate "Live Draft Routes" section listing `/status`, `/me`, `/pick`, `/queue`, `/board`, `/match`, `/seat-settings`.

4. **Features** — Add "Live drafts" bullet describing in-app rotisserie drafting.

5. **Opt-out section** — Replace `pnpm ingest` reference with `pnpm sync`.

- [ ] **Step 2: Verify accuracy**

Read the updated README and cross-check commands against `package.json` scripts.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README to reflect current Google Sheets sync workflow and live draft features"
```

---

### Task 16: Update CLAUDE.md

**Findings:** D6, D7, D8, D9, D10, D11, D12

CLAUDE.md has incomplete project structure, missing e2e mention, wrong decklists path, missing plan/spec docs.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update project structure**

Add `draft-board/` under components. Add missing query modules (`search`, `pickQueue`, `seatTokens`, `sharedDecks`, `helpers`) to the queries list. Add missing hooks to the hooks list.

- [ ] **Step 2: Fix precommit description**

Change line 35 from:
```
pnpm precommit   # Run all checks: typecheck → lint → knip → tests
```
To:
```
pnpm precommit   # Run all checks: typecheck → lint → knip → tests → e2e
```

- [ ] **Step 3: Fix decklists.txt path**

Change "Add sealeddeck.tech URLs to `decklists.txt`" to "Add sealeddeck.tech URLs to `data/decklists.txt`".

- [ ] **Step 4: Add e2e testing section**

Add under Key Commands:
```
pnpm test:e2e    # Run Playwright e2e tests (requires chromium: npx playwright install chromium)
```

- [ ] **Step 5: Add `draft:delete` to Key Commands**

```
pnpm draft:delete <draft-name>  # Delete a draft and all its data
```

- [ ] **Step 6: Update plan and spec document lists**

Add these missing **specs** to the Superpowers Specs section:
- `docs/superpowers/specs/2026-03-21-deep-clean-design.md` - Deep clean design
- `docs/superpowers/specs/2026-03-21-winning-decks-by-color-design.md` - Winning decks by color design
- `docs/superpowers/specs/2026-03-23-server-side-oracle-search-design.md` - Server-side oracle search design

Add these missing **plans** to the Superpowers Plans section:
- `docs/superpowers/plans/2026-03-21-deep-clean-fixes.md` - Deep clean fixes (prior audit)
- `docs/superpowers/plans/2026-03-23-server-side-oracle-search.md` - Server-side oracle search implementation
- `docs/superpowers/plans/2026-03-26-live-draft-e2e-feedback.md` - Live draft e2e feedback fixes
- `docs/superpowers/plans/2026-03-26-live-draft-gap-closure.md` - Live draft gap closure
- `docs/superpowers/plans/2026-03-27-deep-clean-fixes.md` - Deep clean fixes (this audit)

- [ ] **Step 7: Update search description**

Add note that server-side search also exists via `/api/cards/search`.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with missing modules, e2e testing, and correct paths"
```

---

## Chunk 6: Final Verification

### Task 17: Run full precommit and verify

- [ ] **Step 1: Run precommit**

Run: `cd /Users/arpanet/dev/read-the-bones && pnpm precommit`

All checks (typecheck, lint, knip, tests) must pass. E2e may fail due to sandbox network restrictions (Google Fonts) — that's expected.

- [ ] **Step 2: Fix any failures**

If any check fails, fix the issue and re-run.

---

## Not Addressed (Deferred)

These findings were reviewed but intentionally left for future work:

| # | Finding | Reason |
|---|---------|--------|
| A1 | `PageClient.tsx` is 768 lines | Large refactor — warrants its own dedicated plan |
| A2 | Live-draft routes use inline SQL | Requires migrating 3 routes to query layer — significant scope |
| A3 | `getCards.ts` is 469-line monolith | Complex refactor — warrants its own plan |
| A4 | `core/sync.ts` imports from `build/scryfall.ts` | Moving Scryfall API functions would touch many files across sync pipeline |
| A7 | `stats.ts` is 814 lines | File split warrants its own plan |
| A8 | Inconsistent query param names (`drafts` vs `draft_ids`) | Breaking API change — needs migration strategy |
| S3 | Token via query param logged in access logs | Removing query param support would break existing links |
| S5 | Localhost check via Host header is spoofable | Low-risk for personal tool; fixing requires auth infrastructure |
| P4 | `resolveCardFuzzy` cascading queries | Complex optimization — could use UNION ALL approach but needs careful testing |
| P5 | `getCards` loads entire DB per SSR request | Needs caching strategy design (separate spec) |
| Q7 | CardTable uses 12 useRef wrappers | Pragmatic pattern for TanStack Table — extracting `useLatest` is low value |
| T1 | Multiple production modules have no tests | Coverage expansion — tracked separately |
| T2 | `processPick` auto-pick cascade untested | Requires complex test setup with mock cascade |
| T3 | `cubecobra.test.ts` missing HTTP fetch test | Requires network mocking |
| T4 | Tests use `setTimeout` instead of `waitFor` | Low-priority test cleanup |
| T5 | Tests assert on SQL strings | Implementation coupling — acceptable for now |
| D13 | Three undocumented utility scripts | Low-priority — scripts are for maintenance |
