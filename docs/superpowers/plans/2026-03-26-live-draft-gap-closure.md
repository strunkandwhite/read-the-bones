# Live Draft Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all gaps between the live draft spec (`docs/superpowers/specs/2026-03-23-live-draft-design.md`) and the current implementation, making the live draft feature fully functional end-to-end.

**Architecture:** The live draft feature is built on snake draft order, seat tokens for auth, API routes for mutations, and polling for real-time updates. Most backend logic (processPick, snake order, token auth, API routes) is implemented correctly. The gaps are primarily in the client-side wiring: seat resolution (`mySeat`) is hardcoded to null, there's no `/drafts/[id]` page route, pick error handling is missing, match reporting doesn't pre-fill, and several UI affordances (auto-pick toggle, pick confirmation) were never built. There are also admin CLI bugs and missing tests.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, Turso (libsql), TanStack Table, Tailwind CSS 4, Vitest

**Spec reference:** `docs/superpowers/specs/2026-03-23-live-draft-design.md`

**Quality commands:**
```bash
pnpm typecheck   # TypeScript type checking
pnpm lint        # ESLint (zero warnings)
pnpm knip        # Unused exports/files
pnpm test        # Vitest
pnpm precommit   # All of the above
```

---

## Chunk 1: Critical Path — Make Live Draft Functional

These tasks fix the blockers that prevent the live draft from working at all. They should be completed first and in order.

### Task 1: Add `/api/drafts/[id]/me` Endpoint for Seat Resolution

The client needs to know which seat the current token maps to. No endpoint currently exposes this. The spec says token → seat resolution happens server-side via `seat_tokens`. Add a simple GET endpoint that accepts a token and returns the seat number.

**Note:** The existing `resolveToken()` in `src/core/db/queries/seatTokens.ts` returns `{ draftId, seat, autoPick }` but not `display_name`. Rather than duplicating the token lookup SQL, this route extends `resolveToken` to also return `displayName`, then reuses it.

