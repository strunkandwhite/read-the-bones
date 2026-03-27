# Inline Name Editing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow players to edit their display name inline in the draft board column headers.

**Architecture:** New `InlineEditableName` component replaces plain text in `DraftBoardMatrix` column headers. The `useMySeat` hook exposes `updateDisplayName` which calls the existing `PUT /api/drafts/{id}/seat-settings` endpoint. The callback threads through `DraftBoardModal` → `DraftBoardMatrix` via a new `onUpdateDisplayName` prop.

**Tech Stack:** React 19, TypeScript, Vitest, React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-27-inline-name-editing-design.md`

---

## Chunk 1: Hook and Component

### Task 1: Add `updateDisplayName` to `useMySeat` hook

**Files:**
- Modify: `src/app/hooks/useMySeat.ts`
- Modify: `src/app/hooks/useMySeat.test.ts`

- [ ] **Step 1: Write failing test for successful updateDisplayName**

Add to `src/app/hooks/useMySeat.test.ts`:

```typescript
it("updateDisplayName sends PUT and updates state", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seat: 1, autoPick: true, displayName: "Bob" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

  const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

  await waitFor(() => expect(result.current.mySeat).toBe(1));
  expect(result.current.displayName).toBe("Bob");

  await act(async () => {
    await result.current.updateDisplayName("Alice");
  });

  expect(result.current.displayName).toBe("Alice");

  expect(globalThis.fetch).toHaveBeenCalledWith(
    "/api/drafts/test-draft/seat-settings",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ display_name: "Alice" }),
    }),
  );
});
```

- [ ] **Step 2: Write failing test for failed updateDisplayName**

Add to `src/app/hooks/useMySeat.test.ts`:

```typescript
it("updateDisplayName does not update state on failed PUT", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seat: 1, autoPick: true, displayName: "Bob" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "fail" }), { status: 500 }),
    );

  const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

  await waitFor(() => expect(result.current.mySeat).toBe(1));

  await act(async () => {
    await result.current.updateDisplayName("Alice");
  });

  expect(result.current.displayName).toBe("Bob");
});
```

- [ ] **Step 3: Write failing test for clearing display name**

Add to `src/app/hooks/useMySeat.test.ts`:

```typescript
it("updateDisplayName clears name when given empty string", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seat: 1, autoPick: true, displayName: "Bob" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

  const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

  await waitFor(() => expect(result.current.mySeat).toBe(1));

  await act(async () => {
    await result.current.updateDisplayName("");
  });

  expect(result.current.displayName).toBeNull();

  expect(globalThis.fetch).toHaveBeenCalledWith(
    "/api/drafts/test-draft/seat-settings",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ display_name: "" }),
    }),
  );
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test src/app/hooks/useMySeat.test.ts`
Expected: 3 new tests FAIL (updateDisplayName not in return type)

- [ ] **Step 5: Implement `updateDisplayName` in `useMySeat`**

In `src/app/hooks/useMySeat.ts`:

1. Add `updateDisplayName` to `UseMySeatReturn`:

```typescript
interface UseMySeatReturn {
  mySeat: number | null;
  autoPick: boolean;
  displayName: string | null;
  toggleAutoPick: () => Promise<void>;
  updateDisplayName: (name: string) => Promise<void>;
}
```

2. Add the callback after `toggleAutoPick`:

```typescript
const updateDisplayName = useCallback(async (name: string) => {
  if (!draftId || !token) return;
  const previous = displayName;
  const newValue = name || null;
  setDisplayName(newValue);
  try {
    const res = await fetch(`/api/drafts/${draftId}/seat-settings`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Seat-Token": token,
      },
      body: JSON.stringify({ display_name: name }),
    });
    if (!res.ok) setDisplayName(previous);
  } catch {
    setDisplayName(previous);
  }
}, [draftId, token, displayName]);
```

3. Add `updateDisplayName` to the return object.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/app/hooks/useMySeat.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/hooks/useMySeat.ts src/app/hooks/useMySeat.test.ts
git commit -m "feat: add updateDisplayName to useMySeat hook"
```

