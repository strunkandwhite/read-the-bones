/**
 * Prompt builder for LLM draft pick suggestions.
 *
 * Generates system and user prompts that provide the LLM with:
 * - Historical draft data as the primary source of card value
 * - Current draft state (picks made, cards available)
 * - Opponent analysis (picks and inferred colors)
 */

import type { DraftState } from "./types";
import type { CardStats, ScryCard } from "../core/types";
import { getDrafterForPick } from "./draftState";
import { formatColors } from "../core/colors";
import { cardNameKey } from "../core/parseCsv";
import {
  formatCardDict,
  formatPoolCounts,
  encodeCards,
  buildReverseDictionary,
} from "./cardCodes";

/**
 * Format a card's historical score for display.
 * Lower scores are better (picked earlier on average).
 *
 * @param score - Weighted geometric mean score
 * @returns Formatted score string (e.g., "2.3")
 */
function formatScore(score: number): string {
  return score.toFixed(1);
}

/**
 * Build the system prompt for the LLM.
 *
 * Establishes the role and priorities:
 * - Expert MTG drafter for rotisserie format
 * - Historical pick data as primary value signal
 * - Task: Recommend 3 picks with reasoning
 *
 * @returns System prompt string
 */
export function buildSystemPrompt(): string {
  return `Expert MTG drafter for SNAKE rotisserie. Pick order reverses each round (back-to-back picks at boundaries).

DRAFT MECHANICS (IMPORTANT CONTEXT)

This is a Rotisserie Draft: all players draft face-up from a single shared open card pool (no packs, no hidden information).

Availability: At all times, every undrafted card is visible and can be taken on a player's pick. Cards do not "show up" later; they are only removed when drafted.

Turn structure: Picks are taken sequentially in snake order:
  - Round 1: Seat 1 → Seat N
  - Round 2: Seat N → Seat 1
  - Repeat until rosters are complete.
  - After pick 25, picks double - players get 2 picks per turn.

Implication for analysis: Concepts like "what's open," "what wheeled," or "the payoff appeared" should be replaced with rotisserie concepts: replacement value, denial, timing windows, directional blocking, and contested archetype packages based on what opponents are drafting.

Pick lists: Each player's "PICKS BY PLAYER" list is in the chronological order they drafted those cards (their personal pick sequence), not grouped by round.

COMPRESSION RULES

This prompt uses compressed codes to save tokens.

CARD_DICT maps card codes to full card names (including punctuation such as Commit // Memory).
Codes are case-sensitive and must be matched exactly. Do not guess mappings.

Multiplicity / duplicates:
  If POOL_COUNTS is provided, a card is available that many times (e.g., FS: 2 means two copies of Flooded Strand exist in the pool).
  When a player drafts a code, it consumes one available copy from POOL_COUNTS.
  If POOL_COUNTS is omitted, assume each code exists once in the pool.

Pick lists:
  PICKS BY PLAYER lists are sequences of card codes in the chronological order drafted by that player.
  A code may appear multiple times in a player's picks only if the pool count allows it.

Decoding rule for analysis/output:
  For all reasoning, treat codes as aliases for their dictionary values.
  Always output full names (cards and players) in your analysis/summaries, not codes, unless the user explicitly requests codes.

Validation behavior:
  If any code is missing from its dictionary, pause and ask for clarification rather than inferring.

DO NOT explain card quality. User is an expert. Focus on TIMING and COMPETITION.

CRITICAL: Output plain text only. NEVER use markdown formatting in ANY response - not now, not in follow-up questions, not ever. No **, no #, no bullets (*/-), no code blocks. Just plain text with line breaks.

SCORES: Lower = better. Score vs Top Player divergence = over/undervalued. "Low data" = scrutinize.

FORMAT:

PREDICTED PICKS (for each drafter before your turn):
  86 Name -> Card (brief reason)
  87 Name -> Card (brief reason)
  ...continue until your pick

THREATS: cards in YOUR colors that may be taken - one line

RECOMMENDATIONS:
  1. Card | Score | Fit | Threat: safe/contested/urgent
     Timing rationale - who wants it, will it wheel
  2. ...
  3. ...

DECK DIRECTIONS (2-3 paths your deck could take from here):
  - Direction name: one sentence on what to prioritize
`;
}

/**
 * Build the user prompt with current draft state.
 *
 * Includes all context the LLM needs:
 * - Card dictionary for code compression
 * - Pick timing (current pick, turns until user)
 * - User's deck and inferred colors
 * - Opponent decks and colors
 * - Available cards ranked by historical score
 *
 * @param draftState - Current state of the in-progress draft
 * @param historicalStats - Card statistics from all historical drafts
 * @param drafterColors - Map of drafter name to inferred colors
 * @param scryfallCache - Optional map of card data for type/mana info
 * @param cardDict - Map of code -> fullName for card compression
 * @param poolCounts - Map of normalized name -> count for duplicates
 * @returns User prompt string
 */
