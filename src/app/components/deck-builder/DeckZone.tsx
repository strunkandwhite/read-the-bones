"use client";

import { useMemo } from "react";
import { DeckColumn } from "./DeckColumn";
import {
  BASE_COLUMN_KEYS,
  MANA_VALUE_COLUMN_KEYS,
  NONCREATURE_COLUMN_KEYS,
  columnKeysForZone,
  toBaseColumnKey,
} from "@/core/deckBuilder";
import { colorSourceSplits, isNotableColor } from "@/core/manaSources";
import { isLocalClient } from "@/core/isLocal";
import { ColorPills } from "../ManaSymbols";
import type { DeckColumnKey } from "@/core/deckBuilder";
import type { ColorSourceSplit, ManaColor } from "@/core/manaSources";
import type { ColumnMap, ScryCard, CardStats } from "@/core/types";
import type { WorthCard } from "@/core/worthModel";

const BASIC_LAND_SET = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest"]);

const COLOR_NAMES: Record<ManaColor, string> = {
  W: "white",
  U: "blue",
  B: "black",
  R: "red",
  G: "green",
};

function colorSourceTooltip({
  color,
  sources,
  required,
  requiredBy,
}: ColorSourceSplit): string {
  const name = COLOR_NAMES[color];
  if (!requiredBy) {
    return `${sources} ${name} sources — no maindeck spell asks for ${name}.`;
  }
  return `${sources} of the ${required} ${name} sources ${requiredBy} wants to be castable on curve.`;
}

const COLUMN_LABELS: Record<string, string> = {
  "mv-0-1": "0-1",
  "mv-2": "2",
  "mv-3": "3",
  "mv-4": "4",
  "mv-5": "5",
  "mv-6+": "6+",
  lands: "Lands",
};

interface DeckZoneProps {
  zone: "deck" | "sideboard";
  columns: ColumnMap;
  scryfallData: Map<string, ScryCard>;
  cardStats: Map<string, CardStats>;
  worthCards: Map<string, WorthCard>;
  floatedCards: string[];
  queuedCardNames: string[];
  onRemoveFloat?: (cardName: string) => void;
  onToggleQueue?: (cardName: string) => void;
}

