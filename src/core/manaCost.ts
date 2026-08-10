import type { ScryCard } from "./types";
import { FACE_SEPARATOR } from "./cardTypes";

/**
 * A prepared card's second face is only ever cast as a copy off the
 * battlefield, never from hand, so its cost is not a way to cast the card.
 * Adventures, Omens, Rooms and split cards all keep both halves.
 */
const PREPARED_PATTERN = /\b(?:enters|becomes) prepared\b/i;

/** The mana cost to show for a card: front face only for prepared cards. */
export function displayManaCost(
  card: Pick<ScryCard, "manaCost" | "oracleText"> | undefined,
): string {
  const cost = card?.manaCost;
  if (!cost) return "";

  const separatorIndex = cost.indexOf(FACE_SEPARATOR);
  if (separatorIndex === -1) return cost;
  if (!PREPARED_PATTERN.test(card.oracleText ?? "")) return cost;

  return cost.slice(0, separatorIndex);
}
