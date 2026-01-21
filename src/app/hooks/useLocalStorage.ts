"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Hook to safely read from localStorage with SSR support.
 * Returns the default value during SSR and the actual value after hydration.
 * Syncs across tabs via storage events.
 */
export function useLocalStorage<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  // Subscribe to storage events for cross-tab sync
  const subscribe = useCallback((callback: () => void) => {
    window.addEventListener("storage", callback);
    return () => window.removeEventListener("storage", callback);
  }, []);

  // Get current value from localStorage
  const getSnapshot = useCallback(() => {
    try {
      const item = localStorage.getItem(key);
      return item;
    } catch {
      return null;
    }
  }, [key]);

  // Return null during SSR
  const getServerSnapshot = useCallback(() => null, []);

  const storedValue = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Parse the stored value or return default
  const value = storedValue !== null ? (JSON.parse(storedValue) as T) : defaultValue;

  // Setter that updates both state and localStorage
  const setValue = useCallback(
    (newValue: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(newValue));
        // Dispatch storage event to trigger re-render
        window.dispatchEvent(new StorageEvent("storage", { key }));
      } catch (error) {
        console.warn(`Failed to save ${key} to localStorage:`, error);
      }
    },
    [key]
  );

  return [value, setValue];
}

// No-op subscribe function for useSyncExternalStore when value never changes
const noopSubscribe = () => () => {};

/**
 * Hook to check if we're hydrated on the client.
 * Returns false during SSR, true after hydration.
 */
export function useIsHydrated(): boolean {
  const getSnapshot = useCallback(() => true, []);
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(noopSubscribe, getSnapshot, getServerSnapshot);
}
