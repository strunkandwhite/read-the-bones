"use client";

import { useState, useMemo } from "react";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import { decomposeColorPairs } from "@/core/colorDecomposition";
import { useSlowRenderTracking } from "../hooks/useSlowRenderTracking";

// ─── Info Tooltip ─────────────────────────────────────────────────

function InfoTooltip({ text }: { text: string }) {
  return (
    <div className="group relative ml-1.5 inline-block">
      <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-zinc-200 text-xs text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
        ?
      </span>
      <div className="absolute top-6 right-0 z-50 hidden w-72 rounded-lg bg-zinc-800 p-3 text-xs leading-relaxed whitespace-pre-line text-white shadow-xl group-hover:block dark:bg-zinc-900">
        {text}
      </div>
    </div>
  );
}

const SEAT_EXPLANATION = `Game win rate per draft seat position, aggregated across all 10-seat drafts. Drafts with a different number of seats are excluded since seat position is not comparable across different draft sizes.

Each bar shows the proportion of games won by players in that seat. The shaded band is a 95% Wilson confidence interval — wider bands mean fewer games and less certainty. The dashed line marks 50%.`;

const COLOR_PAIR_EXPLANATION = `Game win rate by deck color pair, for the selected drafts.

Deck color is inferred from maindecked cards: the most frequent color is always included, and a second color counts if it appears in at least 30% as many cards as the first. This distinguishes true two-color decks from minor splashes.

Changes when you filter drafts, since different cube versions have different color balance.`;

const COLOR_INDIVIDUAL_EXPLANATION = `Game win rate by individual color, for the selected drafts.

Each color's record includes all decks containing that color. A WR deck's wins count toward both W and R. Sample sizes are larger than in the pair view because two-color decks contribute to two buckets.

Changes when you filter drafts, since different cube versions have different color balance.`;

// ─── Shared Histogram ─────────────────────────────────────────────

type BarDatum = {
  label: string;
  winRate: number;
  ciLower: number;
  ciUpper: number;
  wins: number;
  losses: number;
};

type BarTheme = {
  bar: string;
  ci: string;
  whisker: string;
};

const BLUE_THEME: BarTheme = {
  bar: "fill-blue-500 dark:fill-blue-400",
  ci: "fill-blue-300/40 dark:fill-blue-500/25",
  whisker: "stroke-blue-300 dark:stroke-blue-400",
};

const AMBER_THEME: BarTheme = {
  bar: "fill-amber-500 dark:fill-amber-400",
  ci: "fill-amber-300/40 dark:fill-amber-500/25",
  whisker: "stroke-amber-300 dark:stroke-amber-400",
};

// Chart uses viewBox so it scales to fill container width
const VIEWBOX_W = 400;
const CHART_HEIGHT = 140;
const MARGIN = { top: 12, right: 4, bottom: 24, left: 36 };
const INNER_H = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

