/**
 * Tooltip component that shows a "?" icon with hover-revealed tooltip text.
 */
export function InfoTooltip({
  text,
  align = "left",
}: {
  text: string;
  align?: "left" | "right";
}) {
  return (
    <div className="group relative ml-1 inline-block">
      <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-zinc-200 text-xs text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
        ?
      </span>
      <div
        className={`absolute top-6 z-50 hidden w-72 rounded-lg bg-zinc-800 p-3 text-xs leading-relaxed whitespace-pre-line text-white shadow-xl group-hover:block dark:bg-zinc-900 ${
          align === "right" ? "right-0" : "-left-32"
        }`}
      >
        {text}
        <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-zinc-800 dark:bg-zinc-900" />
      </div>
    </div>
  );
}
