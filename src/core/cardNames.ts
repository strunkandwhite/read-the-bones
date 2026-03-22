/** Extract the front face name from a double-faced card name, or null if not a DFC. */
export function getFrontFace(cardName: string): string | null {
  const idx = cardName.indexOf(" // ");
  return idx !== -1 ? cardName.slice(0, idx) : null;
}