function WinRateHistogram({
  bars,
  theme,
}: {
  bars: BarDatum[];
  theme: BarTheme;
}) {
  if (bars.length === 0) return null;

  const innerW = VIEWBOX_W - MARGIN.left - MARGIN.right;

  // Y domain: always include 50%, extend to fit CI
  const allUpper = bars.map((b) => b.ciUpper);
  const allLower = bars.map((b) => b.ciLower);
  const dataMax = Math.max(...allUpper, 0.5);
  const dataMin = Math.min(...allLower, 0.5);
  const yMax = Math.min(1, Math.ceil(dataMax * 10 + 0.5) / 10);
  const yMin = Math.max(0, Math.floor(dataMin * 10 - 0.5) / 10);
  const yRange = yMax - yMin;

  const toY = (v: number) =>
    MARGIN.top + INNER_H * (1 - (v - yMin) / yRange);

  const barCount = bars.length;
  const barGap = Math.max(2, Math.min(8, (innerW / barCount) * 0.2));
  const barWidth = (innerW - barGap * (barCount - 1)) / barCount;

  // Grid ticks — every 10%
  const ticks: number[] = [];
  for (let v = Math.ceil(yMin * 10) / 10; v <= yMax + 0.001; v += 0.1) {
    ticks.push(Math.round(v * 100) / 100);
  }

  const show50Line = yMin < 0.5 && yMax > 0.5;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_W} ${CHART_HEIGHT}`}
      className="w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Grid lines */}
      {ticks.map((v) => (
        <g key={v}>
          <line
            x1={MARGIN.left}
            x2={VIEWBOX_W - MARGIN.right}
            y1={toY(v)}
            y2={toY(v)}
            className="stroke-zinc-200 dark:stroke-zinc-800"
            strokeWidth={0.5}
          />
          <text
            x={MARGIN.left - 4}
            y={toY(v)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-zinc-400 dark:fill-zinc-600 font-mono"
            fontSize={9}
          >
            {(v * 100).toFixed(0)}%
          </text>
        </g>
      ))}

      {/* 50% reference line */}
      {show50Line && (
        <line
          x1={MARGIN.left}
          x2={VIEWBOX_W - MARGIN.right}
          y1={toY(0.5)}
          y2={toY(0.5)}
          className="stroke-zinc-400 dark:stroke-zinc-600"
          strokeWidth={0.75}
          strokeDasharray="3 3"
        />
      )}

      {/* Bars */}
      {bars.map((b, i) => {
        const x = MARGIN.left + i * (barWidth + barGap);
        const barTop = toY(b.winRate);
        const barBottom = toY(yMin);
        const ciTop = toY(b.ciUpper);
        const ciBottom = toY(b.ciLower);

        // Bottom CI whisker is inside the bar — render it last with
        // a white/dark stroke so it's visible against the fill
        const bottomWhiskerInBar = b.ciLower < b.winRate;

        return (
          <g key={b.label}>
            {/* CI band */}
            <rect
              x={x + barWidth * 0.1}
              y={ciTop}
              width={barWidth * 0.8}
              height={ciBottom - ciTop}
              rx={1.5}
              className={theme.ci}
            />

            {/* Win rate bar */}
            <rect
              x={x + barWidth * 0.2}
              y={barTop}
              width={barWidth * 0.6}
              height={barBottom - barTop}
              rx={1}
              className={theme.bar}
            />

            {/* Top CI whisker — above the bar, uses theme color */}
            <line
              x1={x + barWidth * 0.2}
              x2={x + barWidth * 0.8}
              y1={ciTop}
              y2={ciTop}
              className={theme.whisker}
              strokeWidth={1}
            />

            {/* Bottom CI whisker — on top of bar, uses contrasting color */}
            <line
              x1={x + barWidth * 0.2}
              x2={x + barWidth * 0.8}
              y1={ciBottom}
              y2={ciBottom}
              className={
                bottomWhiskerInBar
                  ? "stroke-white/70 dark:stroke-white/40"
                  : theme.whisker
              }
              strokeWidth={1}
            />

            {/* X-axis label */}
            <text
              x={x + barWidth / 2}
              y={CHART_HEIGHT - 6}
              textAnchor="middle"
              className="fill-zinc-500 dark:fill-zinc-400 font-mono"
              fontSize={9}
            >
              {b.label}
            </text>

            {/* Tooltip */}
            <title>
              {`${b.label}: ${(b.winRate * 100).toFixed(1)}% (${b.wins}W ${b.losses}L) · 95% CI: ${(b.ciLower * 100).toFixed(1)}–${(b.ciUpper * 100).toFixed(1)}%`}
            </title>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────────────

interface DraftStatsProps {
  data: DraftStatsResponse;
}

type ColorMode = "pairs" | "individual";

export function DraftStats({ data }: DraftStatsProps) {
  useSlowRenderTracking("draft_stats");
  const { winRateBySeat, winRateByColor } = data;
  const [colorMode, setColorMode] = useState<ColorMode>("pairs");

  const seatBars: BarDatum[] = useMemo(
    () =>
      winRateBySeat.map((s) => ({
        label: String(s.seat),
        winRate: s.winRate,
        ciLower: s.ciLower,
        ciUpper: s.ciUpper,
        wins: s.wins,
        losses: s.losses,
      })),
    [winRateBySeat]
  );

  const colorPairBars: BarDatum[] = useMemo(
    () =>
      winRateByColor.map((c) => ({
        label: c.color,
        winRate: c.winRate,
        ciLower: c.ciLower,
        ciUpper: c.ciUpper,
        wins: c.wins,
        losses: c.losses,
      })),
    [winRateByColor]
  );

  const colorIndividualBars: BarDatum[] = useMemo(
    () =>
      decomposeColorPairs(winRateByColor).map((c) => ({
        label: c.color,
        winRate: c.winRate,
        ciLower: c.ciLower,
        ciUpper: c.ciUpper,
        wins: c.wins,
        losses: c.losses,
      })),
    [winRateByColor],
  );

  if (winRateBySeat.length === 0 && winRateByColor.length === 0) {
    return null;
  }

  const activeColorBars =
    colorMode === "pairs" ? colorPairBars : colorIndividualBars;
  const activeColorExplanation =
    colorMode === "pairs"
      ? COLOR_PAIR_EXPLANATION
      : COLOR_INDIVIDUAL_EXPLANATION;

  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-2">
      {seatBars.length > 0 && (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 pt-3 pb-2 dark:border-zinc-700 dark:bg-zinc-900/60">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Win Rate by Seat
            </h3>
            <InfoTooltip text={SEAT_EXPLANATION} />
          </div>
          <WinRateHistogram bars={seatBars} theme={BLUE_THEME} />
        </div>
      )}

      {activeColorBars.length > 0 && (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 pt-3 pb-2 dark:border-zinc-700 dark:bg-zinc-900/60">
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Win Rate by Color
              </h3>
              <div className="flex rounded-md border border-zinc-300 text-[10px] dark:border-zinc-600">
                <button
                  type="button"
                  onClick={() => setColorMode("pairs")}
                  className={`cursor-pointer px-1.5 py-0.5 transition-colors ${
                    colorMode === "pairs"
                      ? "bg-zinc-200 font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
                      : "text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                  }`}
                >
                  Pairs
                </button>
                <button
                  type="button"
                  onClick={() => setColorMode("individual")}
                  className={`cursor-pointer border-l border-zinc-300 px-1.5 py-0.5 transition-colors dark:border-zinc-600 ${
                    colorMode === "individual"
                      ? "bg-zinc-200 font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
                      : "text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                  }`}
                >
                  Individual
                </button>
              </div>
            </div>
            <InfoTooltip text={activeColorExplanation} />
          </div>
          <WinRateHistogram bars={activeColorBars} theme={AMBER_THEME} />
        </div>
      )}
    </div>
  );
}
