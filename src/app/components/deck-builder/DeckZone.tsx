"use client";

import { useMemo } from "react";
import { DeckColumn } from "./DeckColumn";
import { COLUMN_KEYS } from "@/core/deckBuilder";
import type { ColumnMap, ScryCard, CardStats } from "@/core/types";

const BASIC_LAND_SET = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest"]);

const COLUMN_LABELS: Record<string, string> = {
  "cmc-0-1": "0-1",
  "cmc-2": "2",
  "cmc-3": "3",
  "cmc-4": "4",
  "cmc-5": "5",
  "cmc-6+": "6+",
  lands: "Lands",
};

interface DeckZoneProps {
  zone: "deck" | "sideboard";
  columns: ColumnMap;
  scryfallData: Map<string, ScryCard>;
  cardStats: Map<string, CardStats>;
  speculativeCards: string[];
  onRemoveSpeculative?: (cardName: string) => void;
}

export function DeckZone({
  zone,
  columns,
  scryfallData,
  cardStats,
  speculativeCards,
  onRemoveSpeculative,
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

  // Compute which specific card instances are speculative.
  // For each name, the last N copies (in column order) are speculative,
  // where N = count of that name in speculativeCards.
  const { speculativeIndices, speculativeCount } = useMemo(() => {
    // Count speculative copies per name
    const specCountByName = new Map<string, number>();
    for (const name of speculativeCards) {
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

    return { speculativeIndices: indices, speculativeCount: indices.size };
  }, [columns, speculativeCards]);

  const pickedCount = totalCards - speculativeCount;

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
          {speculativeCount > 0 && (
            <> · <span className="text-amber-500/80">{speculativeCount} speculative</span></>
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
            speculativeIndices={speculativeIndices}
            onRemoveSpeculative={onRemoveSpeculative}
          />
        ))}
      </div>
    </div>
  );
}
