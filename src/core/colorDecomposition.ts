import { wilsonInterval } from "./wilsonInterval";

export type ColorWinData = { color: string; wins: number; losses: number };

export type DecomposedColorStats = {
  color: string;
  wins: number;
  losses: number;
  winRate: number;
  ciLower: number;
  ciUpper: number;
};

/**
 * Decompose color pair win rates into individual color buckets.
 * "WU" with 10 wins contributes 10 wins to both W and U.
 * "C" (colorless) stays as "C". Results sorted in WUBRGC order.
 */
export function decomposeColorPairs(
  colorData: ColorWinData[],
): DecomposedColorStats[] {
  const buckets = new Map<string, { wins: number; losses: number }>();
  for (const c of colorData) {
    const colors = c.color === "C" ? ["C"] : c.color.split("");
    for (const color of colors) {
      if (!buckets.has(color)) buckets.set(color, { wins: 0, losses: 0 });
      const b = buckets.get(color)!;
      b.wins += c.wins;
      b.losses += c.losses;
    }
  }
  const order = "WUBRGC";
  return [...buckets.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([color, { wins, losses }]) => {
      const total = wins + losses;
      const { lower: ciLower, upper: ciUpper } = wilsonInterval(wins, total);
      return {
        color,
        wins,
        losses,
        winRate: total > 0 ? wins / total : 0,
        ciLower,
        ciUpper,
      };
    });
}
