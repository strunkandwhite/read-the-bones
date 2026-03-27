"use client";

import { useState, useEffect, useRef } from "react";
import { PickAutocomplete } from "./PickAutocomplete";

interface DraftBoardCellProps {
  cardName: string | null;
  manaCost: string | null;
  isActive: boolean;
  isMyColumn: boolean;
  isEditable?: boolean;
  draftId?: string | null;
  nextPickN?: number | null;
  onPick?: (cardName: string) => void;
  pickError?: string | null;
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
  isEditable = false,
  draftId = null,
  nextPickN = null,
  onPick,
  pickError = null,
}: DraftBoardCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [optimisticCardName, setOptimisticCardName] = useState<string | null>(null);
  const prevPickErrorRef = useRef<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- syncing derived state from prop changes (error revert, board confirmation, editability) */

  // Revert optimistic state when pickError transitions to non-null
  useEffect(() => {
    if (pickError !== null && prevPickErrorRef.current === null && optimisticCardName !== null) {
      setOptimisticCardName(null);
      setIsEditing(true);
    }
    prevPickErrorRef.current = pickError;
  }, [pickError, optimisticCardName]);

  // Clear optimistic state when board confirms the pick
  useEffect(() => {
    if (cardName !== null && optimisticCardName !== null) {
      setOptimisticCardName(null);
    }
  }, [cardName, optimisticCardName]);

  // Close edit mode if the cell is no longer editable (e.g., turn changed)
  useEffect(() => {
    if (!isEditable) {
      setIsEditing(false);
      setOptimisticCardName(null);
    }
  }, [isEditable]);

  /* eslint-enable react-hooks/set-state-in-effect */

  function handleCellClick() {
    if (isEditable && !isEditing && cardName === null && optimisticCardName === null) {
      setIsEditing(true);
    }
  }

  function handlePickLocal(selectedCardName: string) {
    setOptimisticCardName(selectedCardName);
    setIsEditing(false);
    onPick?.(selectedCardName);
  }

  function handleCancel() {
    setIsEditing(false);
  }

  const displayName = optimisticCardName ?? cardName;

  return (
    <td
      onClick={handleCellClick}
      style={{
        padding: 0,
        maxWidth: "160px",
        position: "relative",
        backgroundColor: isMyColumn ? "rgba(59,130,246,0.06)" : "transparent",
        border: isActive ? "2px dashed #3b82f6" : "1px solid #333",
        animation: isActive ? "pulse-border 1.5s ease-in-out infinite" : undefined,
        cursor: isEditable && !isEditing && cardName === null && optimisticCardName === null ? "pointer" : undefined,
      }}
    >
      {isEditing && draftId && nextPickN !== null ? (
        <PickAutocomplete
          draftId={draftId}
          nextPickN={nextPickN}
          onPick={handlePickLocal}
          onCancel={handleCancel}
        />
      ) : (
        <CellContent cardName={displayName} manaCost={optimisticCardName ? null : manaCost} />
      )}
    </td>
  );
}
