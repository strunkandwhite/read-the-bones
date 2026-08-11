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
import type { WorthCard } from "@/core/worthModel";
import { filterCardsByColor } from "@/core/colorFilter";
import { displayManaCost } from "@/core/manaCost";
import { ManaSymbols, ColorPills } from "./ManaSymbols";
import { CardNameCell } from "./CardNameCell";
import { track } from "@vercel/analytics/react";
import { useSlowRenderTracking } from "../hooks/useSlowRenderTracking";
import { InfoTooltip } from "./InfoTooltip";
import { useCardStore } from "../stores/cardStore";
import { useDraftStore } from "../stores/draftStore";
import { useCardStatuses } from "../stores/selectors";
import { isLocalClient } from "@/core/isLocal";
import { desireAt, desireIndex, formatDesireIndex, maxAbsWorth } from "./desireCurve";
import { formatSignedPercent, formatSignedZ } from "./worthFormat";

export interface CardTableProps {
  cards: EnrichedCardStats[];
  onCardClick?: (cardName: string) => void;
}

const columnHelper = createColumnHelper<EnrichedCardStats>();

export const WORTH_EXPLANATION = `Best estimate of the win-rate points this card adds to a deck, vs its color's baseline.

Observed deck win rate shrunk toward zero in proportion to sample noise — the market's opinion of the card plays no part. Cards under the games threshold fall back to the price curve ("prior only").`;

export const DESIRE_EXPLANATION = `Worth × the odds you don't get another look: the chance the card is taken within one snake turn (20 picks), floored by how overdue it already is. A card past its market window reads at full strength — "it wheeled twice, it'll wheel again" is how good cards get lost.

An index from −100 to 100: ±100 is the cube's strongest quality signal fully on the line ("do not touch" ↔ "grab it now"). "—" = danger is remote, nothing is on the line yet. Evaluated at the pick in the header: the live draft's current pick, or pick 1 when no draft is in progress. The card's stats modal charts the full curve by pick.`;

export const PVI_EXPLANATION = `Pick Value Index: how far results diverge from what the card's price predicts, in standard errors (σ).

Positive = the table underprices it. Negative = the table overpays.`;

const PICK_EXPLANATION = `Weighted geometric mean of pick positions across all drafts.

Weighting factors:
• Copy weight: 0.5^(n-1) for nth copy
• Unpicked cards: 0.5x weight (position set to pool size)
• Session recency: a recent draft counts for more than an old one, and drafts sharing a date count as one session, not one per pod`;

/** Shared cell renderer for the dev-only Worth and PVI columns. */
function renderWorthModelValue(
  worthCard: WorthCard | undefined,
  value: number | null | undefined,
  format: (value: number) => string = formatSignedPercent
) {
  if (!worthCard || worthCard.no_data || value == null) {
    return <span className="text-sm text-zinc-400 dark:text-zinc-500">—</span>;
  }
  return (
    <span
      className="font-mono text-sm font-semibold text-zinc-800 dark:text-zinc-200"
      title={`${worthCard.games} games${worthCard.prior_only ? " · prior only" : ""}`}
    >
      {format(value)}
    </span>
  );
}