export function DeckZone({
  zone,
  columns,
  scryfallData,
  cardStats,
  worthCards,
  floatedCards,
  queuedCardNames,
  onRemoveFloat,
  onToggleQueue,
}: DeckZoneProps) {
  // Only the maindeck is split into rows, and only over the mana-value columns;
  // its lands column stands beside them, and the sideboard is one plain grid.
  const rows: Array<{ label: string; keys: readonly DeckColumnKey[] }> = [
    { label: "Creatures", keys: MANA_VALUE_COLUMN_KEYS },
    { label: "Non-Creatures", keys: NONCREATURE_COLUMN_KEYS },
  ];

  const countIn = (keys: readonly DeckColumnKey[]) =>
    keys.reduce((sum, key) => sum + (columns[key]?.length ?? 0), 0);

  const totalCards = countIn(columnKeysForZone(zone));

  const { creatureCount, spellCount, landCount } = useMemo(() => {
    let creatures = 0, spells = 0, lands = 0;
    for (const col of Object.values(columns)) {
      for (const name of col) {
        if (BASIC_LAND_SET.has(name)) { lands++; continue; }
        const tl = scryfallData.get(name)?.typeLine?.toLowerCase() ?? "";
        if (tl.includes("land")) lands++;
        else if (tl.includes("creature")) creatures++;
        else spells++;
      }
    }
    return { creatureCount: creatures, spellCount: spells, landCount: lands };
  }, [columns, scryfallData]);

  // Actual vs. wanted colored sources is a localhost-only readout, and only the
  // maindeck has a manabase to say anything about.
  const isLocal = useMemo(() => isLocalClient(), []);

  const colorSplits = useMemo(() => {
    if (!isLocal || zone !== "deck") return [];
    const cardNames = columnKeysForZone(zone).flatMap((key) => columns[key] ?? []);
    return colorSourceSplits(cardNames, scryfallData).filter(isNotableColor);
  }, [isLocal, zone, columns, scryfallData]);

  // Compute which specific card instances are floated.
  // Cards that are both floated AND queued show as queued (stronger intent).
  const queuedSet = useMemo(() => new Set(queuedCardNames), [queuedCardNames]);

  const { floatedIndices, floatedCount } = useMemo(() => {
    const specCountByName = new Map<string, number>();
    for (const name of floatedCards) {
      if (queuedSet.has(name)) continue; // queued takes priority
      specCountByName.set(name, (specCountByName.get(name) || 0) + 1);
    }

    // Collect all card instances across columns in order
    const allInstances: Array<{ key: string; idx: number; name: string }> = [];
    for (const key of columnKeysForZone(zone)) {
      for (let idx = 0; idx < (columns[key]?.length ?? 0); idx++) {
        allInstances.push({ key, idx, name: columns[key][idx] });
      }
    }

    // Group by name, mark last N as speculative
    const indices = new Set<string>();
    const nameGroups = new Map<string, Array<{ key: string; idx: number }>>();
    for (const inst of allInstances) {
      if (!nameGroups.has(inst.name)) nameGroups.set(inst.name, []);
      nameGroups.get(inst.name)!.push({ key: inst.key, idx: inst.idx });
    }
    for (const [name, instances] of nameGroups) {
      const specCount = specCountByName.get(name) ?? 0;
      for (let i = instances.length - specCount; i < instances.length; i++) {
        if (i >= 0) {
          indices.add(`${instances[i].key}:${instances[i].idx}`);
        }
      }
    }

    return { floatedIndices: indices, floatedCount: indices.size };
  }, [columns, zone, floatedCards, queuedSet]);

  // Compute queued card indices using the same pattern as floated
  const queuedIndices = useMemo(() => {
    const specCountByName = new Map<string, number>();
    for (const name of queuedCardNames) {
      specCountByName.set(name, (specCountByName.get(name) || 0) + 1);
    }

    const allInstances: Array<{ key: string; idx: number; name: string }> = [];
    for (const key of columnKeysForZone(zone)) {
      for (let idx = 0; idx < (columns[key]?.length ?? 0); idx++) {
        allInstances.push({ key, idx, name: columns[key][idx] });
      }
    }

    const indices = new Set<string>();
    const nameGroups = new Map<string, Array<{ key: string; idx: number }>>();
    for (const inst of allInstances) {
      if (!nameGroups.has(inst.name)) nameGroups.set(inst.name, []);
      nameGroups.get(inst.name)!.push({ key: inst.key, idx: inst.idx });
    }
    for (const [name, instances] of nameGroups) {
      const specCount = specCountByName.get(name) ?? 0;
      for (let i = instances.length - specCount; i < instances.length; i++) {
        if (i >= 0) indices.add(`${instances[i].key}:${instances[i].idx}`);
      }
    }

    return indices;
  }, [columns, zone, queuedCardNames]);

  const pickedCount = totalCards - floatedCount - queuedIndices.size;

  const renderColumn = (key: DeckColumnKey, fillHeight = false) => (
    <DeckColumn
      key={`${zone}:${key}`}
      columnKey={key}
      label={COLUMN_LABELS[toBaseColumnKey(key) ?? key]}
      cardNames={columns[key] ?? []}
      zone={zone}
      scryfallData={scryfallData}
      cardStats={cardStats}
      worthCards={worthCards}
      floatedIndices={floatedIndices}
      queuedIndices={queuedIndices}
      onRemoveFloat={onRemoveFloat}
      onToggleQueue={onToggleQueue}
      fillHeight={fillHeight}
    />
  );

  return (
    <div>
      <div className="mb-3 flex items-baseline gap-3 px-1">
        <span className="text-sm font-bold tracking-tight text-zinc-100">
          {zone === "deck" ? "Deck" : "Sideboard"}
        </span>
        <span className="font-mono text-sm font-semibold text-zinc-400">
          {totalCards}
        </span>
        <span className="text-[11px] text-zinc-500">
          {pickedCount} picked
          {floatedCount > 0 && (
            <> · <span className="text-amber-500/80">{floatedCount} floated</span></>
          )}
          {queuedIndices.size > 0 && (
            <> · <span className="text-orange-400/80">{queuedIndices.size} queued</span></>
          )}
        </span>
        {totalCards > 0 && (
          <span className="text-[11px] text-zinc-500">
            {creatureCount}c · {spellCount}s · {landCount}l
          </span>
        )}
        {colorSplits.length > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            {colorSplits.map((split, index) => (
              <span
                key={split.color}
                className="flex items-center gap-1"
                title={colorSourceTooltip(split)}
              >
                {index > 0 && <span className="mr-0.5 text-zinc-600">·</span>}
                <span className="font-mono">
                  <span
                    className={
                      split.sources >= split.required
                        ? "text-zinc-300"
                        : "text-amber-500/90"
                    }
                  >
                    {split.sources}
                  </span>
                  /{split.required}
                </span>
                <ColorPills colors={[split.color]} size={12} />
              </span>
            ))}
          </span>
        )}
      </div>
      {zone === "deck" ? (
        // Six of seven columns also spans the five gaps between them, so an
        // inner six-column grid at the same gap gives columns of exactly the
        // width of the lands column beside them.
        <div className="grid grid-cols-7 gap-2">
          <div className="col-span-6 space-y-4">
            {rows.map((row, rowIndex) => (
              <div
                key={row.label}
                className={rowIndex > 0 ? "border-t border-zinc-800/60 pt-4" : undefined}
              >
                <div className="mb-2 flex items-baseline gap-1 px-1 text-[11px]">
                  <span className="font-semibold text-zinc-500">{row.label}</span>
                  <span className="font-mono text-zinc-500/80">
                    ({countIn(row.keys)})
                  </span>
                </div>
                <div className="grid grid-cols-6 gap-2">
                  {row.keys.map((key) => renderColumn(key))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col">
            {/* Stands in for the row label the rows have and the lands column
                does not, so the column's own header lines up with the
                mana-value headers rather than with the row labels. */}
            <div aria-hidden className="invisible mb-2 px-1 text-[11px]">
              &nbsp;
            </div>
            {renderColumn("lands", true)}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {BASE_COLUMN_KEYS.map((key) => renderColumn(key))}
        </div>
      )}
    </div>
  );
}
