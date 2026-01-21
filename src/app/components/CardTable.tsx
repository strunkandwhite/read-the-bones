"use client";

import { useMemo, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  SortingState,
} from "@tanstack/react-table";
import type { EnrichedCardStats } from "@/core/types";
import type { ColorFilterMode } from "./ColorFilter";
import { filterCardsByColor } from "@/core/colorFilter";
import { ManaSymbols, ColorPills } from "./ManaSymbols";
import { Sparkline } from "./Sparkline";
import { CardNameCell } from "./CardNameCell";
import { DistributionHistogram } from "./DistributionHistogram";

export interface CardTableProps {
  cards: EnrichedCardStats[];
  colorFilter: string[];
  colorFilterMode: ColorFilterMode;
  currentCubeCopies: Record<string, number>;
  showWinEquity: boolean;
  showRawWinRate: boolean;
}

const columnHelper = createColumnHelper<EnrichedCardStats>();

// Info tooltip component
function InfoTooltip({ text }: { text: string }) {
  return (
    <div className="group relative ml-1 inline-block">
      <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-zinc-200 text-xs text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
        ?
      </span>
      <div className="absolute top-6 -left-32 z-50 hidden w-72 rounded-lg bg-zinc-800 p-3 text-xs whitespace-pre-line text-white shadow-xl group-hover:block dark:bg-zinc-900">
        {text}
        <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-zinc-800 dark:bg-zinc-900" />
      </div>
    </div>
  );
}

const PICK_EXPLANATION = `Weighted geometric mean of pick positions across all drafts.

Weighting factors:
• Copy weight: 0.5^(n-1) for nth copy
• Unpicked cards: 0.5x weight (position set to pool size)`;

const WIN_EQUITY_EXPLANATION = `Win Equity estimates how much each card contributed to match wins.

Higher = better (contributed more to wins)

⚠️ VERY UNRELIABLE - treat as entertainment only:
• Small sample size (few drafts)
• No data on whether card was actually drawn
• Play probability is a rough estimate

How it works:
• Each card gets a "play probability" based on pick position
• Early picks (1-15): 95% likely played
• Mid picks (16-23): 80% likely played
• Late picks (24-30): 40% likely played
• Very late (31+): 10% likely played
• Lands: always 100%

A player's wins/losses are distributed across their cards proportionally by play probability.`;

const RAW_WIN_RATE_EXPLANATION = `Win Rate shows the raw (unweighted) win rate for each card.

Higher = better (players who picked this card won more)

⚠️ VERY UNRELIABLE - treat as entertainment only:
• Small sample size (few drafts)
• No weighting for pick position or play likelihood
• Correlation != causation

How it works:
• A player's wins/losses are divided equally among all cards in their pool
• Aggregated across all drafts where the card was picked

Unlike Win Equity, this does not weight by pick position or card type.`;