**Files:**
- Modify: `src/core/db/queries/seatTokens.ts` (extend `resolveToken` return type)
- Create: `src/app/api/drafts/[id]/me/route.ts`
- Create: `src/app/api/drafts/[id]/me/route.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// src/app/api/drafts/[id]/me/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

// Mock getClient
const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

function makeRequest(url: string, headers?: Record<string, string>) {
  return new NextRequest(new URL(url, "http://localhost:3000"), { headers });
}

describe("GET /api/drafts/[id]/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns seat for valid token", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ seat: 3, auto_pick: 1, display_name: "Alice" }],
    });

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "valid-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ seat: 3, autoPick: true, displayName: "Alice" });
  });

  it("returns 401 for missing token", async () => {
    const req = makeRequest("http://localhost:3000/api/drafts/test-draft/me");
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });

    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid token", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "bad-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });

    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/app/api/drafts/\\[id\\]/me/route.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Extend `resolveToken` to return `displayName`**

In `src/core/db/queries/seatTokens.ts`, update the `resolveToken` function:

Change the return type:
```typescript
export async function resolveToken(
  client: Client,
  token: string,
): Promise<{ draftId: string; seat: number; autoPick: boolean; displayName: string | null } | null> {
```

Update the SQL to include `display_name`:
```sql
SELECT draft_id, seat, auto_pick, display_name FROM seat_tokens WHERE token = ?
```

Update the return object:
```typescript
  return {
    draftId: row.draft_id as string,
    seat: row.seat as number,
    autoPick: Boolean(row.auto_pick),
    displayName: (row.display_name as string) ?? null,
  };
```

- [ ] **Step 4: Implement the `/me` route**

```typescript
// src/app/api/drafts/[id]/me/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { extractToken } from "@/core/tokenAuth";
import { resolveToken } from "@/core/db/queries/seatTokens";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const token = extractToken(request);
    if (!token) {
      return NextResponse.json({ error: "Missing seat token" }, { status: 401 });
    }

    const client = await getClient();
    const resolved = await resolveToken(client, token);
    if (!resolved || resolved.draftId !== draftId) {
      return NextResponse.json({ error: "Invalid seat token" }, { status: 401 });
    }

    return NextResponse.json({
      seat: resolved.seat,
      autoPick: resolved.autoPick,
      displayName: resolved.displayName,
    });
  } catch (error) {
    console.error("[/api/drafts/[id]/me] Error:", error);
    return NextResponse.json({ error: "Failed to resolve seat" }, { status: 500 });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test src/app/api/drafts/\\[id\\]/me/route.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/db/queries/seatTokens.ts src/app/api/drafts/\[id\]/me/
git commit -m "Add /api/drafts/[id]/me endpoint for seat resolution, extend resolveToken"
```

---

### Task 2: Fix `mySeat` Resolution in PageClient

The `mySeat` variable at `src/app/components/PageClient.tsx:197-200` is hardcoded to `null` in both branches of a ternary. This makes `isMyTurn` always false, so the Pick button never renders and match reporting is disabled.

Fix: fetch the seat from `/api/drafts/[id]/me` when a token is available, and store the result.

**Files:**
- Create: `src/app/hooks/useMySeat.ts`
- Modify: `src/app/components/PageClient.tsx:197-203`

- [ ] **Step 1: Create the `useMySeat` hook**

```typescript
// src/app/hooks/useMySeat.ts
import { useState, useEffect } from "react";

interface UseMySeatReturn {
  mySeat: number | null;
  autoPick: boolean;
  displayName: string | null;
}

export function useMySeat(
  draftId: string | null,
  token: string | null,
): UseMySeatReturn {
  const [mySeat, setMySeat] = useState<number | null>(null);
  const [autoPick, setAutoPick] = useState(true);
  const [displayName, setDisplayName] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- fetching from API */
  useEffect(() => {
    if (!draftId || !token) {
      setMySeat(null);
      return;
    }

    let cancelled = false;

    async function fetchSeat() {
      try {
        const res = await fetch(`/api/drafts/${draftId}/me`, {
          headers: { "X-Seat-Token": token! },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) {
          setMySeat(data.seat);
          setAutoPick(data.autoPick);
          setDisplayName(data.displayName);
        }
      } catch {
        // Token invalid or network error — remain as spectator
      }
    }

    fetchSeat();
    return () => { cancelled = true; };
  }, [draftId, token]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { mySeat, autoPick, displayName };
}
```

- [ ] **Step 2: Wire `useMySeat` into PageClient**

In `src/app/components/PageClient.tsx`, add the import:

```typescript
import { useMySeat } from "../hooks/useMySeat";
```

Replace lines 197-203 (the broken `mySeat` / `isMyTurn` block):

```typescript
  // OLD (broken):
  // const mySeat = liveDraftStatus.status?.recentPicks !== undefined && seatToken.hasSeatToken
  //   ? null // Will be resolved from status/token - for now use null for spectators
  //   : null;
  // const isMyTurn = liveDraftStatus.status?.nextSeat !== null &&
  //   seatToken.hasSeatToken &&
  //   mySeat === liveDraftStatus.status?.nextSeat;

  // NEW:
  const { mySeat } = useMySeat(draftSelection.activeDraft, seatToken.token);
  const isMyTurn = mySeat !== null && liveDraftStatus.status?.nextSeat === mySeat;
```

- [ ] **Step 3: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: PASS — no type errors, no lint warnings

- [ ] **Step 4: Commit**

```bash
git add src/app/hooks/useMySeat.ts src/app/components/PageClient.tsx
git commit -m "Fix mySeat resolution — fetch seat from /me endpoint instead of hardcoded null"
```

---

### Task 3: Create `/drafts/[id]` Page Route

The spec says shareable URLs are `/drafts/<id>?token=<token>`. No page route exists — these URLs 404. Create a Next.js page route that renders the same `PageClient` component with the draft pre-selected.

**Files:**
- Create: `src/app/drafts/[id]/page.tsx`
- Modify: `src/app/components/PageClient.tsx` (add `initialDraftId` prop)
- Modify: `src/app/hooks/useDraftSelection.ts` (accept `initialDraftId`)

- [ ] **Step 1: Add `initialDraftId` prop to `PageClientProps`**

In `src/app/components/PageClient.tsx`, update the interface and function signature:

```typescript
export interface PageClientProps {
  initialCardData: CardStatsResponse;
  initialDraftStats: DraftStatsResponse;
  initialDraftId?: string;  // <-- add this
}
```

And the function:

```typescript
export function PageClient({ initialCardData, initialDraftStats, initialDraftId }: PageClientProps) {
  const draftSelection = useDraftSelection({
    completedDraftIds: initialCardData.completedDraftIds,
    initialDraftId,                   // <-- pass through
  });
```

- [ ] **Step 2: Update `useDraftSelection` to accept `initialDraftId`**

In `src/app/hooks/useDraftSelection.ts`:

Update the interface:
```typescript
interface UseDraftSelectionProps {
  completedDraftIds: string[];
  initialDraftId?: string;  // <-- add this
}
```

Update the function signature:
```typescript
export function useDraftSelection({
  completedDraftIds,
  initialDraftId,            // <-- add this
}: UseDraftSelectionProps): UseDraftSelectionReturn {
```

Update the hydration effect to prioritize `initialDraftId` over localStorage:
```typescript
  // Hydrate from localStorage after mount (avoids hydration mismatch)
  // initialDraftId (from URL route) takes priority over localStorage
  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external storage */
  useEffect(() => {
    const draftId = initialDraftId ?? localStorage.getItem("activeDraft");
    if (draftId) setActiveDraftState(draftId);
    const storedHideTaken = localStorage.getItem("hideTaken");
    if (storedHideTaken !== null) setHideTaken(storedHideTaken !== "false");
    const storedSeats = localStorage.getItem("selectedSeats");
    if (draftId && storedSeats) {
      const seatsMap = JSON.parse(storedSeats) as Record<string, number>;
      if (draftId in seatsMap) setSelectedSeatState(seatsMap[draftId]);
    }
    setHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */
```

- [ ] **Step 3: Create the page route**

```typescript
// src/app/drafts/[id]/page.tsx
import { Suspense } from "react";
import { headers } from "next/headers";
import { getCards } from "@/core/getCards";
import { getDraftStats } from "@/core/getDraftStats";
import { PageClient } from "../../components/PageClient";

interface DraftPageProps {
  params: Promise<{ id: string }>;
}

export default async function DraftPage({ params }: DraftPageProps) {
  const { id } = await params;

  const headersList = await headers();
  const host = headersList.get("host") ?? "";
  const isLocal =
    host.startsWith("localhost") || host.startsWith("127.0.0.1");

  const [data, draftStats] = await Promise.all([
    getCards({ includeMatchData: isLocal }),
    getDraftStats(),
  ]);

  return (
    <Suspense fallback={null}>
      <PageClient
        initialCardData={data}
        initialDraftStats={draftStats}
        initialDraftId={id}
      />
    </Suspense>
  );
}
```

- [ ] **Step 4: Run typecheck and dev server test**

```bash
pnpm typecheck
```

Then verify the route works manually:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/drafts/sandbox-test
```
Expected: `200` (not 404)

- [ ] **Step 5: Commit**

```bash
git add src/app/drafts/ src/app/components/PageClient.tsx src/app/hooks/useDraftSelection.ts
git commit -m "Add /drafts/[id] page route for shareable draft URLs"
```

---

### Task 4: Fix Pick Error Handling

`handlePick` in PageClient throws on error, but nothing catches the thrown error. Pick failures are silent unhandled promise rejections. Add error state and surface it to the user.

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Add pickError state and update handlePick**

In `PageClient`, add state near the other state declarations (around line 104):

```typescript
const [pickError, setPickError] = useState<string | null>(null);
```

Replace the `handlePick` callback (lines 206-220):

```typescript
  const handlePick = useCallback(async (cardName: string) => {
    if (!draftSelection.activeDraft || !seatToken.token) return;
    setPickError(null);
    try {
      const res = await fetch(`/api/drafts/${draftSelection.activeDraft}/pick`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Seat-Token": seatToken.token,
        },
        body: JSON.stringify({ card_name: cardName }),
      });
      if (!res.ok) {
        const data = await res.json();
        setPickError(data.error || "Pick failed");
      }
    } catch {
      setPickError("Network error — pick may not have been submitted");
    }
  }, [draftSelection.activeDraft, seatToken.token]);
```

- [ ] **Step 2: Render the pick error banner**

Add this just before the `{/* Card Table */}` comment (around line 570):

```tsx
        {pickError && (
          <div className="mb-2 flex items-center justify-between rounded-md border border-red-800/50 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            <span>{pickError}</span>
            <button
              onClick={() => setPickError(null)}
              className="ml-2 text-red-400 hover:text-red-200"
            >
              &times;
            </button>
          </div>
        )}
```

- [ ] **Step 3: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Surface pick errors to user instead of silent unhandled rejections"
```

---

### Task 5: Fix `draft:admin enter-match` Bugs

Two bugs in `scripts/draft-admin.ts`:
1. Uses `INSERT` instead of `INSERT OR REPLACE` — fails if match already exists.
2. Doesn't normalize seat order (seat1 should be < seat2).

**Files:**
- Modify: `scripts/draft-admin.ts:231-237`

- [ ] **Step 1: Fix the enter-match function**

Replace lines 231-237:

```typescript
  // Normalize seat order: seat1 < seat2, rearranging wins accordingly
  let [seat1, seat2] = seatParts;
  let [seat1Wins, seat2Wins] = winParts;
  if (seat1 > seat2) {
    [seat1, seat2] = [seat2, seat1];
    [seat1Wins, seat2Wins] = [seat2Wins, seat1Wins];
  }

  await client.execute({
    sql: "INSERT OR REPLACE INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins) VALUES (?, ?, ?, ?, ?)",
    args: [draftId, seat1, seat2, seat1Wins, seat2Wins],
  });
```

- [ ] **Step 2: Verify with typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add scripts/draft-admin.ts
git commit -m "Fix enter-match: normalize seat order and use INSERT OR REPLACE"
```

---

### Task 6: Fix `draft:create-live` Bugs

Two bugs discovered during E2E testing:
1. Tries to re-insert cube snapshot cards when snapshot already exists (UNIQUE constraint failure).
2. Missing `import_hash` column value in INSERT (NOT NULL constraint failure — column exists in live DB but isn't in the schema file).

**Files:**
- Verify: `scripts/draft-create-live.ts` (these fixes were already applied earlier in the session)

- [ ] **Step 1: Verify the fixes are in place**

Check that the file contains:
1. `isNewSnapshot` flag that skips card insertion when snapshot exists
2. `import_hash` in the INSERT statement with empty string value

```bash
grep -n "isNewSnapshot" scripts/draft-create-live.ts
grep -n "import_hash" scripts/draft-create-live.ts
```

If either is missing, apply the fixes from the audit session. The exact changes are:
- Track `isNewSnapshot = snapshotResult.rowsAffected > 0` and wrap card insertion in `if (isNewSnapshot)`
- Add `import_hash` to the drafts INSERT column list with `''` as the value

- [ ] **Step 2: Commit if not already committed**

```bash
git add scripts/draft-create-live.ts
git commit -m "Fix draft:create-live — reuse existing cube snapshots, include import_hash"
```

---

## Chunk 2: UI Completeness — Match Reporting, Auto-Pick Toggle, Pick Confirmation

### Task 7: Pre-fill Existing Match Results in MatchReporting

The spec says completed matches should show display-only text. Currently, `MatchReporting` initializes all inputs blank — a player who already reported some matches sees them as unreported.

**Files:**
- Modify: `src/core/db/queries/picks.ts` (add `matches` to `StandingsResult`)
- Modify: `src/app/components/draft-board/MatchReporting.tsx`

- [ ] **Step 1: Add raw match data to `getStandings` response**

The `getStandings` function in `src/core/db/queries/picks.ts` already fetches all match rows but only returns aggregated stats. Add the raw matches to the response so the client can pre-fill inputs.

Update the `StandingsResult` interface (around line 256):

```typescript
export interface MatchRecord {
  seat1: number;
  seat2: number;
  seat1Wins: number;
  seat2Wins: number;
}

export interface StandingsResult {
  standings: StandingsEntry[];
  matches: MatchRecord[];
  redacted_seats?: number[];
}
```

In the `getStandings` function body, after the `result` query (around line 276), build the matches array from the same query result. Add this before the aggregation loop:

```typescript
  const matches: MatchRecord[] = result.rows.map((row) => ({
    seat1: row.seat1 as number,
    seat2: row.seat2 as number,
    seat1Wins: row.seat1_wins as number,
    seat2Wins: row.seat2_wins as number,
  }));
```

Update the return statement (around line 345) to include `matches`:

```typescript
  return {
    standings,
    matches,
    ...(redactedSeatsInResult.size > 0 && {
      redacted_seats: Array.from(redactedSeatsInResult).sort((a, b) => a - b),
    }),
  };
```

- [ ] **Step 2: Add `useEffect` import and fetch existing results in MatchReporting**

In `src/app/components/draft-board/MatchReporting.tsx`, add `useEffect` to the import:

```typescript
import { useState, useCallback, useEffect } from "react";
```

After the `useState` for `inputs` (line 41), add:

```typescript
  // Pre-fill inputs from existing match results
  useEffect(() => {
    async function fetchExisting() {
      try {
        const res = await fetch(`/api/drafts/${draftId}/standings`);
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.matches)) return;

        setInputs((prev) => {
          const updated = { ...prev };
          for (const match of data.matches) {
            const isSeat1 = match.seat1 === mySeat;
            const isSeat2 = match.seat2 === mySeat;
            if (!isSeat1 && !isSeat2) continue;

            const opponent = isSeat1 ? match.seat2 : match.seat1;
            const myWins = isSeat1 ? match.seat1Wins : match.seat2Wins;
            const myLosses = isSeat1 ? match.seat2Wins : match.seat1Wins;

            if (opponent in updated) {
              updated[opponent] = {
                ...updated[opponent],
                wins: String(myWins),
                losses: String(myLosses),
                saved: true,
              };
            }
          }
          return updated;
        });
      } catch { /* ignore */ }
    }

    fetchExisting();
  }, [draftId, mySeat]);

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add src/core/db/queries/picks.ts src/app/components/draft-board/MatchReporting.tsx
git commit -m "Pre-fill existing match results in match reporting UI"
```

---

### Task 8: Add Auto-Pick Toggle UI

The spec says players can toggle auto-pick on/off. The `PUT /api/drafts/[id]/seat-settings` API exists but has no UI.

**Files:**
- Modify: `src/app/components/PageClient.tsx`
- Modify: `src/app/hooks/useMySeat.ts` (from Task 2 — add toggle function)

- [ ] **Step 1: Add toggle function to `useMySeat`**

Update the hook to expose a `setAutoPick` function:

```typescript
// In useMySeat.ts, add to the return interface and implementation:

interface UseMySeatReturn {
  mySeat: number | null;
  autoPick: boolean;
  displayName: string | null;
  toggleAutoPick: () => Promise<void>;
}

// Inside the hook, add:
  const toggleAutoPick = useCallback(async () => {
    if (!draftId || !token) return;
    const newValue = !autoPick;
    try {
      const res = await fetch(`/api/drafts/${draftId}/seat-settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Seat-Token": token,
        },
        body: JSON.stringify({ auto_pick: newValue }),
      });
      if (res.ok) setAutoPick(newValue);
    } catch { /* ignore */ }
  }, [draftId, token, autoPick]);
```

- [ ] **Step 2: Add toggle button in PageClient toolbar**

In `PageClient.tsx`, add the toggle near the Draft Board button (inside the `{draftSelection.activeDraft && ...}` block). Only show when the user has a seat token:

```tsx
            {mySeat !== null && (
              <button
                onClick={toggleAutoPick}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  autoPick
                    ? "text-emerald-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
                title={autoPick ? "Auto-pick is ON — queued cards will be picked automatically" : "Auto-pick is OFF — you must confirm each pick"}
              >
                Auto-pick: {autoPick ? "ON" : "OFF"}
              </button>
            )}
```

Destructure `autoPick` and `toggleAutoPick` from `useMySeat`:
```typescript
  const { mySeat, autoPick, toggleAutoPick } = useMySeat(draftSelection.activeDraft, seatToken.token);
```

- [ ] **Step 3: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 4: Commit**

```bash
git add src/app/hooks/useMySeat.ts src/app/components/PageClient.tsx
git commit -m "Add auto-pick toggle button in toolbar"
```

---

### Task 9: Add Pick Confirmation Step

The spec says clicking "Pick" should show a confirmation step. Currently it fires immediately with no undo possibility.

**Files:**
- Modify: `src/app/components/CardTable.tsx:185-194`

- [ ] **Step 1: Add confirmation state**

The pick button currently calls `onPickRef.current!(cardName)` directly. Change it to a two-step flow: first click sets a "pending" card name, second click confirms.

Add state inside the column cell (using a local component to hold state). Replace the pick button block (lines 187-194) with:

```tsx
                    {onPickRef.current && isMyTurnRef.current && (
                      <PickButton cardName={cardName} onPick={onPickRef.current} />
                    )}
```

Define the `PickButton` component outside of `CardTable` (but in the same file, before the `CardTable` export):

```typescript
function PickButton({ cardName, onPick }: { cardName: string; onPick: (name: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Reset confirmation after 3 seconds
  useEffect(() => {
    if (confirming) {
      timeoutRef.current = setTimeout(() => setConfirming(false), 3000);
      return () => clearTimeout(timeoutRef.current);
    }
  }, [confirming]);

  if (confirming) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setConfirming(false); onPick(cardName); }}
        className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-red-500 animate-pulse"
        title="Click again to confirm pick"
      >
        Confirm
      </button>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
      className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-emerald-500"
      title="Pick this card"
    >
      Pick
    </button>
  );
}
```

Add the necessary imports at the top of `CardTable.tsx` (if not already imported): `useState`, `useEffect`, `useRef` are already imported.

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "Add pick confirmation step — click Pick, then Confirm within 3s"
```

---

## Chunk 3: Admin CLI & Minor Fixes

### Task 10: Add `reorder-seats` Admin Subcommand

The spec lists `reorder-seats` as an admin command but it was never implemented.

**Files:**
- Modify: `scripts/draft-admin.ts`

- [ ] **Step 1: Add the subcommand handler**

Add the function before the `main()` function (around line 240):

```typescript
async function reorderSeats(client: Client, draftId: string, args: string[]) {
  const orderArg = requireArg(args, "--order");
  const order = orderArg.split(",").map((s) => parseInt(s.trim(), 10));

  // Validate
  const draft = await client.execute({
    sql: "SELECT phase, num_seats FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (draft.rows.length === 0) throw new Error(`Draft not found: ${draftId}`);
  if (draft.rows[0].phase !== "setup") throw new Error("Can only reorder seats during setup phase");

  const numSeats = draft.rows[0].num_seats as number;
  if (order.length !== numSeats) throw new Error(`Expected ${numSeats} seats, got ${order.length}`);

  const sorted = [...order].sort((a, b) => a - b);
  const expected = Array.from({ length: numSeats }, (_, i) => i + 1);
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    throw new Error(`Order must be a permutation of 1-${numSeats}`);
  }

  // Reorder by updating seat numbers on seat_tokens
  // Use temporary negative seats to avoid unique constraint conflicts
  const statements = [];

  // Phase 1: move all to negative temporaries
  for (let i = 0; i < order.length; i++) {
    statements.push({
      sql: "UPDATE seat_tokens SET seat = ? WHERE draft_id = ? AND seat = ?",
      args: [-(i + 1), draftId, order[i]],
    });
  }

  // Phase 2: move from negative to final positions
  for (let i = 0; i < order.length; i++) {
    statements.push({
      sql: "UPDATE seat_tokens SET seat = ? WHERE draft_id = ? AND seat = ?",
      args: [i + 1, draftId, -(i + 1)],
    });
  }

  await client.batch(statements);

  console.log(`Reordered seats for "${draftId}": ${order.join(", ")}`);
}
```

- [ ] **Step 2: Add to the switch statement and USAGE string**

In the switch statement in `main()`, add:

```typescript
    case "reorder-seats":
      await reorderSeats(client, draftId, args);
      break;
```

Add to the USAGE string:

```
  reorder-seats <name> --order 3,1,4,2,...   Reorder seat pick positions (setup phase only)
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add scripts/draft-admin.ts
git commit -m "Add reorder-seats admin subcommand"
```

---

## Chunk 4: Tests

The live draft feature has backend logic tests (processPick, snakeDraft, seatTokens, pickQueue) but no tests for hooks or API routes.

### Task 11: API Route Tests

Write tests for the 6 live draft API routes. These follow the same pattern: mock `getClient`, call the route handler, assert response.

**Files:**
- Create: `src/app/api/drafts/[id]/status/route.test.ts`
- Create: `src/app/api/drafts/[id]/pick/route.test.ts`
- Create: `src/app/api/drafts/[id]/queue/route.test.ts`
- Create: `src/app/api/drafts/[id]/board/route.test.ts`
- Create: `src/app/api/drafts/[id]/match/route.test.ts`
- Create: `src/app/api/drafts/[id]/seat-settings/route.test.ts`

Each test file should:
1. Mock `@/core/db/client` to return a mock client with a mock `execute` function
2. Create `NextRequest` objects to simulate HTTP requests
3. Call the route handler and assert the response status and body

- [ ] **Step 1: Write status route test**

```typescript
// src/app/api/drafts/[id]/status/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

function makeRequest(url: string) {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

describe("GET /api/drafts/[id]/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns draft status with next seat", async () => {
    // Draft query
    mockExecute.mockResolvedValueOnce({
      rows: [{ phase: "drafting", num_seats: 10, picks_per_player: 5 }],
    });
    // Pick count
    mockExecute.mockResolvedValueOnce({ rows: [{ latest: 3 }] });
    // Recent picks
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Seat names
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Match count
    mockExecute.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/status"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("drafting");
    expect(body.latestPickN).toBe(3);
    expect(body.nextSeat).toBe(4); // pick 4 in round 1 = seat 4
  });

  it("returns 404 for missing draft", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/nope/status"),
      { params: Promise.resolve({ id: "nope" }) },
    );

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Write pick route test**

```typescript
// src/app/api/drafts/[id]/pick/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: vi.fn(() => Promise.resolve({ seat: 1, autoPick: true })),
}));

