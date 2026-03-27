import { useState, useEffect } from "react";

type CardStatsData = {
  pick: { drafts_in_pool: number; times_picked: number; avg_pick: number; median_pick: number; geomean_pick: number };
  play?: { times_drafted: number; times_maindecked: number; play_rate: number };
  wins?: { game_wins: number; game_losses: number; win_rate: number; win_rate_ci: { lower: number; center: number; upper: number }; low_sample: boolean; drafts_with_data: number };
  pick_history: Array<{ draftId: string; draftName: string; draftDate: string; pickPosition: number; picked: boolean }>;
  pick_distribution: number[];
  color_pair_breakdown: Array<{ colorPair: string; percentage: number; deckCount: number }>;
};

export function useCardStats(cardName: string | null, draftId?: string) {
  const [data, setData] = useState<CardStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cardName) {
      setData(null);
      return;
    }

    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ card_name: cardName });
    if (draftId) params.set("draft_id", draftId);

    fetch(`/api/cards/stats?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [cardName, draftId]);

  return { data, loading, error };
}
