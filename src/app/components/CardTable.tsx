"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import type { EnrichedCardStats } from "@/core/types";
import type { ColorFilterMode } from "@/core/colorFilter";
import { filterCardsByColor } from "@/core/colorFilter";
import { ManaSymbols, ColorPills } from "./ManaSymbols";
import { wilsonInterval } from "@/core/wilsonInterval";
import { Sparkline } from "./Sparkline";
import { CardNameCell } from "./CardNameCell";
import { DistributionHistogram } from "./DistributionHistogram";
import { track } from "@vercel/analytics/react";
import { useSlowRenderTracking } from "../hooks/useSlowRenderTracking";
import { InfoTooltip } from "./InfoTooltip";

export interface CardTableProps {
  cards: EnrichedCardStats[];
  colorFilter: string[];
  colorFilterMode: ColorFilterMode;
  currentCubeCopies: Record<string, number>;
  takenCardNames?: Set<string>;
  seatCardNames?: Set<string>;
  onAddSpeculative?: (cardName: string) => void;
  onRemoveSpeculative?: (cardName: string) => void;
  deckBuilderCardCounts?: Map<string, number>;
  speculativeCardNames?: Set<string>;
  stickyTopOffset?: number;
}

const columnHelper = createColumnHelper<EnrichedCardStats>();


const PICK_EXPLANATION = `Weighted geometric mean of pick positions across all drafts.

Weighting factors:
• Copy weight: 0.5^(n-1) for nth copy
• Unpicked cards: 0.5x weight (position set to pool size)`;

const DECKLIST_WIN_RATE_EXPLANATION = `Deck Win Rate shows the actual win rate of players who maindecked this card.

Higher = better (players who played this card in their deck won more)

How it works:
• Uses real decklist submissions (not estimated from pick position)
• Only counts games where the card was in the player's main deck
• Aggregated across all drafts with both decklist and match data`;