vi.mock("@/core/processPick", () => ({
  processPick: vi.fn(() => Promise.resolve({ picks: [{ pickN: 1, seat: 1, cardName: "Lightning Bolt" }] })),
}));

function makeRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/pick"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Seat-Token": token,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/drafts/[id]/pick", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns picks on success", async () => {
    // Card lookup
    mockExecute.mockResolvedValueOnce({ rows: [{ card_id: 42 }] });

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.picks).toHaveLength(1);
  });

  it("returns 400 for missing card_name", async () => {
    const res = await POST(
      makeRequest({}),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown card", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await POST(
      makeRequest({ card_name: "Not A Real Card" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Write tests for queue, board, match, seat-settings routes**

Follow the same pattern as above. Each test should cover:
- **queue**: GET returns queue, PUT replaces queue, 401 without token
- **board**: GET returns picks matrix, 404 for missing draft
- **match**: POST saves result, 401 without token
- **seat-settings**: PUT updates auto_pick and display_name, 401 without token

The exact test structure matches the status and pick tests above — mock `getClient`, mock auth where needed, call the handler, assert response.

- [ ] **Step 4: Run all tests**

```bash
pnpm test
```
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/app/api/drafts/\[id\]/*/route.test.ts
git commit -m "Add API route tests for all live draft endpoints"
```

---

### Task 12: Hook Tests

Write tests for the three live draft client hooks.

**Files:**
- Create: `src/app/hooks/useSeatToken.test.ts`
- Create: `src/app/hooks/usePickQueue.test.ts`
- Create: `src/app/hooks/useMySeat.test.ts`

These are React hooks that interact with `fetch`, `localStorage`, and `window.location`. Use `vitest` with `jsdom` environment and mock the browser APIs.

- [ ] **Step 1: Write useSeatToken test**

```typescript
// src/app/hooks/useSeatToken.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSeatToken } from "./useSeatToken";

describe("useSeatToken", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset URL
    window.history.replaceState({}, "", "http://localhost:3000/");
  });

  it("returns null when no draftId", () => {
    const { result } = renderHook(() => useSeatToken(null));
    expect(result.current.token).toBeNull();
    expect(result.current.hasSeatToken).toBe(false);
  });

  it("extracts token from URL and stores in localStorage", () => {
    window.history.replaceState({}, "", "http://localhost:3000/?token=abc123");
    const { result } = renderHook(() => useSeatToken("my-draft"));
    expect(result.current.token).toBe("abc123");
    expect(localStorage.getItem("seatToken:my-draft")).toBe("abc123");
  });

  it("reads token from localStorage when not in URL", () => {
    localStorage.setItem("seatToken:my-draft", "stored-token");
    const { result } = renderHook(() => useSeatToken("my-draft"));
    expect(result.current.token).toBe("stored-token");
  });
});
```

- [ ] **Step 2: Write useMySeat test**

```typescript
// src/app/hooks/useMySeat.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMySeat } from "./useMySeat";

describe("useMySeat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null seat when no draftId", () => {
    const { result } = renderHook(() => useMySeat(null, null));
    expect(result.current.mySeat).toBeNull();
  });

  it("fetches seat from /me endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ seat: 3, autoPick: true, displayName: "Alice" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

    await waitFor(() => expect(result.current.mySeat).toBe(3));
    expect(result.current.autoPick).toBe(true);
    expect(result.current.displayName).toBe("Alice");
  });

  it("stays null on failed fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid" }), { status: 401 }),
    );

    const { result } = renderHook(() => useMySeat("test-draft", "bad-token"));

    // Give it time to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.mySeat).toBeNull();
  });
});
```

- [ ] **Step 3: Write usePickQueue test**

Follow the same pattern — mock `fetch`, test that queue data is loaded and `addToQueue`/`removeFromQueue` work.

- [ ] **Step 4: Run all tests**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useSeatToken.test.ts src/app/hooks/useMySeat.test.ts src/app/hooks/usePickQueue.test.ts
git commit -m "Add hook tests for useSeatToken, useMySeat, usePickQueue"
```

---

## Chunk 5: Final Verification

### Task 13: Run Full Quality Suite

- [ ] **Step 1: Run precommit checks**

```bash
pnpm precommit
```

This runs typecheck → lint → knip → tests. All must pass.

- [ ] **Step 2: Fix any issues**

If knip reports unused exports (from new files), fix them. If lint reports warnings, fix them.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "Fix lint/knip issues from live draft gap closure"
```

---

### Task 14: E2E Smoke Test

Run the live draft E2E test from the instructions to verify the full flow works.

- [ ] **Step 1: Start dev server if not running**

```bash
pnpm dev &
```

- [ ] **Step 2: Create and start draft**

```bash
pnpm draft:reset sandbox-test 2>/dev/null; true
pnpm draft:create-live --name "sandbox-test" --date 2026-03-26 --seats 10 --picks-per-player 5 --pool cubecobra:samp
pnpm draft:start sandbox-test
```

Save the seat 1 URL for human testing. Keep seats 2-10 tokens for AI simulation.

- [ ] **Step 3: Verify the page route works**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/drafts/sandbox-test
```
Expected: `200`

- [ ] **Step 4: Verify seat resolution**

Use the seat 1 token:
```bash
curl -s http://localhost:3000/api/drafts/sandbox-test/me -H "X-Seat-Token: <seat-1-token>"
```
Expected: `{ "seat": 1, "autoPick": true, "displayName": null }`

- [ ] **Step 5: Verify status**

```bash
curl -s http://localhost:3000/api/drafts/sandbox-test/status | python3 -m json.tool
```
Expected: `phase: "drafting"`, `nextSeat: 1`, `latestPickN: 0`

- [ ] **Step 6: Submit a pick for seat 1**

```bash
curl -s -X POST http://localhost:3000/api/drafts/sandbox-test/pick \
  -H "Content-Type: application/json" \
  -H "X-Seat-Token: <seat-1-token>" \
  -d '{"card_name": "Lightning Bolt"}'
```
Expected: 200 with pick data

- [ ] **Step 7: Verify next seat advanced**

```bash
curl -s http://localhost:3000/api/drafts/sandbox-test/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Next: seat {d[\"nextSeat\"]}, pick {d[\"latestPickN\"]+1}')"
```
Expected: `Next: seat 2, pick 2`

- [ ] **Step 8: Run AI simulation for remaining picks**

Use the simulation script from `/tmp/simulate-draft.sh` (or write a new one) to auto-pick for seats 2-10 until all 50 picks complete.

- [ ] **Step 9: Visual verification**

Open `http://localhost:3000/drafts/sandbox-test?token=<seat-1-token>` in Chrome DevTools MCP:
```
mcp__chrome-devtools__navigate_page  url=http://localhost:3000/drafts/sandbox-test?token=<seat-1-token>
mcp__chrome-devtools__take_screenshot  fullPage=true
```

Verify:
- Draft board button is visible
- Card table shows queue icons
- Pick button appears when it's seat 1's turn

- [ ] **Step 10: Cleanup**

```bash
pnpm draft:admin set-phase sandbox-test --phase complete
```

---

## Scope Exclusions

The following items from the spec audit are intentionally excluded from this plan:

1. **Optimistic local update for picks** — Nice-to-have UX polish. Polling at 3s is fast enough for now. Can be added later without any schema/API changes.

2. **DraftBoardCell hover tooltip with card art/oracle text** — The basic `title=` attribute works. A rich tooltip requires building a shared component (image loading, positioning). Not blocking functionality.

3. **Pre-fill queued card when it's your turn** — Requires client-side logic to check queue against available cards on each poll. The queue already auto-picks server-side if enabled. Low priority.

4. **`useLiveDraftStatus` polling interval re-creation** — Cosmetic issue, doesn't affect correctness.

5. **E2E Playwright test file** — The manual E2E smoke test (Task 14) validates the flow. A proper Playwright test can be added separately.
