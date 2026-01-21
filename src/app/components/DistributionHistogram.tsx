"use client";

import { useState } from "react";
import {
  DISTRIBUTION_BUCKET_COUNT,
  DISTRIBUTION_BUCKET_SIZE,
} from "@/core/calculateStats";

/**
 * Mini histogram showing pick distribution across 15 buckets.
 * Each bucket covers 30 picks (1-30, 31-60, etc.)
 */

type Props = {
  distribution: number[]; // 15-element array of counts
};

export function DistributionHistogram({ distribution }: Props) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Empty state: show dash if no picks
  const total = distribution.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return <span className="text-xs text-zinc-400">-</span>;
  }

  const width = 60;
  const height = 24;
  const padding = 2;
  const barCount = DISTRIBUTION_BUCKET_COUNT;
  const barGap = 1;
  const barWidth = (width - padding * 2 - barGap * (barCount - 1)) / barCount;

  // Find max count to normalize bar heights
  const maxCount = Math.max(...distribution, 1);
  const maxBarHeight = height - padding * 2;

  // Calculate bar positions, heights, and labels
  const bars = distribution.map((count, i) => {
    const barHeight = (count / maxCount) * maxBarHeight;
    const x = padding + i * (barWidth + barGap);
    const startPick = i * DISTRIBUTION_BUCKET_SIZE + 1;
    const endPick = (i + 1) * DISTRIBUTION_BUCKET_SIZE;
    return {
      x,
      width: barWidth,
      height: Math.max(barHeight, count > 0 ? 2 : 0), // Minimum 2px if has picks
      count,
      tooltip: `Pick ${startPick}-${endPick}: ${count}`,
    };
  });

  const hoveredBar = hoveredIndex !== null ? bars[hoveredIndex] : null;

  return (
    <div className="relative">
      <svg width={width} height={height} className="overflow-visible">
        {/* Each bar group */}
        {bars.map((bar, i) => {
          const isHovered = hoveredIndex === i;
          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              style={{ cursor: "default" }}
            >
              {/* Background slot */}
              <rect
                x={bar.x}
                y={padding}
                width={bar.width}
                height={maxBarHeight}
                fill={isHovered ? "#3f3f46" : "#27272a"}
                rx={1}
              />
              {/* Foreground bar (actual data) */}
              {bar.count > 0 && (
                <rect
                  x={bar.x}
                  y={height - padding - bar.height}
                  width={bar.width}
                  height={bar.height}
                  fill={isHovered ? "#d4d4d8" : "#a1a1aa"}
                  rx={1}
                />
              )}
            </g>
          );
        })}
      </svg>
      {/* Tooltip - hidden on mobile/touch devices */}
      {hoveredBar && (
        <div className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white md:block">
          {hoveredBar.tooltip}
        </div>
      )}
    </div>
  );
}
