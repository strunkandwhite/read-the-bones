# Card Link Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render card names in LLM chat responses as hoverable links that show card images on hover.

**Architecture:** LLM outputs `[[Card Name]]` syntax → client parses with regex → renders `CardLink` component → resolves image URL from local data or Scryfall fallback → shows hover preview.

**Tech Stack:** React, ReactMarkdown with rehype-raw, Next.js Image component, Scryfall API

---

### Task 1: Add rehype-raw Dependency

**Files:**
- Modify: `package.json`

**Step 1: Install rehype-raw**

Run:
```bash
pnpm add rehype-raw
```

**Step 2: Verify installation**

Run:
```bash
grep rehype-raw package.json
```
Expected: `"rehype-raw": "^X.X.X"`

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add rehype-raw for HTML passthrough in markdown"
```

---

### Task 2: Create useCardImage Hook

**Files:**
- Create: `src/app/hooks/useCardImage.ts`
- Create: `src/app/hooks/useCardImage.test.ts`

**Step 1: Write the failing test**

Create `src/app/hooks/useCardImage.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCardImage } from "./useCardImage";

// Mock the card data context
vi.mock("../components/CardDataProvider", () => ({
  useCardData: () => ({
    cards: [
      {
        cardName: "Lightning Bolt",
        scryfall: { imageUri: "https://cards.scryfall.io/normal/bolt.jpg" },
      },
      {
        cardName: "Counterspell",
        scryfall: { imageUri: "https://cards.scryfall.io/normal/counter.jpg" },
      },
    ],
  }),
}));

