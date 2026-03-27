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
    <div
      style={{
        marginTop: "16px",
        padding: "16px",
        borderRadius: "8px",
        border: "1px solid rgba(39,39,42,0.6)",
        backgroundColor: "rgba(24,24,27,0.5)",
      }}
    >
      {/* Header with auto-pick toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "12px",
        }}
      >
        <span
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#e4e4e7",
            letterSpacing: "-0.01em",
          }}
        >
          Pick Queue
        </span>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "12px",
            color: "#a1a1aa",
            cursor: "pointer",
          }}
        >
          <span>Auto-pick</span>
          <input
            type="checkbox"
            checked={autoPick}
            onChange={onToggleAutoPick}
            style={{ cursor: "pointer" }}
          />
        </label>
      </div>

      {/* Mode selector — only visible when auto-pick is on */}
      {autoPick && (
        <div
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "12px",
          }}
        >
          <button
            onClick={() => onChangeAutoPickMode("resilient")}
            style={{
              flex: 1,
              padding: "6px 10px",
              borderRadius: "6px",
              border:
                autoPickMode === "resilient"
                  ? "1px solid #854d0e"
                  : "1px solid rgba(39,39,42,0.6)",
              backgroundColor:
                autoPickMode === "resilient"
                  ? "rgba(133,77,14,0.2)"
                  : "transparent",
              color: autoPickMode === "resilient" ? "#fde68a" : "#71717a",
              fontSize: "11px",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <div style={{ fontWeight: 600 }}>Resilient</div>
            <div style={{ marginTop: "2px", opacity: 0.8 }}>
              Skips taken cards, picks next available
            </div>
          </button>
          <button
            onClick={() => onChangeAutoPickMode("cautious")}
            style={{
              flex: 1,
              padding: "6px 10px",
              borderRadius: "6px",
              border:
                autoPickMode === "cautious"
                  ? "1px solid #1e3a5f"
                  : "1px solid rgba(39,39,42,0.6)",
              backgroundColor:
                autoPickMode === "cautious"
                  ? "rgba(30,58,95,0.2)"
                  : "transparent",
              color: autoPickMode === "cautious" ? "#93c5fd" : "#71717a",
              fontSize: "11px",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <div style={{ fontWeight: 600 }}>Cautious</div>
            <div style={{ marginTop: "2px", opacity: 0.8 }}>
              Pauses if top pick was taken
            </div>
          </button>
        </div>
      )}

      {/* Queue list */}
      {queue.length === 0 ? (
        <div
          style={{
            padding: "20px 0",
            textAlign: "center",
            color: "#52525b",
            fontSize: "12px",
          }}
        >
          Queue is empty. Add cards from the card table.
        </div>
      ) : (
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          {queue.map((item, index) => (
            <li
              key={item.cardName}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 8px",
                borderRadius: "4px",
                backgroundColor: "rgba(39,39,42,0.3)",
                fontSize: "12px",
              }}
            >
              {/* Position number */}
              <span
                style={{
                  color: "#52525b",
                  fontWeight: 600,
                  fontSize: "11px",
                  minWidth: "16px",
                }}
              >
                {index + 1}.
              </span>

              {/* Card name */}
              <span
                style={{
                  flex: 1,
                  color: item.taken ? "#52525b" : "#d4d4d8",
                  textDecoration: item.taken ? "line-through" : "none",
                }}
              >
                {item.cardName}
              </span>

              {/* Reorder buttons */}
              <button
                onClick={() => moveUp(index)}
                disabled={index === 0}
                aria-label={`Move up ${item.cardName}`}
                style={{
                  background: "none",
                  border: "none",
                  color: index === 0 ? "#27272a" : "#71717a",
                  cursor: index === 0 ? "default" : "pointer",
                  padding: "2px 4px",
                  fontSize: "12px",
                  lineHeight: 1,
                }}
              >
                ▲
              </button>
              <button
                onClick={() => moveDown(index)}
                disabled={index === queue.length - 1}
                aria-label={`Move down ${item.cardName}`}
                style={{
                  background: "none",
                  border: "none",
                  color: index === queue.length - 1 ? "#27272a" : "#71717a",
                  cursor: index === queue.length - 1 ? "default" : "pointer",
                  padding: "2px 4px",
                  fontSize: "12px",
                  lineHeight: 1,
                }}
              >
                ▼
              </button>

              {/* Remove button */}
              <button
                onClick={() => onRemove(item.cardName)}
                aria-label={`Remove ${item.cardName}`}
                style={{
                  background: "none",
                  border: "none",
                  color: "#71717a",
                  cursor: "pointer",
                  padding: "2px 4px",
                  fontSize: "14px",
                  lineHeight: 1,
                }}
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