---

### Task 2: Create `InlineEditableName` component

**Files:**
- Create: `src/app/components/draft-board/InlineEditableName.tsx`
- Create: `src/app/components/draft-board/InlineEditableName.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/app/components/draft-board/InlineEditableName.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineEditableName } from "./InlineEditableName";

describe("InlineEditableName", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders current name as text when not editable", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders current name as text when editable but not editing", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("enters edit mode on click when editable", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Alice");
  });

  it("does not enter edit mode on click when not editable", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={false}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("saves on Enter", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Bob"));
  });

  it("cancels on Escape and reverts to original value", () => {
    const onSave = vi.fn();
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    // Should exit edit mode and show original text
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("saves on blur", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.blur(input);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Bob"));
  });

  it("does not call onSave when value unchanged", () => {
    const onSave = vi.fn();
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("calls onSave with empty string to clear name", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(""));
  });

  it("enforces 50 character max length", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.maxLength).toBe(50);
  });

  it("reverts display on save failure", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("fail"));
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
  });

  it("shows fallback 'Seat N' when currentName matches fallback pattern and cleared", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditableName
        currentName="Seat 3"
        seatNumber={3}
        isEditable={true}
        onSave={onSave}
      />,
    );
    expect(screen.getByText("Seat 3")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/components/draft-board/InlineEditableName.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `InlineEditableName`**

Create `src/app/components/draft-board/InlineEditableName.tsx`:

```tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface InlineEditableNameProps {
  currentName: string;
  seatNumber: number;
  isEditable: boolean;
  onSave: (name: string) => Promise<void>;
}

