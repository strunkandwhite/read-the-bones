"use client";

interface DraftBoardCellProps {
  cardName: string | null;
  colorIdentity: string[];
  manaCost: string;
  isActive: boolean;
  isMyColumn: boolean;
}


function parseManaSymbols(manaCost: string): string[] {
  const symbols: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(manaCost)) !== null) {
    symbols.push(match[1]);
  }
  return symbols;
}

function getBackgroundColor(
  _colorIdentity: string | undefined,
  isMySeat: boolean,
): string {
  return isMySeat ? "rgba(59,130,246,0.06)" : "transparent";
}

export function DraftBoardCell({
  cardName,
  colorIdentity: _colorIdentity,
  manaCost,
  isActive,
  isMyColumn,
}: DraftBoardCellProps) {
  const bgColor = getBackgroundColor(undefined, isMyColumn);
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
        backgroundColor: bgColor,
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
          {manaCost && symbols.length > 0 && (
            <span style={{ display: "flex", gap: "1px", flexShrink: 0 }}>
              {symbols.map((sym, i) => {
                const svgName = sym.replace(/[{}\/]/g, "");
                return (
                  <img
                    key={i}
                    src={`/mana/${svgName}.svg`}
                    alt={sym}
                    width={12}
                    height={12}
                    style={{ display: "block" }}
                  />
                );
              })}
            </span>
          )}
        </div>
      )}
    </td>
  );
}
