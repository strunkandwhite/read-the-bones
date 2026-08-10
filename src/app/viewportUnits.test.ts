import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(process.cwd(), "src/app");

function collectComponentFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectComponentFiles(full, out);
    } else if (full.endsWith(".tsx") && !full.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

// iOS Safari resolves `vh` against the large viewport — the height the page
// would have with the toolbars retracted. globals.css pins the shell to
// `100dvh` and sets `overflow: hidden`, so the toolbars never retract and a
// `vh`-sized box overflows the visible area with nothing able to scroll to it.
// `h-screen` and `min-h-screen` are Tailwind aliases for `100vh` and carry the
// same defect. The lookbehind lets `dvh`, `svh` and `lvh` through.
//
// Scope: this only scans `className` string literals in `.tsx` files. A
// JS-computed height (e.g. `style={{ maxHeight: "90vh" }}`) or a `vh` value
// inside `globals.css` or an `@apply` rule is invisible to it. This is not
// hypothetical: CardTable's `scrollContainerRef` div sets its height via
// an inline `style` object today, outside this guard's reach.
const VH_HEIGHT_UTILITY = /\b(?:max-h|min-h|h)-(?:\[[^\]]*(?<![a-z])vh[^\]]*\]|screen\b)/;

describe("viewport height units", () => {
  it("uses dvh rather than vh or screen for height utilities", () => {
    const offenders: string[] = [];

    for (const file of collectComponentFiles(APP_DIR)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (VH_HEIGHT_UTILITY.test(line)) {
            offenders.push(`${path.relative(APP_DIR, file)}:${index + 1}`);
          }
        });
    }

    expect(offenders).toEqual([]);
  });
});
