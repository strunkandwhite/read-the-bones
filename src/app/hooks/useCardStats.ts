import { useState, useEffect, useCallback } from "react";

type CardStatsData = {
  pick: { drafts_in_pool: number; times_picked: number; avg_pick: number; median_pick: number; geomean_pick: number };
  play?: { times_drafted: number; times_maindecked: number; play_rate: number };
  wins?: { game_wins: number; game_losses: number; win_rate: number; win_rate_ci: { lower: number; center: number; upper: number }; low_sample: boolean; drafts_with_data: number };
  pick_history: Array<{ draftId: string; draftName: string; draftDate: string; pickPosition: number; picked: boolean; numSeats: number }>;
  pick_distribution: number[];
  times_banned: number;
  color_pair_breakdown: Array<{ colorPair: string; percentage: number; deckCount: number }>;
};

export function useCardStats(cardName: string | null, draftId?: string, excludeDraftId?: string) {
  const [data, setData] = useState<CardStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async (name: string, draft?: string, exclude?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ card_name: name });
      if (draft) params.set("draft_id", draft);
      if (exclude) params.set("exclude_draft_id", exclude);
      const res = await fetch(`/api/cards/stats?${params}`);
      if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!cardName) {
      setData(null);
      return;
    }
    fetchStats(cardName, draftId, excludeDraftId);
  }, [cardName, draftId, excludeDraftId, fetchStats]);

  return { data, loading, error };
}