export function InlineEditableName({
  currentName,
  seatNumber,
  isEditable,
  onSave,
}: InlineEditableNameProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(currentName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Keep editValue in sync when currentName changes externally (polling)
  useEffect(() => {
    if (!isEditing) setEditValue(currentName);
  }, [currentName, isEditing]);

  const handleSave = useCallback(async () => {
    const trimmed = editValue.trim();
    setIsEditing(false);

    // No change: name is same, or clearing when already at fallback
    if (trimmed === currentName) return;
    if (trimmed === "" && currentName === `Seat ${seatNumber}`) return;

    try {
      await onSave(trimmed);
    } catch {
      setEditValue(currentName);
    }
  }, [editValue, currentName, seatNumber, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        setEditValue(currentName);
        setIsEditing(false);
      }
    },
    [handleSave, currentName],
  );

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleSave}
        maxLength={50}
        style={{
          background: "transparent",
          border: "1px solid rgba(59,130,246,0.4)",
          borderRadius: "3px",
          color: "inherit",
          font: "inherit",
          textAlign: "center",
          width: "100%",
          padding: "1px 4px",
          outline: "none",
        }}
      />
    );
  }

  return (
    <span
      onClick={isEditable ? () => setIsEditing(true) : undefined}
      style={{
        cursor: isEditable ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      {currentName}
      {isEditable && (
        <span style={{ fontSize: "9px" }} className="pencil-icon">
          ✎
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/components/draft-board/InlineEditableName.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/components/draft-board/InlineEditableName.tsx src/app/components/draft-board/InlineEditableName.test.tsx
git commit -m "feat: add InlineEditableName component for draft board headers"
```

---

## Chunk 2: Integration

### Task 3: Wire `InlineEditableName` into `DraftBoardMatrix` and `DraftBoardModal`

**Files:**
- Modify: `src/app/components/draft-board/DraftBoardMatrix.tsx:13-18,126`
- Modify: `src/app/components/draft-board/DraftBoardModal.tsx:10-19,150-155`
- Modify: `src/app/components/PageClient.tsx:166,600-610`

- [ ] **Step 1: Add `onUpdateDisplayName` prop to `DraftBoardMatrixProps`**

In `src/app/components/draft-board/DraftBoardMatrix.tsx`:

1. Add import at top:

```typescript
import { InlineEditableName } from "./InlineEditableName";
```

2. Add prop to interface:

```typescript
interface DraftBoardMatrixProps {
  board: BoardData;
  mySeat: number | null;
  nextPickN: number | null;
  nextSeat: number | null;
  onUpdateDisplayName?: (name: string) => Promise<void>;
}
```

3. Destructure the new prop:

```typescript
export function DraftBoardMatrix({
  board,
  mySeat,
  nextPickN,
  nextSeat: _nextSeat,
  onUpdateDisplayName,
}: DraftBoardMatrixProps) {
```

4. Replace line 126 (`{board.seatNames[String(seat)] || \`Seat ${seat}\`}`) with:

```tsx
<InlineEditableName
  currentName={board.seatNames[String(seat)] || `Seat ${seat}`}
  seatNumber={seat}
  isEditable={mySeat === seat && !!onUpdateDisplayName}
  onSave={onUpdateDisplayName ?? (async () => {})}
/>
```

- [ ] **Step 2: Add `onUpdateDisplayName` prop to `DraftBoardModalProps`**

In `src/app/components/draft-board/DraftBoardModal.tsx`:

1. Add to interface:

```typescript
interface DraftBoardModalProps {
  board: BoardData | null;
  status: LiveDraftStatus | null;
  mySeat: number | null;
  token: string | null;
  draftId: string;
  draftName?: string;
  isOpen: boolean;
  onClose: () => void;
  onMatchReported: () => void;
  onUpdateDisplayName?: (name: string) => Promise<void>;
}
```

2. Destructure in component params:

```typescript
export function DraftBoardModal({
  board,
  status,
  mySeat,
  token,
  draftId,
  draftName,
  isOpen,
  onClose,
  onMatchReported,
  onUpdateDisplayName,
}: DraftBoardModalProps) {
```

3. Pass to `DraftBoardMatrix` (around line 150):

```tsx
<DraftBoardMatrix
  board={board}
  mySeat={mySeat}
  nextPickN={nextPick?.pickNumber ?? null}
  nextSeat={nextPick?.seat ?? null}
  onUpdateDisplayName={onUpdateDisplayName}
/>
```

- [ ] **Step 3: Wire `updateDisplayName` from `useMySeat` through `PageClient`**

In `src/app/components/PageClient.tsx`:

1. Update the destructure on line 166:

```typescript
const { mySeat, autoPick, toggleAutoPick, updateDisplayName } = useMySeat(draftSelection.activeDraft, seatToken.token);
```

2. Pass to `DraftBoardModal` (around line 600):

```tsx
<DraftBoardModal
  board={draftBoard.board}
  status={liveDraftStatus.status}
  mySeat={mySeat}
  token={seatToken.token}
  draftId={draftSelection.activeDraft}
  draftName={cardData.draftMetadata[draftSelection.activeDraft]?.name}
  isOpen={draftBoardOpen}
  onClose={() => setDraftBoardOpen(false)}
  onMatchReported={() => draftBoard.refresh()}
  onUpdateDisplayName={updateDisplayName}
/>
```

- [ ] **Step 4: Add hover CSS for pencil icon**

In `src/app/components/draft-board/DraftBoardMatrix.tsx`, add to the existing `<style>` block (around line 87):

```css
.pencil-icon { opacity: 0; transition: opacity 0.15s; }
th:hover .pencil-icon { opacity: 0.5; }
```

- [ ] **Step 5: Run all tests**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/app/components/draft-board/DraftBoardMatrix.tsx src/app/components/draft-board/DraftBoardModal.tsx src/app/components/PageClient.tsx
git commit -m "feat: wire inline name editing into draft board UI"
```

---

### Task 4: Verify knip and precommit

**Files:** None (validation only)

- [ ] **Step 1: Run knip to check for unused exports**

Run: `pnpm knip`
Expected: No new unused exports

- [ ] **Step 2: Run full precommit suite**

Run: `pnpm precommit`
Expected: All checks pass (typecheck, lint, knip, tests, e2e)

- [ ] **Step 3: Fix any issues found and commit**

If any issues, fix and commit with an appropriate message.
