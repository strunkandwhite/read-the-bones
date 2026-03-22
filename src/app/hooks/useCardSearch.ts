import { useState, useCallback, useMemo, useEffect } from "react";
import { track } from "@vercel/analytics/react";
import type { ColorFilterMode } from "@/core/colorFilter";
import type { ScryCard, EnrichedCardStats } from "@/core/types";
import { searchLocalCards } from "@/core/localSearch";
import { hasScryfallOperators } from "@/core/searchUtils";
import { getFrontFace } from "@/core/cardNames";

function classifyQueryType(query: string): string {
  const prefixes = ["t:", "o:", "c:", "cmc"];
  const found = prefixes.filter((p) => query.includes(p));
  if (found.length > 1) return "multi";
  if (found[0] === "t:") return "type";
  if (found[0] === "o:") return "oracle";
  if (found[0] === "c:") return "color";
  if (found[0] === "cmc") return "cmc";
  return "unknown";
}

interface UseCardSearchProps {
  cards: EnrichedCardStats[];
}

interface UseCardSearchReturn {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  colorFilter: string[];
  setColorFilter: (colors: string[]) => void;
  colorFilterMode: ColorFilterMode;
  setColorFilterMode: (mode: ColorFilterMode) => void;
  scryfallMatchNames: Set<string> | null;
  clearSearch: () => void;
}

export function useCardSearch({ cards }: UseCardSearchProps): UseCardSearchReturn {
  const [searchQuery, setSearchQuery] = useState("");
  const [colorFilter, setColorFilter] = useState<string[]>([]);
  const [colorFilterMode, setColorFilterMode] = useState<ColorFilterMode>("inclusive");
  const [scryfallSearchResults, setScryfallSearchResults] = useState<ScryCard[] | null>(null);

  // Extract ScryCard array for local search
  const scryfallCards = useMemo(
    () => cards.map((c) => c.scryfall).filter(Boolean) as ScryCard[],
    [cards]
  );

  // Debounced search effect - runs local search after 500ms of inactivity
  /* eslint-disable react-hooks/set-state-in-effect -- clearing derived state when input changes */
  useEffect(() => {
    const query = searchQuery.trim();

    if (!query) {
      setScryfallSearchResults(null);
      return;
    }

    if (!hasScryfallOperators(query)) {
      setScryfallSearchResults(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      const results = searchLocalCards(query, scryfallCards);
      setScryfallSearchResults(results);
      track("search", {
        query_type: classifyQueryType(query),
        result_count: results.length,
      });
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [searchQuery, scryfallCards]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setScryfallSearchResults(null);
  }, []);

  // Build a Set of matching card names from Scryfall results for efficient lookup
  // Handles double-faced cards by also adding the front face name
  const scryfallMatchNames = useMemo(() => {
    if (!scryfallSearchResults) return null;
    const names = new Set<string>();
    for (const card of scryfallSearchResults) {
      names.add(card.name);
      const frontFace = getFrontFace(card.name);
      if (frontFace) names.add(frontFace);
    }
    return names;
  }, [scryfallSearchResults]);

  return {
    searchQuery,
    setSearchQuery,
    colorFilter,
    setColorFilter,
    colorFilterMode,
    setColorFilterMode,
    scryfallMatchNames,
    clearSearch,
  };
}
