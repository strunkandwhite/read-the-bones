"use client";

/**
 * Collapsible "How it works" help section shown in the Settings panel.
 * Static content — orients players on the card list, deck builder, pod view,
 * and the queue / float / auto-pick model.
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
          the cube with stats from past rotisserie drafts, and — during a live
          draft — queue and pick cards when it&apos;s your turn.
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Your seat link.</span>{" "}
          Each player gets a unique link to log in to a seat. Don&apos;t share it.
          Once you visit it, that device remembers your seat — you won&apos;t need
          the link again unless you log in somewhere else.
        </p>

        <div>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Three views:</span>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              <span className="font-medium">Card list</span> — every card in the
              cube, with stats from previous drafts and Scryfall-style search and
              filters. Click a card for details.
            </li>
            <li>
              <span className="font-medium">Deck builder</span> — the cards
              you&apos;ve picked, queued, and floated.
            </li>
            <li>
              <span className="font-medium">Pod view</span> — what everyone has
              picked. Pick from here on your turn, and manage your queue.
            </li>
          </ul>
        </div>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Auto-pick.</span>{" "}
          Toggle it on and, when your turn comes, RTB picks the next available
          card in your queue for you.
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Queue vs. float.</span>{" "}
          A <span className="font-medium">queued</span> card will be picked on
          your turn (if auto-pick is on). A <span className="font-medium">floated</span>{" "}
          card won&apos;t — it&apos;s just a private shortlist of cards you&apos;re
          hoping to get later.
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Pause vs. flow-through.</span>{" "}
          Set on each queue entry. <span className="font-medium">Pause</span>: if
          your top choice was taken before your turn, auto-pick switches off so
          you can reassess. <span className="font-medium">Flow-through</span>: skip
          the taken card and take the next available one.
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Grouping.</span>{" "}
          Group cards to mean &ldquo;any one of these&rdquo; — e.g. three removal
          spells you&apos;d be happy with. When one card in a group is picked, the
          whole group leaves your queue.
        </p>

        <p>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Privacy.</span>{" "}
          Your picks are visible to everyone. Your queue and floats are private.
        </p>
      </div>
    </details>
  );
}
