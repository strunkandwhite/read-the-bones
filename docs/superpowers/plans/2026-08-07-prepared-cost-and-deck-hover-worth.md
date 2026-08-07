# Prepared-Spell Mana Cost + Deck-Builder Hover Worth/PVI Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two independent UI fixes.

1. **Card table cost column:** cards with a *prepared* spell (e.g. `Scheming Silvertongue // Sign in Blood`, mana cost `{1}{B} // {B}{B}`) currently render as `{1}{B}{B}{B}` — a 4-mana card. Only the front (creature) face is castable from hand, so only its cost should be shown.
2. **Deck-builder hover:** the hover card preview shows Pick score and GPWR. Add the worth-model Worth and PVI stats alongside them.

**Architecture:**

- (1) A new pure core module `src/core/manaCost.ts` exports `displayManaCost(card)`, which returns the front-face half of a `A // B` mana cost when the card's oracle text marks it as a prepared spell, and the cost unchanged otherwise. `CardTable`'s Cost cell calls it instead of reading `scryfall.manaCost` directly. `ManaSymbols` stays dumb (it just renders `{…}` runs).
- (2) The two worth-model formatters currently defined in `CardTable.tsx` (`formatSignedPercent`, `formatSignedZ`) move to a new shared module `src/app/components/worthFormat.ts` — mirroring the existing non-component `desireCurve.ts` in that directory — so `DeckCard` can use them without importing the heavy `CardTable`. `worthCards` is then prop-drilled `DeckBuilderPanel → DeckZone → DeckColumn → DeckCard`, matching how `cardStats` already flows, and `DeckCard` renders Worth/PVI in the existing hover stats bar.

**Tech Stack:** TypeScript, Next.js (App Router), React, Zustand, Vitest (jsdom for component tests).

## Global Constraints

- Always use `git -C /Users/arpanet/code/read-the-bones ...` for git commands — never `cd`.
- `pnpm lint` runs with `--max-warnings 0`; keep code warning-free. `pnpm knip` must stay clean (no unused exports).
- Comments sparingly — only for unintuitive behavior; never PR-context comments.
- Commit messages: why-focused, 1–2 sentences, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Don't add features beyond this plan. In particular: **do not** change how split cards (`Life // Death`), Adventures, Omens, or Rooms render their cost — only prepared cards change.

## Background for implementers

**How the data looks.** Scryfall gives multi-face cards a combined top-level `mana_cost` with a ` // ` separator, which `transformApiResponse` (`src/core/scryfallApi.ts:74`) stores verbatim on `ScryCard.manaCost`. `ManaSymbols` (`src/app/components/ManaSymbols.tsx:23`) matches `/\{[^}]+\}/g` and drops the separator entirely, so every `A // B` cost renders as one concatenated run. In the current cube 19 cards have a `//` cost; 6 of them are prepared cards:

| Card | `manaCost` | `manaValue` |
|---|---|---|
| Scheming Silvertongue // Sign in Blood | `{1}{B} // {B}{B}` | 2 |
| Emeritus of Abundance // Regrowth | `{2}{G} // {1}{G}` | 3 |
| Emeritus of Ideation // Ancestral Recall | `{3}{U}{U} // {U}` | 5 |
| Emeritus of Truce // Swords to Plowshares | `{1}{W}{W} // {W}` | 3 |
| Emeritus of Woe // Demonic Tutor | `{3}{B} // {1}{B}` | 4 |
| Skycoach Conductor // All Aboard | `{2}{U} // {U}` | 3 |

**Why prepared is special.** The back half of a prepared card is never castable from hand — you only cast a *copy* of it while the permanent is prepared. Adventures, Omens, Rooms and true split cards are all castable from hand on both halves, so their second cost is real information and is deliberately left alone here. `manaValue` is already the front-face MV for prepared cards (see table above), so the Cost column's sort accessor and the deck-builder MV columns are already correct — only the rendered symbols are wrong.

**Detecting prepared.** There is no `layout` field in our stored Scryfall JSON (`serializeScryfallEntry`, `src/core/db/ingest/serializeScryfall.ts:22`), so detection is from oracle text. Every prepared card's oracle text contains `enters prepared` or `becomes prepared`; that plus the presence of ` // ` in the cost is the signal.

**Worth data is dev-only.** `cardStore.worthCards` is populated from `/api/cards/worth`, which 404s in production (`src/app/stores/cardStore.ts:589`). `CardTable` gates its Worth/PVI columns behind `isLocalClient()`. The deck-builder hover needs no explicit gate: in production the map is empty, so the per-card lookup returns `undefined` and nothing renders. Follow `CardTable`'s value rules — skip when the row is missing, `no_data` is true, or the value is `null`.

