/**
 * Shared land and creature predicates over a Scryfall type line.
 *
 * A double-faced card's type line joins its faces with FACE_SEPARATOR
 * (" // "), and a word-boundary match on each face keeps subtype text like
 * "Landwalker" from reading as a land.
 */

/** Scryfall's separator between a multi-face card's faces, in both type
 *  lines and mana costs. */
export const FACE_SEPARATOR = " // ";

function faces(typeLine: string): string[] {
  return typeLine.split(FACE_SEPARATOR);
}

/**
 * Whether any face of the card is a land.
 *
 * Use isFrontFaceLand instead where the question is what the card does when
 * cast rather than what it can become.
 */
export function isLand(typeLine: string): boolean {
  return faces(typeLine).some((face) => /\bland\b/i.test(face));
}

/** Whether the front face — the one a card is cast and priced as — is a
 *  land. False for a spell that transforms into a land. */
export function isFrontFaceLand(typeLine: string): boolean {
  return /\bland\b/i.test(faces(typeLine)[0] ?? "");
}

/** Whether any face of the card is a creature. */
export function isCreature(typeLine: string): boolean {
  return faces(typeLine).some((face) => /\bcreature\b/i.test(face));
}