describe("useCardImage", () => {
  it("returns image URL for card in local data", () => {
    const { result } = renderHook(() => useCardImage("Lightning Bolt"));
    expect(result.current).toBe("https://cards.scryfall.io/normal/bolt.jpg");
  });

  it("matches card names case-insensitively", () => {
    const { result } = renderHook(() => useCardImage("lightning bolt"));
    expect(result.current).toBe("https://cards.scryfall.io/normal/bolt.jpg");
  });

  it("strips numeric suffixes from card names", () => {
    const { result } = renderHook(() => useCardImage("Lightning Bolt 2"));
    expect(result.current).toBe("https://cards.scryfall.io/normal/bolt.jpg");
  });

  it("returns Scryfall fallback URL for unknown cards", () => {
    const { result } = renderHook(() => useCardImage("Unknown Card"));
    expect(result.current).toBe(
      "https://api.scryfall.com/cards/named?exact=Unknown%20Card&format=image"
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
pnpm test src/app/hooks/useCardImage.test.ts
```
Expected: FAIL with "Cannot find module './useCardImage'"

**Step 3: Write minimal implementation**

Create `src/app/hooks/useCardImage.ts`:

```typescript
import { useCardData } from "../components/CardDataProvider";

/**
 * Resolve a card name to its image URL.
 * Checks local card data first, falls back to Scryfall API.
 */
export function useCardImage(cardName: string): string | null {
  const { cards } = useCardData();

  // Normalize: strip numeric suffixes like "Scalding Tarn 2"
  const normalized = cardName.replace(/\s+\d+$/, "").trim();

  // Check local data (case-insensitive)
  const card = cards.find(
    (c) => c.cardName.toLowerCase() === normalized.toLowerCase()
  );

  if (card?.scryfall?.imageUri) {
    return card.scryfall.imageUri;
  }

  // Fallback: Scryfall direct image URL
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(normalized)}&format=image`;
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
pnpm test src/app/hooks/useCardImage.test.ts
```
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/app/hooks/useCardImage.ts src/app/hooks/useCardImage.test.ts
git commit -m "feat: add useCardImage hook for image URL resolution"
```

---

### Task 3: Create CardLink Component

**Files:**
- Create: `src/app/components/CardLink.tsx`

**Step 1: Create the component**

Create `src/app/components/CardLink.tsx`:

```tsx
"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import { useCardImage } from "../hooks/useCardImage";

interface CardLinkProps {
  name: string;
}

/**
 * Inline card name with hover preview.
 * Renders as styled text that shows the full card image on hover.
 */
export function CardLink({ name }: CardLinkProps) {
  const imageUrl = useCardImage(name);
  const [showPreview, setShowPreview] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  const handleMouseEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      // Position image to the right of the text, clamped to viewport
      const left = Math.min(rect.right + 8, window.innerWidth - 340);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 480));
      setPosition({ top, left });
    }
    setShowPreview(true);
  };

  return (
    <span
      ref={ref}
      className="cursor-help underline decoration-dotted decoration-zinc-400 dark:decoration-zinc-500"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setShowPreview(false)}
    >
      {name}
      {showPreview && imageUrl && (
        <span
          className="fixed z-50"
          style={{ top: position.top, left: position.left }}
        >
          <Image
            src={imageUrl}
            alt={name}
            width={320}
            height={448}
            className="rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-800"
            unoptimized // Scryfall images are external
          />
        </span>
      )}
    </span>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run:
```bash
pnpm tsc --noEmit
```
Expected: No errors

**Step 3: Commit**

```bash
git add src/app/components/CardLink.tsx
git commit -m "feat: add CardLink component with hover preview"
```

---

### Task 4: Integrate CardLink with ReactMarkdown

**Files:**
- Modify: `src/app/components/QueryBox.tsx`

**Step 1: Add imports and helper function**

In `src/app/components/QueryBox.tsx`, add after existing imports:

```tsx
import rehypeRaw from "rehype-raw";
import { CardLink } from "./CardLink";

/**
 * Replace [[Card Name]] with card-link HTML elements.
 */
function processCardLinks(text: string): string {
  return text.replace(
    /\[\[([^\]]+)\]\]/g,
    '<card-link name="$1">$1</card-link>'
  );
}
```

**Step 2: Update ReactMarkdown configuration**

Find this line (around line 202):
```tsx
<ReactMarkdown>{message.content}</ReactMarkdown>
```

Replace with:
```tsx
<ReactMarkdown
  rehypePlugins={[rehypeRaw]}
  components={{
    "card-link": ({ node, ...props }) => (
      <CardLink
        name={(props as { name?: string }).name ?? ""}
      />
    ),
  }}
>
  {processCardLinks(message.content)}
</ReactMarkdown>
```

**Step 3: Verify build succeeds**

Run:
```bash
pnpm build
```
Expected: Build completes without errors

**Step 4: Commit**

```bash
git add src/app/components/QueryBox.tsx
git commit -m "feat: integrate CardLink with ReactMarkdown in QueryBox"
```

---

### Task 5: Update LLM System Prompts

**Files:**
- Modify: `src/cli/explorePrompt.ts`
- Modify: `src/app/api/chat/route.ts`

**Step 1: Add card formatting instruction to CLI prompt**

In `src/cli/explorePrompt.ts`, find the `OUTPUT FORMAT` section and add before it:

```
CARD NAME FORMATTING

Wrap Magic card names in double brackets: [[Lightning Bolt]], [[Counterspell]].
This enables hover previews for readers. Use exact card names as they appear in the database.
```

**Step 2: Add card formatting instruction to web API prompt**

In `src/app/api/chat/route.ts`, add a new section before `## Response Style`:

```
## Card Name Formatting
Wrap Magic card names in double brackets: [[Lightning Bolt]], [[Counterspell]]. This enables hover previews.
```

**Step 3: Run existing prompt tests**

Run:
```bash
pnpm test src/cli/explorePrompt.test.ts
```
Expected: PASS

**Step 4: Commit**

```bash
git add src/cli/explorePrompt.ts src/app/api/chat/route.ts
git commit -m "feat: add card name bracket syntax to LLM prompts"
```

---

### Task 6: Manual Integration Test

**Step 1: Start dev server**

Run:
```bash
pnpm dev
```

**Step 2: Test card link rendering**

Open browser to `http://localhost:3000`. In the chat box, type:
> "What cards did the winner draft in the most recent draft?"

**Step 3: Verify behavior**

Expected:
- Response contains card names in `[[brackets]]`
- Card names render with dotted underline
- Hovering shows card image preview
- Image positioned correctly (doesn't overflow viewport)

**Step 4: Stop dev server**

Press Ctrl+C to stop the server.

---

### Task 7: Final Commit and Summary

**Step 1: Run full test suite**

Run:
```bash
pnpm test
```
Expected: All tests pass

**Step 2: Run linter**

Run:
```bash
pnpm lint
```
Expected: No errors

**Step 3: Create summary commit if any uncommitted changes**

```bash
git status
# If clean, skip this step
```

---

## Files Summary

**Created:**
- `src/app/hooks/useCardImage.ts` - Image URL resolution hook
- `src/app/hooks/useCardImage.test.ts` - Hook tests
- `src/app/components/CardLink.tsx` - Hoverable card link component

**Modified:**
- `package.json` - Added rehype-raw dependency
- `src/app/components/QueryBox.tsx` - Markdown processing integration
- `src/cli/explorePrompt.ts` - Card bracket syntax instruction
- `src/app/api/chat/route.ts` - Card bracket syntax instruction
