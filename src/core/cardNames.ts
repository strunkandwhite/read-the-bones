import { FACE_SEPARATOR } from "./cardTypes";

/** Extract the front face name from a double-faced card name, or null if not a DFC. */
export function getFrontFace(cardName: string): string | null {
  const idx = cardName.indexOf(FACE_SEPARATOR);
  return idx !== -1 ? cardName.slice(0, idx) : null;
}

/**
 * Strips numeric suffix from card names (e.g., "Scalding Tarn 2" -> "Scalding Tarn")
 */
export function normalizeCardName(cardName: string): string {
  return cardName.trim().replace(/\s+\d+$/, "");
}

/**
 * Returns a lowercase key for case-insensitive card name matching.
 * DFC names are normalized to front face (e.g., "Brazen Borrower // Petty Theft" → "brazen borrower").
 */
export function cardNameKey(cardName: string): string {
  const normalized = normalizeCardName(cardName);
  const frontFace = getFrontFace(normalized);
  return (frontFace ?? normalized).toLowerCase();
}