**Existing hover bar.** `DeckCard.tsx:137-155` renders a stats bar under the portaled preview image, shown only when `pickScore != null || gpwr != null`. It is a single flex row inside a `w-[320px]`-ish portal (the image is 320px wide); adding two more stats needs wrapping.

---

### Task 1: `displayManaCost` core helper

**Files:**
- Create: `src/core/manaCost.ts`
- Test: `src/core/manaCost.test.ts`

**Interfaces:**
- Produces: `export function displayManaCost(card: Pick<ScryCard, "manaCost" | "oracleText"> | undefined): string` — returns `""` for a missing card or empty cost.
- Task 2 is the only consumer.

- [ ] **Step 1: Write the failing tests**

`src/core/manaCost.test.ts` (plain node environment, no jsdom directive needed) covering:

- Prepared card returns the front half only: `{ manaCost: "{1}{B} // {B}{B}", oracleText: "…this creature becomes prepared. (While it's prepared, …)" }` → `"{1}{B}"`.
- `enters prepared` phrasing also matches: `{ manaCost: "{2}{U} // {U}", oracleText: "Flash\nFlying, vigilance\nThis creature enters prepared. …" }` → `"{2}{U}"`.
- Split card is untouched: `{ manaCost: "{G} // {1}{B}", oracleText: "Put two 1/1 green Insect creature tokens…" }` → `"{G} // {1}{B}"`.
- Adventure is untouched: `{ manaCost: "{2}{R} // {1}{R}", oracleText: "Whenever this creature becomes the target of a spell…" }` → `"{2}{R} // {1}{R}"`.
- Single-face card is untouched: `{ manaCost: "{2}{U}{U}", oracleText: "Counter target spell." }` → `"{2}{U}{U}"`.
- Prepared text but no `//` in the cost returns the cost unchanged (defensive).
- `undefined` card → `""`; empty `manaCost` → `""`.

- [ ] **Step 2: Implement**

```ts
/** Multi-face costs are stored as "A // B"; this is Scryfall's separator. */
const FACE_SEPARATOR = " // ";

/**
 * A prepared card's second face is only ever cast as a copy off the
 * battlefield, never from hand, so its cost is not a way to cast the card.
 * Adventures, Omens, Rooms and split cards all keep both halves.
 */
const PREPARED_PATTERN = /\b(?:enters|becomes) prepared\b/i;
```

`displayManaCost` returns `""` when there is no card or no `manaCost`; otherwise, when the cost contains `FACE_SEPARATOR` and `PREPARED_PATTERN` matches `oracleText`, returns the substring before the separator; otherwise the cost unchanged.

- [ ] **Step 3: Verify** — `pnpm vitest run src/core/manaCost.test.ts`, then `pnpm typecheck && pnpm lint`.

---

### Task 2: Use `displayManaCost` in the card table

**Depends on:** Task 1.

**Files:**
- Modify: `src/app/components/CardTable.tsx` (Cost column cell, ~line 218; add the import)
- Test: `src/app/components/CardTable.test.tsx` (new describe block)

**Interfaces:**
- Consumes: `displayManaCost` from `@/core/manaCost`.
- No prop or export changes.

- [ ] **Step 1: Write the failing test**

Add a describe block to `CardTable.test.tsx` using the existing full-table render harness (virtualizer stub already in place). Render the table with two rows whose `scryfall` fields are a prepared card and an adventure, then assert on the `alt` text of the rendered mana symbol images within each row: the prepared row exposes `{1}` and `{B}` only (two symbols), the adventure row keeps all four. `ManaSymbols` sets `alt={sym}`, so `getAllByAltText` / querying `img[alt]` inside the row is the assertion surface.

- [ ] **Step 2: Implement**

Change the Cost cell to:

```tsx
cell: ({ row }) => <ManaSymbols cost={displayManaCost(row.original.scryfall)} />,
```

Leave the accessor (`row.scryfall?.manaValue ?? 0`) alone — MV is already front-face correct.

- [ ] **Step 3: Verify** — `pnpm vitest run src/app/components/CardTable.test.tsx`, then `pnpm typecheck && pnpm lint`.

---

### Task 3: Extract worth formatters into a shared module

**Files:**
- Create: `src/app/components/worthFormat.ts`
- Modify: `src/app/components/CardTable.tsx` (delete the two function definitions, import them instead)
- Modify: `src/app/components/CardStatsModal.tsx:21-22` (import from the new module)
- Modify: `src/app/components/CardTable.test.tsx` / `CardStatsModal.test.tsx` only if they import the formatters by path

