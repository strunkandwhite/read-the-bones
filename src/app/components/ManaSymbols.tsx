"use client";

/**
 * Mana symbol rendering components using Scryfall SVG images.
 */

/**
 * Convert mana symbol like {W}, {2}, {W/U} to Scryfall SVG URL filename.
 */
function symbolToSvgName(symbol: string): string {
  // Remove braces: {W} -> W, {W/U} -> W/U
  const inner = symbol.slice(1, -1);
  // Remove slashes: W/U -> WU
  return inner.replace(/\//g, "");
}

/**
 * Render a mana cost string as Scryfall SVG symbols.
 */
export function ManaSymbols({ cost }: { cost: string }) {
  if (!cost) return <span className="text-zinc-400">-</span>;

  const symbols = cost.match(/\{[^}]+\}/g) || [];

  return (
    <span className="flex flex-wrap items-center gap-0.5">
      {symbols.map((sym, i) => {
        const svgName = symbolToSvgName(sym);
        return (
          <img
            key={i}
            src={`https://svgs.scryfall.io/card-symbols/${svgName}.svg`}
            alt={sym}
            width={16}
            height={16}
            className="inline-block"
          />
        );
      })}
    </span>
  );
}

/**
 * Render color identity as Scryfall mana symbols.
 */
export function ColorPills({ colors }: { colors: string[] }) {
  if (!colors || colors.length === 0) {
    return (
      <img
        src="https://svgs.scryfall.io/card-symbols/C.svg"
        alt="C"
        width={16}
        height={16}
        className="inline-block opacity-50"
      />
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-0.5">
      {colors.map((color) => (
        <img
          key={color}
          src={`https://svgs.scryfall.io/card-symbols/${color}.svg`}
          alt={color}
          width={16}
          height={16}
          className="inline-block"
        />
      ))}
    </span>
  );
}
