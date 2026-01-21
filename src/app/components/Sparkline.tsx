"use client";

import type { DraftScore } from "@/core/types";

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
  if (!history || history.length === 0) {
    return <span className="text-xs text-zinc-400">-</span>;
  }

  const width = 80;
  const height = 24;
  const padding = 2;
  const dotRadius = 3;

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
    <div className="group relative">
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
            r={dotRadius}
            fill={p.wasPicked ? "#3b82f6" : "#ef4444"}
            stroke="white"
            strokeWidth={1}
          />
        ))}
      </svg>
      {/* Tooltip on hover */}
      <div className="absolute -top-8 left-0 z-50 hidden rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white group-hover:block">
        {history.map((h, i) => {
          // Format: "Pick X", "Pick X (4/5)" for aggregated, or "unpicked"
          let pickLabel: string;
          if (h.pickedCount !== undefined && h.totalCount !== undefined) {
            // Aggregated date - show (picked/total) suffix
            pickLabel = h.pickedCount === 0
              ? `unpicked (0/${h.totalCount})`
              : `Pick ${h.pickPosition} (${h.pickedCount}/${h.totalCount})`;
          } else {
            // Single draft
            pickLabel = h.wasPicked ? `Pick ${h.pickPosition}` : "unpicked";
          }
          return (
            <div key={i}>
              {h.date}: {pickLabel}
            </div>
          );
        })}
      </div>
    </div>
  );
}
