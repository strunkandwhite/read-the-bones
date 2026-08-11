/**
 * Shared toolbar icons, so the same glyphs can be reused outside the toolbar
 * (e.g. in the "How it works" help section) and stay in sync.
 */

/** Pod view — a 2×2 grid of squares. */
export function PodViewIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/** Deck builder — stacked rows. */
export function DeckBuilderIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 24 24"
      stroke="none"
      className={className}
    >
      <rect x="3" y="3" width="18" height="3" rx="0.75" />
      <rect x="3.5" y="7.75" width="18" height="3" rx="0.75" />
      <rect x="4" y="12.5" width="18" height="3" rx="0.75" />
      <rect x="4.5" y="17.25" width="18" height="3" rx="0.75" />
    </svg>
  );
}
