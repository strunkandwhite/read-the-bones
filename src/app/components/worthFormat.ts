/**
 * Display formatting for worth-model values, shared by the card table, stats
 * modal, and deck builder.
 */

/** "+4.7%" / "-2.3%" — signed percentage with one decimal, for worth-model values. */
export function formatSignedPercent(value: number): string {
  const percent = value * 100;
  // Values that round to zero display as +0.0% regardless of sign bit.
  if (Math.abs(percent) < 0.05) return "+0.0%";
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

/** "+1.6σ" / "-2.9σ" — PVI is a z-score (standard errors vs the price curve), not a rate. */
export function formatSignedZ(value: number): string {
  if (Math.abs(value) < 0.05) return "+0.0σ";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}σ`;
}
