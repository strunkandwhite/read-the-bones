"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface InlineEditableNameProps {
  currentName: string;
  seatNumber: number;
  isEditable: boolean;
  onSave: (name: string) => Promise<void>;
}

export function InlineEditableName({
  currentName,
  seatNumber,
  isEditable,
  onSave,
}: InlineEditableNameProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(currentName);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Keep editValue in sync when currentName changes externally (polling)
  useEffect(() => {
    if (!isEditing) setEditValue(currentName); // eslint-disable-line react-hooks/set-state-in-effect -- syncing local edit buffer from external (polled) prop
  }, [currentName, isEditing]);

  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;

    const trimmed = editValue.trim();
    setIsEditing(false);

    // No change: name is same, or clearing when already at fallback
    if (trimmed === currentName) {
      savingRef.current = false;
      return;
    }
    if (trimmed === "" && currentName === `Seat ${seatNumber}`) {
      savingRef.current = false;
      return;
    }

    try {
      await onSave(trimmed);
    } catch {
      setEditValue(currentName);
    } finally {
      savingRef.current = false;
    }
  }, [editValue, currentName, seatNumber, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        setEditValue(currentName);
        setIsEditing(false);
      }
    },
    [handleSave, currentName],
  );

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleSave}
        maxLength={50}
        style={{
          background: "transparent",
          border: "1px solid rgba(59,130,246,0.4)",
          borderRadius: "3px",
          color: "inherit",
          font: "inherit",
          textAlign: "center",
          width: "100%",
          padding: "1px 4px",
          outline: "none",
        }}
      />
    );
  }

  return (
    <span
      onClick={isEditable ? () => setIsEditing(true) : undefined}
      style={{
        cursor: isEditable ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      {currentName}
      {isEditable && (
        <span style={{ fontSize: "9px" }} className="pencil-icon">
          ✎
        </span>
      )}
    </span>
  );
}