export function CardTable({
  cards,
  colorFilter,
  colorFilterMode,
  currentCubeCopies,
  showWinEquity,
  showRawWinRate,
}: CardTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "pickScore", desc: false }]);

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

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "card",
        header: "Card",
        cell: ({ row }) => <CardNameCell card={row.original} />,
      }),
      columnHelper.accessor((row) => row.scryfall?.manaValue ?? 0, {
        id: "manaCost",
        header: "Mana Cost",
        cell: ({ row }) => <ManaSymbols cost={row.original.scryfall?.manaCost || ""} />,
      }),
      columnHelper.accessor((row) => row.scryfall?.typeLine || "", {
        id: "type",
        header: "Type",
        cell: ({ getValue }) => (
          <span className="text-sm text-zinc-600 dark:text-zinc-400">{getValue() || "-"}</span>
        ),
        enableSorting: false,
      }),
      columnHelper.accessor((row) => row.scryfall?.colorIdentity || row.colors, {
        id: "colors",
        header: "Colors",
        cell: ({ getValue }) => <ColorPills colors={getValue() || []} />,
      }),
      columnHelper.accessor((row) => row.weightedGeomean, {
        id: "pickScore",
        header: () => (
          <span className="inline-flex items-center">
            Pick Score
            <InfoTooltip text={PICK_EXPLANATION} />
          </span>
        ),
        cell: ({ getValue }) => {
          const value = getValue();
          if (!isFinite(value)) {
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
        cell: ({ row }) => <DistributionHistogram distribution={row.original.pickDistribution} />,
      }),
      ...(showWinEquity
        ? [
            columnHelper.accessor((row) => row.winEquity?.winRate ?? -1, {
              id: "winEquity",
              header: () => (
                <span className="inline-flex items-center">
                  Win Equity
                  <InfoTooltip text={WIN_EQUITY_EXPLANATION} />
                </span>
              ),
              cell: ({ row }) => {
                const equity = row.original.winEquity;
                if (!equity) {
                  return <span className="text-sm text-zinc-400">—</span>;
                }
                const pct = (equity.winRate * 100).toFixed(1);
                return (
                  <div className="group relative">
                    <span className="font-mono text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {pct}%
                    </span>
                    <div className="absolute -top-10 left-0 z-50 hidden rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white group-hover:block">
                      {equity.wins.toFixed(1)} wins / {equity.losses.toFixed(1)} losses attributed
                    </div>
                  </div>
                );
              },
              sortingFn: (a, b) => {
                const aVal = a.original.winEquity?.winRate ?? -1;
                const bVal = b.original.winEquity?.winRate ?? -1;
                return aVal - bVal;
              },
            }),
          ]
        : []),
      ...(showRawWinRate
        ? [
            columnHelper.accessor((row) => row.rawWinRate?.winRate ?? -1, {
              id: "rawWinRate",
              header: () => (
                <span className="inline-flex items-center">
                  Win Rate
                  <InfoTooltip text={RAW_WIN_RATE_EXPLANATION} />
                </span>
              ),
              cell: ({ row }) => {
                const rawRate = row.original.rawWinRate;
                if (!rawRate) {
                  return <span className="text-sm text-zinc-400">—</span>;
                }
                const pct = (rawRate.winRate * 100).toFixed(1);
                return (
                  <div className="group relative">
                    <span className="font-mono text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {pct}%
                    </span>
                    <div className="absolute -top-10 left-0 z-50 hidden rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white group-hover:block">
                      {rawRate.wins.toFixed(1)} wins / {rawRate.losses.toFixed(1)} losses (equal
                      weight)
                    </div>
                  </div>
                );
              },
              sortingFn: (a, b) => {
                const aVal = a.original.rawWinRate?.winRate ?? -1;
                const bVal = b.original.rawWinRate?.winRate ?? -1;
                return aVal - bVal;
              },
            }),
          ]
        : []),
      columnHelper.display({
        id: "history",
        header: "History",
        cell: ({ row }) => (
          <Sparkline history={row.original.scoreHistory} draftTimeline={draftTimeline} />
        ),
      }),
      columnHelper.accessor((row) => row.draftsPickedIn, {
        id: "timesPicked",
        header: "Drafts Picked",
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
      columnHelper.display({
        id: "notes",
        header: "Notes",
        cell: ({ row }) => {
          const notes: React.ReactNode[] = [];
          const copies = currentCubeCopies[row.original.cardName] || 1;

          // Low confidence warning for cards in only 1 draft
          if (row.original.timesAvailable === 1) {
            notes.push(
              <span
                key="low-conf"
                className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              >
                Low confidence
              </span>
            );
          }

          // Multiple copies indicator (from current pool)
          if (copies >= 2) {
            notes.push(
              <span
                key="copies"
                className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
              >
                {copies} copies
              </span>
            );
          }

          if (notes.length === 0) return null;
          return <div className="flex flex-wrap gap-1">{notes}</div>;
        },
      }),
    ],
    [currentCubeCopies, showWinEquity, showRawWinRate, draftTimeline]
  );

  const filteredData = useMemo(() => {
    return filterCardsByColor(cards, colorFilter, colorFilterMode);
  }, [cards, colorFilter, colorFilterMode]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table API is incompatible with React Compiler memoization
  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div>
      {/* Mobile-only help text */}
      <div className="mb-4 space-y-4 rounded-lg bg-zinc-100 p-3 text-xs whitespace-pre-line text-zinc-600 md:hidden dark:bg-zinc-800 dark:text-zinc-400">
        <div>
          <p className="mb-2 font-semibold text-zinc-700 dark:text-zinc-300">Pick Score</p>
          {PICK_EXPLANATION}
        </div>
        <div>
          <p className="mb-2 font-semibold text-zinc-700 dark:text-zinc-300">Win Equity</p>
          {WIN_EQUITY_EXPLANATION}
        </div>
        <div>
          <p className="mb-2 font-semibold text-zinc-700 dark:text-zinc-300">Win Rate</p>
          {RAW_WIN_RATE_EXPLANATION}
        </div>
      </div>

      <div className="relative">
        {/* Scroll shadow indicators */}
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 z-10 w-8 bg-gradient-to-l from-white to-transparent md:hidden dark:from-zinc-900" />
        <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-zinc-200 [-webkit-overflow-scrolling:touch] dark:border-zinc-700">
          <table className="w-full text-left">
            <thead className="bg-zinc-50 dark:bg-zinc-800">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className={`px-4 py-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300 ${
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
                    colSpan={columns.length}
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
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3">
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