export function buildUserPrompt(
  draftState: DraftState,
  historicalStats: CardStats[],
  drafterColors: Map<string, string[]>,
  scryfallCache?: Map<string, ScryCard>,
  cardDict?: Map<string, string>,
  poolCounts?: Map<string, number>
): string {
  const sections: string[] = [];

  // Build reverse dictionary for encoding
  const cardReverseDict = cardDict ? buildReverseDictionary(cardDict) : new Map<string, string>();

  // Section 0: Dictionaries (if provided)
  if (cardDict && cardDict.size > 0) {
    sections.push(formatCardDict(cardDict));
  }

  // Pool counts (only if there are duplicates)
  if (poolCounts && poolCounts.size > 0) {
    const poolCountsSection = formatPoolCounts(poolCounts, cardReverseDict);
    if (poolCountsSection) {
      sections.push(poolCountsSection);
    }
  }

  // Section 1: Current draft status
  sections.push(buildDraftStatusSection(draftState));

  // Section 2: User's deck
  sections.push(buildUserDeckSection(draftState, drafterColors, cardReverseDict));

  // Section 3: Opponents
  sections.push(buildOpponentsSection(draftState, drafterColors, cardReverseDict));

  // Section 4: Threats (opponents picking before user)
  const threatsSection = buildThreatsSection(draftState, historicalStats, drafterColors, cardReverseDict);
  if (threatsSection) {
    sections.push(threatsSection);
  }

  // Section 5: Available cards with scores
  sections.push(buildAvailableCardsSection(draftState, historicalStats, scryfallCache, cardReverseDict));

  // Final instruction
  sections.push("Recommend your top 3 picks with reasoning.");

  return sections.join("\n\n");
}

/**
 * Build the draft status section showing pick number and timing.
 * Includes upcoming pick sequence to clarify snake draft order.
 */
function buildDraftStatusSection(draftState: DraftState): string {
  const { currentPickNumber, isUsersTurn, picksUntilUser, drafters, userIndex } = draftState;

  const numDrafters = drafters.length;

  let status = `Current Pick: #${currentPickNumber}`;

  if (isUsersTurn) {
    status += " (your turn!)";
  } else if (picksUntilUser === 1) {
    status += " (1 pick until your turn)";
  } else {
    status += ` (${picksUntilUser} picks until your turn)`;
  }

  // Show upcoming pick sequence (next 2 rounds worth of picks)
  const upcomingPicks: string[] = [];
  const picksToShow = numDrafters * 2;

  for (let offset = 0; offset < picksToShow; offset++) {
    const pickNum = currentPickNumber + offset;
    const drafterIdx = getDrafterForPick(pickNum, numDrafters, draftState.doublePickStartsAfterRound);
    const drafterName = drafters[drafterIdx];
    const isUser = drafterIdx === userIndex;

    if (isUser) {
      upcomingPicks.push(`#${pickNum} **YOU**`);
    } else {
      upcomingPicks.push(`#${pickNum} ${drafterName}`);
    }
  }

  status += `\nPick order: ${upcomingPicks.join(" → ")}`;

  return status;
}

/**
 * Build the section showing the user's current deck.
 */
function buildUserDeckSection(
  draftState: DraftState,
  drafterColors: Map<string, string[]>,
  reverseDict: Map<string, string>
): string {
  const { userPicks, drafters, userIndex } = draftState;
  const userName = drafters[userIndex];
  const userColors = drafterColors.get(userName) || [];

  let section = `YOUR DECK (${userPicks.length} cards)`;

  if (userColors.length > 0) {
    section += `\nColors: ${formatColors(userColors)}`;
  } else if (userPicks.length === 0) {
    section += "\nColors: Not yet established";
  } else {
    section += "\nColors: Unknown";
  }

  if (userPicks.length > 0) {
    const encodedPicks = encodeCards(userPicks, reverseDict);
    section += `\nCards: ${encodedPicks.join(", ")}`;
  } else {
    section += "\nCards: None yet";
  }

  return section;
}

/**
 * Build the section showing opponent decks and colors.
 */
function buildOpponentsSection(
  draftState: DraftState,
  drafterColors: Map<string, string[]>,
  cardReverseDict: Map<string, string>
): string {
  const { drafters, userIndex, allPicks } = draftState;

  const opponentLines: string[] = ["OPPONENTS"];

  for (let i = 0; i < drafters.length; i++) {
    if (i === userIndex) continue; // Skip user

    const name = drafters[i];
    const picks = allPicks.get(name) || [];
    const colors = drafterColors.get(name) || [];

    let line = `${name} (${picks.length} cards)`;

    if (colors.length > 0) {
      line += `: ${formatColors(colors)}`;
    }

    // Show first few cards for context (encoded)
    if (picks.length > 0) {
      const displayPicks = encodeCards(picks.slice(0, 5), cardReverseDict);
      line += ` - ${displayPicks.join(", ")}`;
      if (picks.length > 5) {
        line += `, ... (+${picks.length - 5} more)`;
      }
    }

    opponentLines.push(line);
  }

  return opponentLines.join("\n");
}

