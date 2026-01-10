/**
 * MTG color definitions shared across the codebase.
 */

export const MTG_COLORS = [
  { code: "W", label: "White" },
  { code: "U", label: "Blue" },
  { code: "B", label: "Black" },
  { code: "R", label: "Red" },
  { code: "G", label: "Green" },
  { code: "C", label: "Colorless" },
] as const;

export type ColorCode = (typeof MTG_COLORS)[number]["code"];

const COLOR_MAP = Object.fromEntries(MTG_COLORS.map((c) => [c.code, c.label])) as Record<
  string,
  string
>;

/**
 * Get the full name of a color code.
 *
 * @param code - Single letter color code (e.g., "U")
 * @returns Full color name (e.g., "Blue") or the original code if unknown
 */
export function getColorLabel(code: string): string {
  return COLOR_MAP[code] ?? code;
}

/**
 * Convert color letters to readable names.
 *
 * @param colors - Array of color letters (e.g., ["U", "R"]) or undefined
 * @returns Comma-separated color names (e.g., "Blue, Red") or "Colorless"
 */
export function formatColors(colors: string[] | undefined): string {
  if (!colors || colors.length === 0) {
    return "Colorless";
  }
  return colors.map(getColorLabel).join(", ");
}
