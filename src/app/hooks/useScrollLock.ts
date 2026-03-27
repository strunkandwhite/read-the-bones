"use client";

import { useEffect, useRef } from "react";

/**
 * Lock body scroll when `locked` is true.
 * Multiple callers are safe: only restores overflow when this specific
 * hook instance unlocks. Uses a ref to store the previous overflow value
 * so StrictMode double-firing and SSR don't cause issues.
 */
export function useScrollLock(locked: boolean): void {
  const previousOverflow = useRef<string | null>(null);

  useEffect(() => {
    if (!locked) return;

    previousOverflow.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow.current ?? "";
      previousOverflow.current = null;
    };
  }, [locked]);
}