/**
 * Build the threats section showing opponents picking before the user
 * and the cards they're most likely to take based on their colors.
 *
 * @param draftState - Current draft state
 * @param historicalStats - Card statistics for scoring
 * @param drafterColors - Map of drafter name to inferred colors
 * @param cardReverseDict - Map of cardName -> code for encoding
 * @returns Threats section string, or null if no threats (user picks next)
 */
function buildThreatsSection(
  draftState: DraftState,
  historicalStats: CardStats[],
  drafterColors: Map<string, string[]>,
  cardReverseDict: Map<string, string>
): string | null {
  const { drafters, userIndex, picksUntilUser, currentDrafterIndex, availableCards } = draftState;

  // No threats if it's the user's turn
  if (picksUntilUser === 0) {
    return null;
  }

  // Create a map for quick lookup of historical stats
  const statsMap = new Map<string, CardStats>();
  for (const stat of historicalStats) {
    statsMap.set(stat.cardName, stat);
  }

  // Build list of opponents picking before the user (in pick order)
  const threats: { name: string; colors: string[]; picksAway: number }[] = [];

  // Snake draft: determine pick order for the current round
  const numDrafters = drafters.length;
  let pickIndex = currentDrafterIndex;

  for (let i = 0; i < picksUntilUser; i++) {
    if (pickIndex !== userIndex) {
      const name = drafters[pickIndex];
      const colors = drafterColors.get(name) || [];
      threats.push({
        name,
        colors,
        picksAway: i + 1,
      });
    }

    // Move to next drafter (accounting for snake draft direction)
    // This simplified version assumes we're moving toward the user
    pickIndex = (pickIndex + 1) % numDrafters;
  }

  if (threats.length === 0) {
    return null;
  }

  // For each threatening opponent, find top cards in their colors
  const lines: string[] = ["THREATS (opponents picking before you)"];

  for (const threat of threats) {
    const { name, colors, picksAway } = threat;

    // Find available cards that match this opponent's colors
    const matchingCards = availableCards
      .map((cardName) => {
        const stats = statsMap.get(cardName);
        const cardColors = stats?.colors || [];

        // Card matches if:
        // - Colorless (fits any deck)
        // - Shares at least one color with opponent
        const isColorless = cardColors.length === 0;
        const sharesColor = cardColors.some((c) => colors.includes(c));

        return {
          cardName,
          score: stats?.weightedGeomean ?? Infinity,
          matches: isColorless || sharesColor,
        };
      })
      .filter((c) => c.matches && c.score !== Infinity)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);

    // Format the threat line
    let line = `${name}`;
    if (colors.length > 0) {
      line += ` (${formatColors(colors)}`;
    } else {
      line += ` (colors unknown`;
    }
    line += `, ${picksAway} pick${picksAway > 1 ? "s" : ""} away)`;

    if (matchingCards.length > 0) {
      const cardList = matchingCards
        .map((c) => {
          const code = cardReverseDict.get(c.cardName) || c.cardName;
          return `${code} (${formatScore(c.score)})`;
        })
        .join(", ");
      line += `: ${cardList}`;
    } else {
      line += `: No high-value cards in their colors`;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * Build the section showing all available cards ranked by historical score.
 *
 * Shows all cards sorted by score with type and mana cost if available.
 * Includes both overall score and top-player score for comparison.
 * Uses card codes for compression when reverseDict is provided.
 */
function buildAvailableCardsSection(
  draftState: DraftState,
  historicalStats: CardStats[],
  scryfallCache?: Map<string, ScryCard>,
  reverseDict?: Map<string, string>
): string {
  const { availableCards } = draftState;

  // Create a map for quick lookup of historical stats
  const statsMap = new Map<string, CardStats>();
  for (const stat of historicalStats) {
    statsMap.set(stat.cardName, stat);
  }

  // Score and sort available cards
  const scoredCards = availableCards
    .map((cardName) => {
      const stats = statsMap.get(cardName);
      return {
        cardName,
        score: stats?.weightedGeomean ?? Infinity,
        stats,
      };
    })
    .sort((a, b) => a.score - b.score);

  const lines: string[] = [
    `AVAILABLE CARDS (${availableCards.length} cards, sorted by historical score)`,
  ];

  for (let i = 0; i < scoredCards.length; i++) {
    const { cardName, score, stats } = scoredCards[i];
    const scryCard = scryfallCache?.get(cardNameKey(cardName));
    const code = reverseDict?.get(cardName) || cardName;

    let line = `${i + 1}. ${code}`;

    // Add score
    if (score !== Infinity) {
      line += ` - Score: ${formatScore(score)}`;
    } else {
      line += " - Score: N/A (new card)";
    }

    // Add data quality indicator
    if (stats) {
      if (stats.timesAvailable === 1) {
        line += ` [1 draft]`;
      } else {
        line += ` (${stats.timesAvailable} drafts)`;
      }
    }

    // Add Scryfall info if available
    if (scryCard) {
      line += `\n   ${scryCard.typeLine}`;
      if (scryCard.manaCost) {
        line += `, ${scryCard.manaCost}`;
      }
    }

    lines.push(line);
  }

  return lines.join("\n");
}
