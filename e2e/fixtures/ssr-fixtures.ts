import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import cardsFixture from "./cards.json";
import draftStatsFixture from "./draft-stats.json";

export const cards: CardStatsResponse = cardsFixture as CardStatsResponse;
export const draftStats: DraftStatsResponse =
  draftStatsFixture as DraftStatsResponse;
