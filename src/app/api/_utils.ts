/** Parse an optional integer query parameter. Returns undefined if null or NaN. */
export function intParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Parse a required integer query parameter. Returns the number or null if invalid. */
export function requiredIntParam(value: string | null): number | null {
  if (value === null) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}
