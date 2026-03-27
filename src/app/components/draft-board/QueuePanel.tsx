export type QueueItem = {
  cardName: string;
  position: number;
  taken?: boolean;
};

type QueuePanelProps = {
  queue: QueueItem[];
  autoPick: boolean;
  autoPickMode: "resilient" | "cautious";
  onReorder: (queue: string[]) => void;
  onRemove: (cardName: string) => void;
  onToggleAutoPick: () => void;
  onChangeAutoPickMode: (mode: "resilient" | "cautious") => void;
};

export function QueuePanel({
  queue,
  autoPick,
  autoPickMode,
  onReorder,
  onRemove,
  onToggleAutoPick,
  onChangeAutoPickMode,
}: QueuePanelProps) {
  function moveUp(index: number) {
    if (index <= 0) return;
    const names = queue.map((q) => q.cardName);
    [names[index - 1], names[index]] = [names[index], names[index - 1]];
    onReorder(names);
  }

  function moveDown(index: number) {
    if (index >= queue.length - 1) return;
    const names = queue.map((q) => q.cardName);
    [names[index], names[index + 1]] = [names[index + 1], names[index]];
    onReorder(names);
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-4">
      {/* Header with auto-pick toggle */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] font-semibold tracking-tight text-zinc-200">
          Pick Queue
        </span>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <span>Auto-pick</span>
          <input
            type="checkbox"
            checked={autoPick}
            onChange={onToggleAutoPick}
            className="cursor-pointer"
          />
        </label>
      </div>

      {/* Mode selector — only visible when auto-pick is on */}
      {autoPick && (
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => onChangeAutoPickMode("resilient")}
            className={`flex-1 cursor-pointer rounded-md border px-2.5 py-1.5 text-left text-[11px] ${
              autoPickMode === "resilient"
                ? "border-yellow-800 bg-yellow-800/20 text-amber-200"
                : "border-zinc-800/60 bg-transparent text-zinc-500"
            }`}
          >
            <div className="font-semibold">Resilient</div>
            <div className="mt-0.5 opacity-80">
              Skips taken cards, picks next available
            </div>
          </button>
          <button
            onClick={() => onChangeAutoPickMode("cautious")}
            className={`flex-1 cursor-pointer rounded-md border px-2.5 py-1.5 text-left text-[11px] ${
              autoPickMode === "cautious"
                ? "border-blue-900 bg-blue-900/20 text-blue-300"
                : "border-zinc-800/60 bg-transparent text-zinc-500"
            }`}
          >
            <div className="font-semibold">Cautious</div>
            <div className="mt-0.5 opacity-80">
              Pauses if top pick was taken
            </div>
          </button>
        </div>
      )}

      {/* Queue list */}
      {queue.length === 0 ? (
        <div className="py-5 text-center text-xs text-zinc-600">
          Queue is empty. Add cards from the card table.
        </div>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {queue.map((item, index) => (
            <li
              key={item.cardName}
              className="flex items-center gap-1.5 rounded bg-zinc-800/30 px-2 py-1 text-xs"
            >
              {/* Position number */}
              <span className="min-w-[16px] text-[11px] font-semibold text-zinc-600">
                {index + 1}.
              </span>

              {/* Card name */}
              <span
                className={`flex-1 ${item.taken ? "text-zinc-600 line-through" : "text-zinc-300"}`}
              >
                {item.cardName}
              </span>

              {/* Reorder buttons */}
              <button
                onClick={() => moveUp(index)}
                disabled={index === 0}
                aria-label={`Move up ${item.cardName}`}
                className={`border-none bg-transparent px-1 py-0.5 text-xs leading-none ${
                  index === 0
                    ? "cursor-default text-zinc-800"
                    : "cursor-pointer text-zinc-500"
                }`}
              >
                ▲
              </button>
              <button
                onClick={() => moveDown(index)}
                disabled={index === queue.length - 1}
                aria-label={`Move down ${item.cardName}`}
                className={`border-none bg-transparent px-1 py-0.5 text-xs leading-none ${
                  index === queue.length - 1
                    ? "cursor-default text-zinc-800"
                    : "cursor-pointer text-zinc-500"
                }`}
              >
                ▼
              </button>

              {/* Remove button */}
              <button
                onClick={() => onRemove(item.cardName)}
                aria-label={`Remove ${item.cardName}`}
                className="cursor-pointer border-none bg-transparent px-1 py-0.5 text-sm leading-none text-zinc-500"
              >
                &times;
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
