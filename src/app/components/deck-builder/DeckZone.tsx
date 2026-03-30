"use client";

import { useMemo } from "react";
import { DeckColumn } from "./DeckColumn";
import { COLUMN_KEYS } from "@/core/deckBuilder";
import type { ColumnMap, ScryCard, CardStats } from "@/core/types";

const BASIC_LAND_SET = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest"]);

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
  floatedCards: string[];
  queuedCardNames: string[];
  onRemoveFloat?: (cardName: string) => void;
}

export function DeckZone({
  zone,
  columns,
  scryfallData,
  cardStats,
  floatedCards,
  queuedCardNames,
  onRemoveFloat,
}: DeckZoneProps) {
  const totalCards = Object.values(columns).reduce(
    (sum, cards) => sum + cards.length,
    0
  );

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

  // Compute which specific card instances are floated.
  // For each name, the last N copies (in column order) are floated,
  // where N = count of that name in floatedCards.
  const { floatedIndices, floatedCount } = useMemo(() => {
    // Count floated copies per name
    const specCountByName = new Map<string, number>();
    for (const name of floatedCards) {
      specCountByName.set(name, (specCountByName.get(name) || 0) + 1);
    }

    // Collect all card instances across columns in order
    const allInstances: Array<{ key: string; idx: number; name: string }> = [];
    for (const key of COLUMN_KEYS) {
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
  }, [columns, floatedCards]);

  // Compute queued card indices using the same pattern as floated
  const queuedIndices = useMemo(() => {
    const specCountByName = new Map<string, number>();
    for (const name of queuedCardNames) {
      specCountByName.set(name, (specCountByName.get(name) || 0) + 1);
    }

    const allInstances: Array<{ key: string; idx: number; name: string }> = [];
    for (const key of COLUMN_KEYS) {
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
  }, [columns, queuedCardNames]);

  const pickedCount = totalCards - floatedCount - queuedIndices.size;

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
      </div>
      <div className="grid grid-cols-7 gap-2">
        {COLUMN_KEYS.map((key) => (
          <DeckColumn
            key={`${zone}:${key}`}
            columnKey={key}
            label={COLUMN_LABELS[key]}
            cardNames={columns[key] ?? []}
            zone={zone}
            scryfallData={scryfallData}
            cardStats={cardStats}
            floatedIndices={floatedIndices}
            queuedIndices={queuedIndices}
            onRemoveFloat={onRemoveFloat}
          />
        ))}
      </div>
    </div>
  );
}
