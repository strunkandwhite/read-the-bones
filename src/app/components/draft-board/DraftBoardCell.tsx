"use client";

interface DraftBoardCellProps {
  cardName: string | null;
  colorIdentity: string[];
  isActive: boolean;
  isMyColumn: boolean;
}

const VALID_COLORS = new Set(["W", "U", "B", "R", "G"]);

function CellContent({ cardName, colorIdentity }: { cardName: string | null; colorIdentity: string[] }) {
  return (
    <div
      style={{
        padding: "4px 6px",
        fontSize: "11px",
        lineHeight: "1.3",
        height: "24px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
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
          {colorIdentity.length > 0 && (
            <span style={{ display: "flex", gap: "1px", flexShrink: 0 }}>
              {colorIdentity.map((c) => {
                if (!VALID_COLORS.has(c)) return null;
                return (
                  <img
                    key={c}
                    src={`/mana/${c}.svg`}
                    alt={c}
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
  colorIdentity,
  isActive,
  isMyColumn,
}: DraftBoardCellProps) {
  return (
    <td
      style={{
        padding: 0,
        maxWidth: "140px",
        backgroundColor: isMyColumn ? "rgba(59,130,246,0.06)" : "transparent",
        border: isActive ? "2px dashed #3b82f6" : "1px solid #333",
        animation: isActive ? "pulse-border 1.5s ease-in-out infinite" : undefined,
      }}
    >
      <CellContent cardName={cardName} colorIdentity={colorIdentity} />
    </td>
  );
}
