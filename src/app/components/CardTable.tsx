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
import { useVirtualizer } from "@tanstack/react-virtual";
import type { EnrichedCardStats } from "@/core/types";
import type { ColorFilterMode } from "@/core/colorFilter";
import { filterCardsByColor } from "@/core/colorFilter";
import { ManaSymbols, ColorPills } from "./ManaSymbols";
import { CardNameCell } from "./CardNameCell";
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
  onCardClick?: (cardName: string) => void;
}

const columnHelper = createColumnHelper<EnrichedCardStats>();


const PICK_EXPLANATION = `Weighted geometric mean of pick positions across all drafts.

Weighting factors:
• Copy weight: 0.5^(n-1) for nth copy
• Unpicked cards: 0.5x weight (position set to pool size)`;

export function CardTable({
  cards,
  colorFilter,
  colorFilterMode,
  currentCubeCopies,
  takenCardNames,
  seatCardNames,
  onCardClick,
}: CardTableProps) {
  useSlowRenderTracking("card_table");

  const [sorting, setSorting] = useState<SortingState>([{ id: "pickScore", desc: false }]);
  const lastHoverTrackRef = useRef(0);

  // Track responsive breakpoint based on actual container width (handles browser zoom)
  const [breakpoint, setBreakpoint] = useState<"mobile" | "tablet" | "desktop" | "wide">("wide");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0].contentRect.width;
      if (width >= 1200) setBreakpoint("wide");
      else if (width >= 940) setBreakpoint("desktop");
      else if (width >= 580) setBreakpoint("tablet");
      else setBreakpoint("mobile");
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Mobile: Card + P# only | Tablet: + Cost, Colors | Desktop/Wide: + Type
  const isDesktopOrWider = breakpoint === "desktop" || breakpoint === "wide";
  const columnVisibility: VisibilityState = useMemo(() => {
    const showSm = breakpoint !== "mobile";
    return {
      manaCost: showSm,
      type: isDesktopOrWider,
      colors: showSm,
    };
  }, [breakpoint, isDesktopOrWider]);

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
            cardStatus="none"
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
    ],
    [currentCubeCopies]
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

  // Virtualization: scroll container fills remaining viewport height
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollHeight, setScrollHeight] = useState<number>(600);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const updateHeight = () => {
      const rect = el.getBoundingClientRect();
      // Fill viewport minus bottom space for footer and page margin
      setScrollHeight(Math.max(400, window.innerHeight - rect.top - 56));
    };

    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const rows = table.getRowModel().rows;
  const ROW_HEIGHT_ESTIMATE = 48;

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 10,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0;

  return (
    <div ref={containerRef}>
      <div className="relative">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
          <div
            ref={scrollContainerRef}
            style={{ height: scrollHeight, overflowY: "auto" }}
          >
            <table className={`w-full text-left ${isDesktopOrWider ? "table-fixed" : "table-auto"}`}>
              {isDesktopOrWider && (
                <colgroup>
                  {table.getVisibleLeafColumns().map((col) => (
                    <col key={col.id} style={{ width: col.getSize() }} />
                  ))}
                </colgroup>
              )}
              <thead
                className="bg-zinc-50 dark:bg-zinc-800"
                style={{ position: "sticky", top: 0, zIndex: 20 }}
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
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={table.getVisibleLeafColumns().length}
                      className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400"
                    >
                      No cards found
                    </td>
                  </tr>
                ) : (
                  <>
                    {paddingTop > 0 && (
                      <tr><td style={{ height: paddingTop, padding: 0, border: "none" }} /></tr>
                    )}
                    {virtualRows.map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      return (
                        <tr
                          key={row.id}
                          data-index={virtualRow.index}
                          ref={rowVirtualizer.measureElement}
                          className="bg-white transition-colors hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                          style={{
                            cursor: onCardClick ? "pointer" : undefined,
                            opacity:
                              takenCardNames?.has(row.original.cardName) &&
                              !seatCardNames?.has(row.original.cardName)
                                ? 0.35
                                : 1,
                          }}
                          onClick={() => onCardClick?.(row.original.cardName)}
                          onMouseEnter={() => {
                            const now = Date.now();
                            if (now - lastHoverTrackRef.current > 5000) {
                              lastHoverTrackRef.current = now;
                              track("card_hover", { card_name: row.original.cardName });
                            }
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
                      );
                    })}
                    {paddingBottom > 0 && (
                      <tr><td style={{ height: paddingBottom, padding: 0, border: "none" }} /></tr>
                    )}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
