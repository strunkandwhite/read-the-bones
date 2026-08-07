"use client";

/**
 * Mana symbol rendering components using local SVG copies (public/mana/).
 */

/**
 * Convert mana symbol like {W}, {2}, {W/U} to SVG filename.
 */
function symbolToSvgName(symbol: string): string {
  // Remove braces: {W} -> W, {W/U} -> W/U
  const inner = symbol.slice(1, -1);
  // Remove slashes: W/U -> WU
  return inner.replace(/\//g, "");
}

function ManaSymbol({ symbol }: { symbol: string }) {
  return (
    <img
      src={`/mana/${symbolToSvgName(symbol)}.svg`}
      alt={symbol}
      width={16}
      height={16}
      className="inline-block"
      onError={(e) => {
        const span = document.createElement("span");
        span.textContent = symbol;
        span.className = "text-xs text-zinc-400";
        e.currentTarget.replaceWith(span);
      }}
    />
  );
}

/**
 * Render a mana cost string as Scryfall SVG symbols.
 *
 * Multi-face costs arrive as "A // B". Each face is kept as an unbreakable
 * group so a narrow column wraps at the separator rather than mid-cost —
 * without it the two costs read as one continuous run.
 */
export function ManaSymbols({ cost }: { cost: string }) {
  if (!cost) return <span className="text-zinc-400">-</span>;

  const faces = cost.split(" // ").map((face) => face.match(/\{[^}]+\}/g) || []);

  return (
    <span className="flex flex-wrap items-center gap-0.5">
      {faces.map((symbols, faceIndex) => (
        <span key={faceIndex} className="flex flex-nowrap items-center gap-0.5">
          {faceIndex > 0 && (
            <span className="mr-0.5 text-sm text-zinc-600 dark:text-zinc-400">
              {"//"}
            </span>
          )}
          {symbols.map((sym, i) => (
            <ManaSymbol key={i} symbol={sym} />
          ))}
        </span>
      ))}
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
        src="/mana/C.svg"
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
          src={`/mana/${color}.svg`}
          alt={color}
          width={16}
          height={16}
          className="inline-block"
          onError={(e) => {
            const span = document.createElement("span");
            span.textContent = color;
            span.className = "text-xs text-zinc-400";
            e.currentTarget.replaceWith(span);
          }}
        />
      ))}
    </span>
  );
}
