"use client";

import { CardStatusIcon } from "./CardStatusIcon";
import { PodViewIcon, DeckBuilderIcon } from "./icons";

/**
 * Collapsible "How it works" help section shown in the Settings panel.
 * Static content that orients players on the card list, deck builder, pod view,
 * and the queue / float / auto-pick model. Reuses the same icons players see
 * in the toolbar and card table as visual cues.
 */
export function HowItWorks() {
  return (
    <details className="group mb-6">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-zinc-700 select-none dark:text-zinc-300">
        How it works
        <svg
          className="h-4 w-4 text-zinc-400 transition-transform group-open:rotate-180"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </summary>

      <div className="mt-3 space-y-3 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
        <p>
          Read the Bones is a combined draft and stats app. Browse every card in
          the cube with stats from past rotisserie drafts, and, during a live
          draft, queue and pick cards when it&apos;s your turn.
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Your seat link.</span>{" "}
          Each player gets a unique link to log in to a seat. Don&apos;t share it.
          Once you visit it, that device remembers your seat, and you won&apos;t need
          the link again unless you log in somewhere else.
        </p>

        <div>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Three views:</span>
          <ul className="mt-1.5 space-y-2 pl-1">
            <li>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Card list.</span> The
              main screen: every card in the cube, with stats from previous
              drafts. Click a card for details. Search supports Scryfall-style
              queries (e.g. <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">t:creature</code>,{" "}
              <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">c:ur</code>,{" "}
              <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">o:flying</code>). Tap the{" "}
              <span className="font-semibold">?</span> by the search box for the full syntax.
            </li>
            <li>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Pick Score (P#).</span>{" "}
              How early a card tends to get taken, pooled across past drafts;
              lower is better. A recent draft counts for more than an old one,
              and drafts sharing a date count as one session, not one per pod.
              Between drafts the score holds steady; it only moves when new
              pick data lands, whether that&apos;s a new session or a
              late-syncing pod of the current one.
            </li>
            <li className="flex gap-2">
              <DeckBuilderIcon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
              <span>
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Deck builder.</span>{" "}
                The cards you&apos;ve picked, queued, and floated; build and share
                your decklist here.
              </span>
            </li>
            <li className="flex gap-2">
              <PodViewIcon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
              <span>
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Pod view.</span>{" "}
                What everyone has picked. Pick here on your turn, manage your
                queue, and (after the draft) report match results. The icon turns
                green and pulses when it&apos;s <span className="font-medium">your pick</span>.
              </span>
            </li>
          </ul>
        </div>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Picking.</span>{" "}
          On your turn, pick a card by typing into your next slot in the pod view,
          or by opening a card and using the hold-to-confirm button (the hold
          guards against misclicks).
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Auto-pick.</span>{" "}
          Toggle it on and, when your turn comes, RTB picks the next available
          card in your queue for you.
        </p>

        <p className="flex items-start gap-2">
          <span className="mt-0.5 flex shrink-0 items-center gap-0.5">
            <CardStatusIcon status="queued" queuePosition={1} />
            <CardStatusIcon status="floated" />
          </span>
          <span>
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">Queue vs. float.</span>{" "}
            A <span className="font-medium">queued</span> card will be picked on
            your turn (if auto-pick is on), in queue order. A{" "}
            <span className="font-medium">floated</span> card won&apos;t; it&apos;s
            just a private shortlist of cards you&apos;re hoping to get later.
          </span>
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Reordering.</span>{" "}
          In the pod view&apos;s queue, drag a card to move it. Within a group, use
          the up/down arrows to reorder the cards.
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Pause vs. flow-through.</span>{" "}
          Set on each queue entry with the{" "}
          <span className="rounded bg-blue-900/50 px-1.5 py-0.5 font-semibold text-blue-300">⏸</span>{" "}
          /{" "}
          <span className="rounded bg-amber-900/50 px-1.5 py-0.5 font-semibold text-amber-300">▶</span>{" "}
          toggle. <span className="font-medium">Pause</span>: if your top choice
          was taken before your turn, auto-pick switches off so you can reassess.{" "}
          <span className="font-medium">Flow-through</span>: skip the taken card
          and take the next available one.
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Grouping.</span>{" "}
          Group cards (the <span className="font-semibold">⧉</span> button) to mean
          &ldquo;any one of these&rdquo;, such as three removal spells you&apos;d be
          happy with. Auto-pick takes the first available card in the group, and
          the rest of the group moves to your floats. If you pick one yourself,
          the others stay in your queue. Use the{" "}
          <span className="font-semibold">⏏</span> button to pull a card back out.
        </p>

        <p className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">
            <CardStatusIcon status="picked" />
          </span>
          <span>
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">Privacy.</span>{" "}
            Your picks are visible to everyone. Your queue and floats are private.
          </span>
        </p>
      </div>
    </details>
  );
}