export function CardTable({
  cards,
  colorFilter,
  colorFilterMode,
  currentCubeCopies,
  takenCardNames,
  seatCardNames,
  onAddSpeculative,
  onRemoveSpeculative,
  deckBuilderCardCounts,
  speculativeCardNames,
  stickyTopOffset,
}: CardTableProps) {
  useSlowRenderTracking("card_table");
  const deckBuilderCardCountsRef = useRef(deckBuilderCardCounts);
  deckBuilderCardCountsRef.current = deckBuilderCardCounts;
  const speculativeCardNamesRef = useRef(speculativeCardNames);
  speculativeCardNamesRef.current = speculativeCardNames;
  const takenCardNamesRef = useRef(takenCardNames);
  takenCardNamesRef.current = takenCardNames;
  const seatCardNamesRef = useRef(seatCardNames);
  seatCardNamesRef.current = seatCardNames;
  const onAddSpeculativeRef = useRef(onAddSpeculative);
  onAddSpeculativeRef.current = onAddSpeculative;
  const onRemoveSpeculativeRef = useRef(onRemoveSpeculative);
  onRemoveSpeculativeRef.current = onRemoveSpeculative;

  const [sorting, setSorting] = useState<SortingState>([{ id: "pickScore", desc: false }]);

  // Track responsive breakpoint based on actual container width (handles browser zoom)
  const [breakpoint, setBreakpoint] = useState<"mobile" | "tablet" | "desktop">("desktop");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0].contentRect.width;
      if (width >= 940) setBreakpoint("desktop");
      else if (width >= 580) setBreakpoint("tablet");
      else setBreakpoint("mobile");
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Mobile: Card + P# only | Tablet: + Cost, Colors | Desktop: all columns
  const columnVisibility: VisibilityState = useMemo(() => {
    const showSm = breakpoint !== "mobile";
    const showMd = breakpoint === "desktop";
    return {
      manaCost: showSm,
      type: showMd,
      colors: showSm,
      distribution: showMd,
      decklistWinRate: showMd,
      history: showMd,
      timesPicked: showMd,
    };
  }, [breakpoint]);

  const handleSortingChange = useCallback((updater: SortingState | ((prev: SortingState) => SortingState)) => {
    setSorting((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next.length > 0) {
        track("sort_column", {
          column: next[0].id,
          direction: next[0].desc ? "desc" : "asc",
        });
      }
      return next;
    });
  }, []);

  // Compute global draft timeline for shared sparkline x-axis (sorted unique dates)
  const draftTimeline = useMemo((): string[] => {
    const dates = new Set<string>();
    for (const card of cards) {
      for (const score of card.scoreHistory) {
        dates.add(score.date);
      }
    }
    return Array.from(dates).sort();
  }, [cards]);

  const hasAnyDecklistWinRate = cards.some((c) => c.decklistWinRate);

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "card",
        header: "Card",
        size: 260,
        cell: ({ row }) => (
          <CardNameCell
            card={row.original}
            cubeCopies={currentCubeCopies[row.original.cardName]}
            onAddSpeculative={onAddSpeculativeRef.current}
            onRemoveSpeculative={onRemoveSpeculativeRef.current}
            canAddMore={
              !deckBuilderCardCountsRef.current?.has(row.original.cardName) ||
              (deckBuilderCardCountsRef.current?.get(row.original.cardName) ?? 0) < (currentCubeCopies[row.original.cardName] || 1)
            }
            isInDeckBuilder={deckBuilderCardCountsRef.current?.has(row.original.cardName)}
            isSpeculative={speculativeCardNamesRef.current?.has(row.original.cardName)}
            isTaken={takenCardNamesRef.current?.has(row.original.cardName) && !seatCardNamesRef.current?.has(row.original.cardName)}
            isSeatCard={seatCardNamesRef.current?.has(row.original.cardName)}
          />
        ),
      }),
      columnHelper.accessor((row) => row.scryfall?.manaValue ?? 0, {
        id: "manaCost",
        header: "Cost",
        size: 80,
        cell: ({ row }) => <ManaSymbols cost={row.original.scryfall?.manaCost || ""} />,
      }),
      columnHelper.accessor((row) => row.scryfall?.typeLine || "", {
        id: "type",
        header: "Type",
        size: 160,
        cell: ({ getValue }) => (
          <span className="text-sm text-zinc-600 dark:text-zinc-400">{getValue() || "-"}</span>
        ),
        enableSorting: false,
      }),
      columnHelper.accessor((row) => row.scryfall?.colorIdentity || row.colors, {
        id: "colors",
        header: "Colors",
        size: 70,
        cell: ({ getValue }) => <ColorPills colors={getValue() || []} />,
      }),
      columnHelper.accessor((row) => row.weightedGeomean != null && isFinite(row.weightedGeomean) ? row.weightedGeomean : undefined, {
        id: "pickScore",
        size: 85,
        sortUndefined: "last",
        header: () => (
          <span className="inline-flex items-center">
            P#
            <InfoTooltip text={PICK_EXPLANATION} />
          </span>
        ),
        cell: ({ getValue }) => {
          const value = getValue();
          if (value == null || !isFinite(value)) {
            return (
              <span className="text-sm font-medium text-zinc-400 italic dark:text-zinc-500">
                New
              </span>
            );
          }
          return (
            <span className="font-mono text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              {value.toFixed(2)}
            </span>
          );
        },
      }),
      columnHelper.display({
        id: "distribution",
        header: "Distribution",
        size: 110,
        cell: ({ row }) => <DistributionHistogram distribution={row.original.pickDistribution} />,
      }),
      ...(hasAnyDecklistWinRate
        ? [
            columnHelper.accessor((row) => row.decklistWinRate?.winRate ?? -1, {
              id: "decklistWinRate",
              size: 90,
              header: () => (
                <span className="inline-flex items-center">
                  GPWR
                  <InfoTooltip text={DECKLIST_WIN_RATE_EXPLANATION} />
                </span>
              ),
              cell: ({ row }) => {
                const wr = row.original.decklistWinRate;
                if (!wr) {
                  return <span className="text-sm text-zinc-400">—</span>;
                }
                const pct = Math.round(wr.winRate * 100);
                const total = wr.gameWins + wr.gameLosses;
                const { lower, upper } = wilsonInterval(wr.gameWins, total);
                const margin = ((upper - lower) / 2 * 100).toFixed(0);
                return (
                  <div className="group relative">
                    <span className="font-mono text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {pct}%
                    </span>
                    <span className="ml-1 font-mono text-xs text-zinc-400 dark:text-zinc-500">
                      ±{margin}%
                    </span>
                    <div className="absolute -top-10 left-0 z-50 hidden rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white group-hover:block">
                      {wr.gameWins}W / {wr.gameLosses}L across {wr.timesMaindecked} decks ({wr.draftsWithData} drafts)
                    </div>
                  </div>
                );
              },
              sortingFn: (a, b) => {
                const aVal = a.original.decklistWinRate?.winRate ?? -1;
                const bVal = b.original.decklistWinRate?.winRate ?? -1;
                return aVal - bVal;
              },
            }),
          ]
        : []),
      columnHelper.display({
        id: "history",
        header: "History",
        size: 100,
        cell: ({ row }) => (
          <Sparkline history={row.original.scoreHistory} draftTimeline={draftTimeline} />
        ),
      }),
      columnHelper.accessor((row) => row.draftsPickedIn, {
        id: "timesPicked",
        header: "Picked",
        size: 90,
        cell: ({ row }) => {
          if (row.original.timesAvailable === 0) {
            return <span className="text-sm text-zinc-400 dark:text-zinc-500">—</span>;
          }
          return (
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {row.original.draftsPickedIn} / {row.original.timesAvailable}
            </span>
          );
        },
      }),
    ],
    [currentCubeCopies, hasAnyDecklistWinRate, draftTimeline]
  );

  const filteredData = useMemo(() => {
    return filterCardsByColor(cards, colorFilter, colorFilterMode);
  }, [cards, colorFilter, colorFilterMode]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table API is incompatible with React Compiler memoization
  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: handleSortingChange,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div ref={containerRef}>
      <div className="relative">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
          <table className={`w-full text-left ${breakpoint === "desktop" ? "table-fixed" : "table-auto"}`}>
            {breakpoint === "desktop" && (
              <colgroup>
                {table.getVisibleLeafColumns().map((col) => (
                  <col key={col.id} style={{ width: col.getSize() }} />
                ))}
              </colgroup>
            )}
            <thead
              className="bg-zinc-50 dark:bg-zinc-800"
              style={stickyTopOffset != null && breakpoint === "desktop" ? { position: "sticky", top: stickyTopOffset, zIndex: 20 } : undefined}
            >
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className={`px-2 py-2 sm:px-4 sm:py-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300 ${
                        header.column.getCanSort()
                          ? "cursor-pointer select-none hover:bg-zinc-100 dark:hover:bg-zinc-700"
                          : ""
                      }`}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <span className="text-zinc-400">
                            {{
                              asc: " ▲",
                              desc: " ▼",
                            }[header.column.getIsSorted() as string] ?? " ⬍"}
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-700">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length}
                    className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400"
                  >
                    No cards found
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="bg-white transition-colors hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                    style={{
                      opacity:
                        takenCardNames?.has(row.original.cardName) &&
                        !seatCardNames?.has(row.original.cardName)
                          ? 0.35
                          : 1,
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="px-2 py-2 sm:px-4 sm:py-3"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* Footer with count */}
          <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
            Showing {filteredData.length} of {cards.length} unique cards
          </div>
        </div>
      </div>
    </div>
  );
}
