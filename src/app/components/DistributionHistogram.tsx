"use client";

/**
 * Mini histogram showing pick distribution across 5 buckets.
 * Each bar represents a pick range:
 *   Bucket 0: "1-10" (early)
 *   Bucket 1: "11-20" (mid-early)
 *   Bucket 2: "21-30" (mid)
 *   Bucket 3: "31-40" (mid-late)
 *   Bucket 4: "41+" (late)
 */

type Props = {
  distribution: number[]; // 5-element array of counts
};

const BUCKET_LABELS = ["1-10", "11-20", "21-30", "31-40", "41+"];
const BUCKET_NAMES = ["early", "mid-early", "mid", "mid-late", "late"];

export function DistributionHistogram({ distribution }: Props) {
  // Empty state: show dash if no picks
  const total = distribution.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return <span className="text-xs text-zinc-400">-</span>;
  }

  const width = 60;
  const height = 24;
  const padding = 2;
  const barCount = 5;
  const barGap = 2;
  const barWidth = (width - padding * 2 - barGap * (barCount - 1)) / barCount;

  // Find max count to normalize bar heights
  const maxCount = Math.max(...distribution, 1);
  const maxBarHeight = height - padding * 2;

  // Calculate bar positions and heights
  const bars = distribution.map((count, i) => {
    const barHeight = (count / maxCount) * maxBarHeight;
    const x = padding + i * (barWidth + barGap);
    const y = height - padding - barHeight;
    return {
      x,
      y,
      width: barWidth,
      height: Math.max(barHeight, count > 0 ? 2 : 0), // Minimum 2px if has picks
      count,
      label: BUCKET_LABELS[i],
      name: BUCKET_NAMES[i],
    };
  });

  return (
    <div className="group relative">
      <svg width={width} height={height} className="overflow-visible">
        {/* Background slots for each bar (shows empty state) */}
        {bars.map((bar, i) => (
          <rect
            key={`bg-${i}`}
            x={bar.x}
            y={padding}
            width={bar.width}
            height={maxBarHeight}
            fill="#27272a"
            rx={1}
          />
        ))}
        {/* Foreground bars (actual data) */}
        {bars.map((bar, i) => (
          bar.count > 0 && (
            <rect
              key={`bar-${i}`}
              x={bar.x}
              y={height - padding - bar.height}
              width={bar.width}
              height={bar.height}
              fill="#a1a1aa"
              rx={1}
            />
          )
        ))}
      </svg>
      {/* Tooltip on hover */}
      <div className="absolute -top-20 left-0 z-50 hidden rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white group-hover:block">
        {bars.map((bar, i) => (
          <div key={i}>
            {bar.label} ({bar.name}): {bar.count}
          </div>
        ))}
      </div>
    </div>
  );
}
