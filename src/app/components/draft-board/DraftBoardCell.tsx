"use client";

interface DraftBoardCellProps {
  cardName: string | null;
  colorIdentity: string[];
  manaCost: string;
  isActive: boolean;
  isMyColumn: boolean;
}

const MANA_COLORS: Record<string, string> = {
  W: "#e8c050",
  U: "#4488cc",
  B: "#555555",
  R: "#cc4444",
  G: "#44aa44",
  C: "#999999",
};

const COLOR_BACKGROUNDS: Record<string, string> = {
  W: "#fffbe6",
  U: "#e6f0ff",
  B: "#f0e6f0",
  R: "#ffe6e6",
  G: "#e6ffe6",
};

function parseManaSymbols(manaCost: string): string[] {
  const symbols: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(manaCost)) !== null) {
    symbols.push(match[1]);
  }
  return symbols;
}

function getBackgroundColor(colorIdentity: string[]): string {
  if (colorIdentity.length === 0) return "transparent";
  if (colorIdentity.length === 1) return COLOR_BACKGROUNDS[colorIdentity[0]] ?? "transparent";
  return "#f5f0e0";
}

export function DraftBoardCell({
  cardName,
  colorIdentity,
  manaCost,
  isActive,
  isMyColumn,
}: DraftBoardCellProps) {
  const bgColor = cardName ? getBackgroundColor(colorIdentity) : "transparent";
  const symbols = cardName ? parseManaSymbols(manaCost) : [];

  return (
    <td
      style={{
        padding: "3px 6px",
        fontSize: "11px",
        lineHeight: "1.3",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "140px",
        backgroundColor: isMyColumn
          ? `color-mix(in srgb, ${bgColor || "#e8f0fe"} 70%, #d0e0ff 30%)`
          : bgColor,
        border: isActive ? "2px dashed #3b82f6" : "1px solid #333",
        animation: isActive ? "pulse-border 1.5s ease-in-out infinite" : undefined,
        color: cardName ? "#e0e0e0" : "#555",
      }}
    >
      {cardName && (
        <div style={{ display: "flex", alignItems: "center", gap: "3px" }}>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
              minWidth: 0,
            }}
            title={cardName}
          >
            {cardName}
          </span>
          {symbols.length > 0 && (
            <span style={{ display: "flex", gap: "1px", flexShrink: 0 }}>
              {symbols.map((sym, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    backgroundColor: MANA_COLORS[sym] ?? "#999",
                  }}
                />
              ))}
            </span>
          )}
        </div>
      )}
    </td>
  );
}
