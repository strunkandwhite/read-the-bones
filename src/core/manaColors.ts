/**
 * WUBRG-tinted RGBA backgrounds keyed by single-letter color code.
 * Low alpha so light text stays readable on top.
 */
const WUBRG_BG: Record<string, string> = {
  W: "rgba(248,231,185,0.15)",
  U: "rgba(14,104,171,0.20)",
  B: "rgba(130,100,160,0.20)",
  R: "rgba(211,32,42,0.18)",
  G: "rgba(0,115,62,0.18)",
  C: "rgba(200,200,200,0.10)",
};

/** Background tint for a color pair string (e.g. "UR") — uses the first color. */
export function colorPairBg(pair: string): string {
  const first = pair[0];
  return WUBRG_BG[first] ?? WUBRG_BG.C;
}

/**
 * A `linear-gradient` tint for a card's color identity, suitable for layering as
 * a `background-image` over an existing background color. Returns `null` for
 * colorless/empty identities so colored cards stand out against an untinted board.
 *
 * - mono → a flat two-stop gradient of that color's tint
 * - multicolor → a left-to-right gradient blending each color's tint
 */
export function colorIdentityGradient(colors: string[]): string | null {
  if (!colors || colors.length === 0) return null;
  const stops =
    colors.length === 1
      ? [WUBRG_BG[colors[0]] ?? WUBRG_BG.C, WUBRG_BG[colors[0]] ?? WUBRG_BG.C]
      : colors.map((c) => WUBRG_BG[c] ?? WUBRG_BG.C);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
