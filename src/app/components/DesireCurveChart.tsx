"use client";

import { useMemo, useState } from "react";
import {
  desireCurvePoints,
  desireIndex,
  formatDesireIndex,
  type DesireInputs,
} from "./desireCurve";

/**
 * Full desire-vs-pick curve for the card stats modal: where in the draft the
 * card's urgency wakes up. Closed-form from (worth, geomean, σ), with axes,
 * a hover readout, a geomean reference line, and a current-pick marker.
 *
 * Colors are hardcoded to the modal's dark surface (like DistributionHistogram)
 * because the modal background does not follow the page theme.
 */
export function DesireCurveChart({
  inputs,
  worthScale,
  totalPicks,
  currentPick,
}: {
  inputs: DesireInputs;
  /** Desire-index denominator: the cube's largest |worth| (see desireCurve.ts). */
  worthScale: number;
  totalPicks: number;
  /** Marked with a vertical line when a draft is in progress (> 1). */
  currentPick: number;
}) {
  const width = 320;
  const height = 110;
  const pad = { top: 8, right: 8, bottom: 18, left: 40 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const geometry = useMemo(() => {
    const points = desireCurvePoints(inputs, totalPicks, 128);
    if (points.length < 2) return null;

    // Symmetric y-domain around zero: equal magnitudes read equally, and the
    // zero baseline always sits mid-plot.
    const maxAbs = Math.max(...points.map((p) => Math.abs(p.desire)), 0.005);
    const xFor = (pickN: number) =>
      pad.left + ((pickN - 1) / (totalPicks - 1)) * plotWidth;
    const yFor = (desire: number) =>
      pad.top + plotHeight / 2 - (desire / maxAbs) * (plotHeight / 2);

    const linePath = points
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"} ${xFor(p.pickN).toFixed(1)} ${yFor(p.desire).toFixed(1)}`,
      )
      .join(" ");

    // X ticks every 100 picks plus the final pick.
    const xTicks: number[] = [1];
    for (let n = 100; n < totalPicks; n += 100) xTicks.push(n);
    xTicks.push(totalPicks);

    return { points, maxAbs, xFor, yFor, linePath, xTicks };
  }, [inputs, totalPicks, pad.left, pad.top, plotWidth, plotHeight]);

  if (!geometry) return null;

  const { points, maxAbs, xFor, yFor, linePath, xTicks } = geometry;
  const lineColor = inputs.worth >= 0 ? "#3b82f6" : "#ef4444";
  const zeroY = yFor(0);
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dist = Math.abs(xFor(points[i].pickN) - x);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Desire by pick position"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Y extremes + zero baseline (recessive) */}
        <line x1={pad.left} y1={zeroY} x2={width - pad.right} y2={zeroY} stroke="#3f3f46" strokeWidth={1} />
        <text x={pad.left - 5} y={zeroY + 3} textAnchor="end" fontSize={9} fill="#71717a">
          0
        </text>
        <text x={pad.left - 5} y={pad.top + 4} textAnchor="end" fontSize={9} fill="#71717a">
          {`+${Math.round(Math.abs(desireIndex(maxAbs, worthScale) ?? 0))}`}
        </text>
        <text x={pad.left - 5} y={pad.top + plotHeight} textAnchor="end" fontSize={9} fill="#71717a">
          {`-${Math.round(Math.abs(desireIndex(maxAbs, worthScale) ?? 0))}`}
        </text>

        {/* X ticks */}
        {xTicks.map((tick) => (
          <g key={tick}>
            <line x1={xFor(tick)} y1={pad.top + plotHeight} x2={xFor(tick)} y2={pad.top + plotHeight + 3} stroke="#3f3f46" strokeWidth={1} />
            <text x={xFor(tick)} y={height - 5} textAnchor="middle" fontSize={9} fill="#71717a">
              {tick}
            </text>
          </g>
        ))}

        {/* Pick score (geomean) reference line */}
        {inputs.geomean >= 1 && inputs.geomean <= totalPicks && (
          <line
            x1={xFor(inputs.geomean)}
            y1={pad.top}
            x2={xFor(inputs.geomean)}
            y2={pad.top + plotHeight}
            stroke="#a1a1aa"
            strokeWidth={1}
            strokeDasharray="1 3"
          />
        )}

        {/* Current pick marker */}
        {currentPick > 1 && currentPick <= totalPicks && (
          <line
            x1={xFor(currentPick)}
            y1={pad.top}
            x2={xFor(currentPick)}
            y2={pad.top + plotHeight}
            stroke="#71717a"
            strokeWidth={1}
            strokeDasharray="3 2"
          />
        )}

        {/* Data line */}
        <path d={linePath} fill="none" stroke={lineColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {/* Hover crosshair + marker */}
        {hovered && (
          <g>
            <line x1={xFor(hovered.pickN)} y1={pad.top} x2={xFor(hovered.pickN)} y2={pad.top + plotHeight} stroke="#52525b" strokeWidth={1} />
            <circle cx={xFor(hovered.pickN)} cy={yFor(hovered.desire)} r={3.5} fill={lineColor} stroke="#1a1917" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white md:block">
          Pick {hovered.pickN}: desire{" "}
          {formatDesireIndex(desireIndex(hovered.desire, worthScale) ?? 0)}
        </div>
      )}
    </div>
  );
}
