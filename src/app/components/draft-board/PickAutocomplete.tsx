"use client";

import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import { useCardStore } from "@/app/stores/cardStore";

interface PickAutocompleteProps {
  onPick: (cardName: string) => void;
  onCancel: () => void;
}

export function PickAutocomplete({ onPick, onCancel }: PickAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Use the client-side available set (cube minus taken minus banned) from cardStore,
  // already computed by recompute() — no network fetch needed per open/pick.
  const availableCardNames = useCardStore((s) => s.availableCardNames);

  // Click-outside detection
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onCancel();
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onCancel]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = availableCardNames
    .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const highlighted = listRef.current.children[highlightIndex] as HTMLElement | undefined;
    highlighted?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => (i + 1) % Math.max(filtered.length, 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex(
        (i) => (i - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1)
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered.length > 0 && highlightIndex < filtered.length) {
        onPick(filtered[highlightIndex]);
      }
      return;
    }
  }

  const showDropdown = filtered.length > 0 || query.trim().length > 0;
  const listId = "pick-autocomplete-list";

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={listId}
        aria-activedescendant={filtered.length > 0 ? `pick-option-${highlightIndex}` : undefined}
        aria-autocomplete="list"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlightIndex(0);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Type card name..."
        style={{
          width: "100%",
          height: "24px",
          padding: "4px 6px",
          fontSize: "11px",
          lineHeight: "1.2",
          background: "transparent",
          border: "1px solid rgba(59,130,246,0.4)",
          borderRadius: "2px",
          color: "#e0e0e0",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      {showDropdown && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            minWidth: "100%",
            maxWidth: "300px",
            maxHeight: "224px",
            overflowY: "auto",
            backgroundColor: "#1a1a1e",
            border: "1px solid #333",
            borderRadius: "4px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            zIndex: 25,
            marginTop: "2px",
          }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "4px 8px",
                fontSize: "11px",
                color: "#888",
              }}
            >
              No matches
            </div>
          ) : (
            filtered.map((name, i) => (
              <div
                key={name}
                id={`pick-option-${i}`}
                role="option"
                aria-selected={i === highlightIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(name);
                }}
                onMouseEnter={() => setHighlightIndex(i)}
                style={{
                  padding: "4px 8px",
                  fontSize: "11px",
                  color: "#e0e0e0",
                  cursor: "pointer",
                  backgroundColor: i === highlightIndex ? "rgba(59,130,246,0.2)" : "transparent",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {name}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
