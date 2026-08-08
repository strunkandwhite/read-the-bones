"use client";

import { useState } from "react";
import type { DraftScore } from "@/core/types";

/**
 * Tooltip label for one point: "Pick 12", "Pick 12 (4/5)" for aggregated dates,
 * or the unpicked equivalents.
 */
function formatPickLabel(entry: DraftScore): string {
  if (entry.pickedCount !== undefined && entry.totalCount !== undefined) {
    return entry.pickedCount === 0
      ? `unpicked (0/${entry.totalCount})`
      : `Pick ${entry.pickPosition} (${entry.pickedCount}/${entry.totalCount})`;
  }
  return entry.wasPicked ? `Pick ${entry.pickPosition}` : "unpicked";
}

/**
 * Horizontal shift for a tooltip anchored at `x` on a chart `width` wide.
 * The tooltip is wider than a point's slot, so it is left-aligned, centered, or
 * right-aligned depending on which third of the chart the point falls in —
 * centering everything would spill past both ends.
 */
function tooltipShift(x: number, width: number): string {
  if (x < width / 3) return "0";
  if (x > (width * 2) / 3) return "-100%";
  return "-50%";
}

/**
 * Sparkline component for visualizing score history over drafts.
 * Shows pick positions as connected dots with color indicating picked vs unpicked.
 * When draftTimeline is provided, dots are positioned by draft index for equal spacing.
 */
export function Sparkline({
  history,
  draftTimeline,
}: {
  history: DraftScore[];
  /** Sorted array of all unique dates across all drafts (for shared x-axis positioning) */
  draftTimeline?: string[];
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (!history || history.length === 0) {
    return <span className="text-xs text-zinc-400">-</span>;
  }

  const width = 160;
  const height = 48;
  const padding = 4;
  const dotRadius = 3.5;

  // Calculate range from actual data with padding
  const positions = history.map((h) => h.pickPosition);
  const minPos = Math.max(1, Math.min(...positions) - 1);
  const maxPos = Math.max(...positions) + 1;
  const range = Math.max(maxPos - minPos, 2); // Ensure minimum range of 2

  // Compute x position based on draft timeline position
  const computeX = (date: string, index: number): number => {
    const usableWidth = width - padding * 2;

    if (draftTimeline && draftTimeline.length > 1) {
      // Position based on draft index in the global timeline (equal spacing)
      const draftIndex = draftTimeline.indexOf(date);
      const normalizedX = draftIndex / (draftTimeline.length - 1);
      return padding + normalizedX * usableWidth;
    } else {
      // Fallback: evenly spaced by local index (original behavior)
      if (history.length === 1) return width / 2;
      return padding + (index / (history.length - 1)) * usableWidth;
    }
  };

  // Normalize positions: lower pick = better = higher on chart
  const normalizedPoints = history.map((h, i) => {
    const normalizedY = (h.pickPosition - minPos) / range; // 0 = best (top), 1 = worst (bottom)
    return {
      x: computeX(h.date, i),
      y: padding + normalizedY * (height - padding * 2 - dotRadius * 2) + dotRadius,
      wasPicked: h.wasPicked,
      draftName: h.draftName,
      position: h.pickPosition,
    };
  });

  // Create path for the line
  const linePath = normalizedPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <div className="relative">
      <svg width={width} height={height} className="overflow-visible">
        {/* Line connecting points */}
        <path
          d={linePath}
          fill="none"
          stroke="#a1a1aa"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Dots for each draft */}
        {normalizedPoints.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={hoveredIndex === i ? dotRadius + 1.5 : dotRadius}
            fill={p.wasPicked ? "#3b82f6" : "#ef4444"}
            stroke="white"
            strokeWidth={1}
          />
        ))}
        {/* Transparent hover targets — the visible dots are too small to hit reliably */}
        {normalizedPoints.map((p, i) => (
          <circle
            key={`hit-${i}`}
            data-testid={`sparkline-hit-${i}`}
            cx={p.x}
            cy={p.y}
            r={9}
            fill="transparent"
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}
      </svg>
      {hoveredIndex !== null && (
        <div
          data-testid="sparkline-tooltip"
          className="pointer-events-none absolute bottom-full z-50 mb-1 rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white"
          style={{
            left: normalizedPoints[hoveredIndex].x,
            transform: `translateX(${tooltipShift(normalizedPoints[hoveredIndex].x, width)})`,
          }}
        >
          {history[hoveredIndex].date}: {formatPickLabel(history[hoveredIndex])}
        </div>
      )}
    </div>
  );
}
