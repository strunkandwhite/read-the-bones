"use client";

interface DraftBoardCellProps {
  cardName: string | null;
  manaCost: string | null;
  isActive: boolean;
  isMyColumn: boolean;
}

function parseManaSymbols(manaCost: string): string[] {
  // For double-faced cards, only show the front face cost (before " // ")
  const frontFaceCost = manaCost.split(" // ")[0];
  const matches = frontFaceCost.match(/\{[^}]+\}/g);
  return matches ?? [];
}

function CellContent({ cardName, manaCost }: { cardName: string | null; manaCost: string | null }) {
  const manaSymbols = manaCost ? parseManaSymbols(manaCost) : [];

  return (
    <div
      style={{
        padding: "4px 6px",
        height: "24px",
        display: "flex",
        alignItems: "center",
        color: cardName ? "#e0e0e0" : "#555",
        overflow: "hidden",
      }}
    >
      {cardName && (
        <div style={{ display: "flex", alignItems: "center", gap: "3px", width: "100%", overflow: "hidden" }}>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
              fontSize: "11px",
              lineHeight: "1.2",
            }}
            title={cardName}
          >
            {cardName}
          </span>
          {manaSymbols.length > 0 && (
            <span style={{ display: "flex", gap: "1px", flexShrink: 0 }}>
              {manaSymbols.map((sym, i) => {
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
    </div>
  );
}

/** Full table cell (td) for a draft board pick. */
export function DraftBoardCell({
  cardName,
  manaCost,
  isActive,
  isMyColumn,
}: DraftBoardCellProps) {
  return (
    <td
      style={{
        padding: 0,
        maxWidth: "160px",
        backgroundColor: isMyColumn ? "rgba(59,130,246,0.06)" : "transparent",
        border: isActive ? "2px dashed #3b82f6" : "1px solid #333",
        animation: isActive ? "pulse-border 1.5s ease-in-out infinite" : undefined,
      }}
    >
      <CellContent cardName={cardName} manaCost={manaCost} />
    </td>
  );
}