**Interfaces:**
- Produces: `export function formatSignedPercent(value: number): string` and `export function formatSignedZ(value: number): string`, moved verbatim (bodies and doc comments unchanged) from `CardTable.tsx:55-72`.
- `CardTable.tsx` must no longer re-export them — knip flags unused re-exports.
- Task 4 consumes this module.

- [ ] **Step 1: Move the functions**

Create `src/app/components/worthFormat.ts` with a short module doc comment ("Display formatting for worth-model values, shared by the card table, stats modal, and deck builder.") and the two functions copied verbatim. Delete them from `CardTable.tsx` and add `import { formatSignedPercent, formatSignedZ } from "./worthFormat";` — `formatSignedPercent` is still referenced as the default argument of `renderWorthModelValue`, and `formatSignedZ` at the PVI cell. Update the `CardStatsModal.tsx` import to `./worthFormat`.

- [ ] **Step 2: Verify** — `pnpm typecheck && pnpm lint && pnpm knip`, then `pnpm vitest run src/app/components`. No behavior change; no new tests.

---

### Task 4: Worth and PVI in the deck-builder hover

**Depends on:** Task 3.

**Files:**
- Modify: `src/app/components/deck-builder/DeckBuilderPanel.tsx:64` (read `worthCards` from the store; pass to both `DeckZone`s at ~lines 291 and 302)
- Modify: `src/app/components/deck-builder/DeckZone.tsx` (new prop, pass through to `DeckColumn`)
- Modify: `src/app/components/deck-builder/DeckColumn.tsx` (new prop; look the card up and pass the value down)
- Modify: `src/app/components/deck-builder/DeckCard.tsx` (new props; render in the hover stats bar)
- Test: `src/app/components/deck-builder/DeckCard.test.tsx` (new file, `// @vitest-environment jsdom`)

**Interfaces:**
- `DeckZoneProps` / `DeckColumnProps` gain `worthCards: Map<string, WorthCard>` (required, alongside `cardStats`).
- `DeckCardProps` gains `worth?: number` and `pvi?: number` — plain numbers, already filtered by `DeckColumn`, so `DeckCard` stays presentational and needs no `WorthCard` import.
- `DeckColumn` computes them as: `const worthCard = worthCards.get(name); const showWorth = worthCard != null && !worthCard.no_data;` then passes `worth={showWorth ? worthCard.worth ?? undefined : undefined}` and `pvi={showWorth ? worthCard.pvi ?? undefined : undefined}`.

- [ ] **Step 1: Write the failing tests**

`DeckCard.test.tsx` renders `DeckCard` inside a `DndContext` + `SortableContext` (dnd-kit's `useSortable` requires them), fires `mouseEnter` on the card, and asserts against the portaled hover bar:

- With `worth={0.047}` and `pvi={1.63}`: `Worth` and `+4.7%` render, `PVI` and `+1.6σ` render.
- With both undefined but `pickScore` set: no `Worth` / `PVI` text, and the bar still renders with the Pick stat.
- With only `worth` set and no `pickScore`/`gpwr`: the bar renders (the visibility condition must include the new stats).

- [ ] **Step 2: Implement**

In `DeckCard.tsx`, import the formatters from `../worthFormat`, widen the bar's visibility condition to `pickScore != null || gpwr != null || worth != null || pvi != null`, let the bar wrap (`flex-wrap gap-x-3 gap-y-1` in place of `gap-3`, with `max-w-[320px]` so it never exceeds the preview image), and append two spans styled exactly like the existing ones:

```tsx
{worth != null && (
  <span className="text-zinc-400">
    Worth <span className="font-mono font-semibold text-zinc-100">{formatSignedPercent(worth)}</span>
  </span>
)}
{pvi != null && (
  <span className="text-zinc-400">
    PVI <span className="font-mono font-semibold text-zinc-100">{formatSignedZ(pvi)}</span>
  </span>
)}
```

Then thread `worthCards` down from `DeckBuilderPanel` (`useCardStore((s) => s.worthCards)`) through `DeckZone` to `DeckColumn`.

- [ ] **Step 3: Verify** — `pnpm vitest run src/app/components/deck-builder`, then `pnpm typecheck && pnpm lint && pnpm knip`.

---

### Task 5: Full verification

- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`
- [ ] `pnpm dev`, open the card table, confirm Scheming Silvertongue shows `{1}{B}` and Bonecrusher Giant still shows all four symbols; open the deck builder on a seat and hover a card to confirm Worth/PVI appear next to Pick/GPWR (localhost only). Kill the dev server afterwards.
- [ ] Note in `todo.md`: split/Adventure/Omen/Room costs still render as one concatenated symbol run with no `//` separator, which is misleading for the other 13 multi-face cards in the cube.
