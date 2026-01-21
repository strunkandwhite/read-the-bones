"use client";

import { createContext, useContext, ReactNode } from "react";
import type { EnrichedCardStats } from "@/core/types";

/**
 * Card data context for sharing card information across the app.
 * Used by useCardImage hook to resolve card names to image URLs.
 */
interface CardDataContextValue {
  cards: EnrichedCardStats[];
}

const CardDataContext = createContext<CardDataContextValue | null>(null);

/**
 * Provider component for card data context.
 */
export function CardDataProvider({
  children,
  cards,
}: {
  children: ReactNode;
  cards: EnrichedCardStats[];
}) {
  return (
    <CardDataContext.Provider value={{ cards }}>
      {children}
    </CardDataContext.Provider>
  );
}

/**
 * Hook to access card data from context.
 * Throws if used outside of CardDataProvider.
 */
export function useCardData(): CardDataContextValue {
  const context = useContext(CardDataContext);
  if (!context) {
    throw new Error("useCardData must be used within a CardDataProvider");
  }
  return context;
}
