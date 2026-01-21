/**
 * Terminal markdown formatting using marked-terminal.
 */

import { marked } from "marked";
// @ts-expect-error - marked-terminal has no type declarations
import { markedTerminal } from "marked-terminal";

// ANSI escape codes
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const RESET_BOLD = "\x1b[22m";
const RESET_ITALIC = "\x1b[23m";

// Get terminal width, default to 100 if unavailable
const terminalWidth = process.stdout.columns || 100;

marked.use(
  markedTerminal({
    // Reflow text to prevent word splitting at line edges
    reflowText: true,
    width: Math.min(terminalWidth - 4, 120), // Leave margin, cap at 120
  })
);

/**
 * Post-process to fix inline bold/italic that marked-terminal misses in list items.
 * This handles **bold** and *italic* patterns that weren't converted.
 */
function fixInlineFormatting(text: string): string {
  // Fix bold (**text**) - but not if already inside ANSI codes
  // Match **text** that wasn't converted
  let result = text.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET_BOLD}`);

  // Fix italic (*text*) - but not ** (bold) and not list bullets (* at line start)
  // Match single * that aren't part of ** and have content (not just whitespace after)
  result = result.replace(/(?<!\*)\*([^*\s][^*]*)\*(?!\*)/g, `${ITALIC}$1${RESET_ITALIC}`);

  return result;
}

/**
 * Format markdown text for terminal display.
 *
 * @param text - Markdown text to format
 * @returns Formatted text with ANSI escape codes
 */
export function formatMarkdown(text: string): string {
  const result = marked.parse(text);
  // marked.parse can return string | Promise<string>, but with sync extensions it's always string
  const formatted = (result as string).trim();

  // Fix any remaining **bold** or *italic* that marked-terminal missed
  return fixInlineFormatting(formatted);
}
