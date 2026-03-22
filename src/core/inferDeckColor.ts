/**
 * Infer a deck's color identity from its maindecked cards.
 *
 * Counts how often each color appears in the color_identity of maindecked
 * cards. The most frequent color is always included. A second color is
 * included if it appears at least 30% as often as the first — this
 * distinguishes a genuine two-color deck from a mono-color deck with a
 * minor splash. Colors beyond the second are not considered.
 *
 * Examples:
 * - 40 red cards, 2 blue cards → "R" (blue is < 30% of red)
 * - 30 red cards, 15 blue cards → "RU" (blue is 50% of red)
 * - 20 red cards, 20 blue cards → "RU" (equal)
 * - All colorless cards → "C"
 */
export function inferDeckColor(colorCounts: Map<string, number>): string {
  const sorted = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => color);

  if (sorted.length === 0) return "C";

  const colors: string[] = [sorted[0]];
  if (sorted.length >= 2) {
    const topCount = colorCounts.get(sorted[0]) || 0;
    const secondCount = colorCounts.get(sorted[1]) || 0;
    if (secondCount >= topCount * 0.3) {
      colors.push(sorted[1]);
    }
  }

  // Canonical WUBRG order
  const order = "WUBRG";
  colors.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return colors.join("");
}