export function CardTable({ cards, onCardClick }: CardTableProps) {
  useSlowRenderTracking("card_table");

  // Read from stores
  const colorFilter = useCardStore((s) => s.colorFilter);
  const colorFilterMode = useCardStore((s) => s.colorFilterMode);
  const currentCubeCopies = useCardStore((s) => s.cardData).cubeCopies;
  const takenCardNames = useCardStore((s) => s.takenCardNamesSet);
  const takenCardCounts = useCardStore((s) => s.takenCardCounts);
  const seatCardNames = useCardStore((s) => s.seatCardNames);
  const worthCards = useCardStore((s) => s.worthCards);
  const worthModel = useCardStore((s) => s.worthModel);
  const board = useDraftStore((s) => s.board);
  const liveDraftStatus = useDraftStore((s) => s.liveDraftStatus);

  // Desire is state-dependent: evaluated at the live draft's current pick
  // while drafting, at pick 1 (a draft-start priority board) otherwise.
  // The dev-only settings override wins over both when set.
  //
  // board.picks.length is not a reliable pick count once ingest-time
  // redaction is live: opted-out seats' picks are never stored, so the
  // array undercounts by the number of redacted picks while pick_n keeps
  // its structural gaps. latestPickN (MAX(pick_n), robust to gaps) is the
  // correct source; board.picks.length is only a fallback for the moment
  // board is populated before liveDraftStatus (both are set together from
  // the same /live response, so in practice they never diverge).
  const desirePickOverride = useCardStore((s) => s.desirePickOverride);
  const isDrafting = board?.phase === "drafting" && Array.isArray(board.picks);
  const currentPick =
    desirePickOverride ??
    (isDrafting ? (liveDraftStatus?.latestPickN ?? board!.picks.length) + 1 : 1);

  // Desire-index denominator: the cube's largest |worth| (see desireCurve.ts).
  const worthScale = useMemo(() => maxAbsWorth(worthCards.values()), [worthCards]);

  const [sorting, setSorting] = useState<SortingState>([{ id: "pickScore", desc: false }]);

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
      worth: isDesktopOrWider,
      pvi: isDesktopOrWider,
      desire: isDesktopOrWider,
    };
  }, [breakpoint, isDesktopOrWider]);

  // Compute card names for status subscription — derived from the full cards list
  // (not filteredData) so virtualized rows always have a status even before filtering.
  const allCardNames = useMemo(() => cards.map((c) => c.cardName), [cards]);

  // Single subscription for all card statuses — subscribes to queue/float/taken inputs
  // so status icons update reactively without depending on parent re-renders.
  const cardStatusMap = useCardStatuses(allCardNames);

  // Keep a ref updated every render so column cell renderers always read the current
  // status map without the columns memo needing to declare it as a dependency.
  // Assigning during render (not via useEffect) ensures the latest value is available
  // on the same render cycle that caused the status change.
  const cardStatusMapRef = useRef(cardStatusMap);
  cardStatusMapRef.current = cardStatusMap;

  const takenCardCountsRef = useRef(takenCardCounts);
  useEffect(() => {
    takenCardCountsRef.current = takenCardCounts;
  }, [takenCardCounts]);

  const handleSortingChange = useCallback(
    (updater: SortingState | ((prev: SortingState) => SortingState)) => {
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
    },
    []
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => row.cardName, {
        id: "card",
        header: "Card",
        size: 260,
        cell: ({ row }) => {
          const cs = cardStatusMapRef.current?.get(row.original.cardName);
          return (
            <CardNameCell
              card={row.original}
              cubeCopies={currentCubeCopies[row.original.cardName]}
              remainingCopies={
                takenCardCountsRef.current
                  ? (currentCubeCopies[row.original.cardName] ?? 1) -
                    (takenCardCountsRef.current.get(row.original.cardName) ?? 0)
                  : undefined
              }
              cardStatus={cs?.status === "taken" ? "none" : (cs?.status ?? "none")}
              queuePosition={cs?.queuePosition}
            />
          );
        },
      }),
      columnHelper.accessor((row) => row.scryfall?.manaValue ?? 0, {
        id: "manaCost",
        header: "Cost",
        // Wide enough that a two-face cost like {2}{R} // {1}{R} stays on one line.
        size: 112,
        cell: ({ row }) => <ManaSymbols cost={displayManaCost(row.original.scryfall)} />,
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
      columnHelper.accessor(
        (row) =>
          row.weightedGeomean != null && isFinite(row.weightedGeomean)
            ? row.weightedGeomean
            : undefined,
        {
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
        }
      ),
      ...(isLocalClient()
        ? [
            columnHelper.accessor(
              (row) => {
                const worthCard = worthCards.get(row.cardName);
                return worthCard != null && !worthCard.no_data && worthCard.worth != null
                  ? worthCard.worth
                  : undefined;
              },
              {
                id: "worth",
                size: 90,
                sortUndefined: "last",
                header: () => (
                  <span className="inline-flex items-center">
                    Worth
                    <InfoTooltip align="right" text={WORTH_EXPLANATION} />
                  </span>
                ),
                cell: ({ row }) => {
                  const worthCard = worthCards.get(row.original.cardName);
                  return renderWorthModelValue(worthCard, worthCard?.worth);
                },
              }
            ),
            columnHelper.accessor(
              (row) => {
                const worthCard = worthCards.get(row.cardName);
                return worthCard != null && !worthCard.no_data && worthCard.pvi != null
                  ? worthCard.pvi
                  : undefined;
              },
              {
                id: "pvi",
                size: 85,
                sortUndefined: "last",
                header: () => (
                  <span className="inline-flex items-center">
                    PVI
                    <InfoTooltip align="right" text={PVI_EXPLANATION} />
                  </span>
                ),
                cell: ({ row }) => {
                  const worthCard = worthCards.get(row.original.cardName);
                  return renderWorthModelValue(worthCard, worthCard?.pvi, formatSignedZ);
                },
              }
            ),
            columnHelper.accessor(
              (row) => {
                const worthCard = worthCards.get(row.cardName);
                if (
                  worthCard == null ||
                  worthCard.no_data ||
                  worthCard.worth == null ||
                  worthCard.geomean == null ||
                  worthModel == null ||
                  worthModel.sigma <= 0
                ) {
                  return undefined;
                }
                const index = desireIndex(
                  desireAt(currentPick, {
                    worth: worthCard.worth,
                    geomean: worthCard.geomean,
                    sigma: worthModel.sigma,
                  }),
                  worthScale
                );
                return index ?? undefined;
              },
              {
                id: "desire",
                size: 105,
                sortUndefined: "last",
                header: () => (
                  <span className="inline-flex items-center">
                    Desire ({currentPick})
                    <InfoTooltip align="right" text={DESIRE_EXPLANATION} />
                  </span>
                ),
                cell: ({ row, getValue }) => {
                  const worthCard = worthCards.get(row.original.cardName);
                  const value = getValue();
                  if (worthCard == null || value === undefined) {
                    return <span className="text-sm text-zinc-400 dark:text-zinc-500">—</span>;
                  }
                  const label = formatDesireIndex(value);
                  if (label === "—") {
                    return <span className="text-sm text-zinc-400 dark:text-zinc-500">—</span>;
                  }
                  const flags = [
                    worthCard.prior_only ? "prior only" : null,
                    worthCard.is_land ? "land (unreliable)" : null,
                  ].filter(Boolean);
                  return (
                    <span
                      className="font-mono text-sm font-semibold text-zinc-800 dark:text-zinc-200"
                      title={[`${worthCard.games} games`, ...flags].join(" · ")}
                    >
                      {label}
                    </span>
                  );
                },
              }
            ),
          ]
        : []),
    ],
    [currentCubeCopies, worthCards, worthModel, currentPick, worthScale]
  );

  const filteredData = useMemo(() => {
    return filterCardsByColor(cards, colorFilter, colorFilterMode);
  }, [cards, colorFilter, colorFilterMode]);

  // TanStack caches each row's accessor values keyed ONLY by data identity
  // (getCoreRowModel memoizes on options.data; row.getValue caches per
  // column id). The worth/desire accessors close over store state, so their
  // cached values go stale when that state changes without a data refetch —
  // e.g. the worth table arriving after cards, or the desire pick override
  // changing. Cloning the array whenever any accessor input changes forces
  // the row model (and its value caches) to rebuild.
  const tableData = useMemo(
    () => [...filteredData],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the "unnecessary" deps ARE the point: they bust TanStack's per-row value caches when accessor inputs change
    [filteredData, worthCards, worthModel, currentPick, worthScale]
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table API is incompatible with React Compiler memoization
  const table = useReactTable({
    data: tableData,
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
      // Fill viewport minus bottom space for footer and page margin. The
      // shell is `overflow: hidden` (globals.css), so any height beyond
      // what's actually available is unreachable rather than merely
      // off-screen — never let the container exceed it, even in portrait
      // on a short phone where rect.top plus the old 400px floor could
      // overshoot window.innerHeight.
      const available = window.innerHeight - rect.top - 56;
      setScrollHeight(Math.max(0, available));
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
    // React 19 concurrent rendering can deliver scroll events mid-render, where
    // the virtualizer's flushSync trips "flushSync was called from inside a
    // lifecycle method" (TanStack/virtual#1094). Batched updates are fine here:
    // fixed-height rows with overscan never visibly lag a scroll frame.
    useFlushSync: false,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0;

  return (
    <div ref={containerRef}>
      <div className="relative">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
          <div ref={scrollContainerRef} style={{ height: scrollHeight, overflowY: "auto" }}>
            <table
              className={`w-full text-left ${isDesktopOrWider ? "table-fixed" : "table-auto"}`}
            >
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
                        className={`px-2 py-2 text-sm font-semibold text-zinc-700 sm:px-4 sm:py-3 dark:text-zinc-300 ${
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
                      <tr>
                        <td style={{ height: paddingTop, padding: 0, border: "none" }} />
                      </tr>
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
                        >
                          {row.getVisibleCells().map((cell) => (
                            <td key={cell.id} className="px-2 py-2 sm:px-4 sm:py-3">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                    {paddingBottom > 0 && (
                      <tr>
                        <td style={{ height: paddingBottom, padding: 0, border: "none" }} />
                      </tr>
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
