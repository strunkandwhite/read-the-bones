import { useEffect, useLayoutEffect, useRef } from "react";
import { track } from "@vercel/analytics/react";

const SLOW_RENDER_THRESHOLD_MS = 500;
const THROTTLE_INTERVAL_MS = 30_000;

/**
 * Tracks slow renders by measuring the time between useLayoutEffect
 * (synchronous post-render) and useEffect (after paint). When the gap
 * exceeds 500ms, fires a `slow_render` analytics event. Throttled to
 * at most one event per 30 seconds per component.
 */
export function useSlowRenderTracking(componentName: string) {
  const lastReportedRef = useRef(0);
  const layoutTimeRef = useRef(0);

  useLayoutEffect(() => {
    layoutTimeRef.current = performance.now();
  });

  useEffect(() => {
    const commitDuration = performance.now() - layoutTimeRef.current;
    const now = Date.now();

    if (
      commitDuration > SLOW_RENDER_THRESHOLD_MS &&
      now - lastReportedRef.current > THROTTLE_INTERVAL_MS
    ) {
      lastReportedRef.current = now;
      track("slow_render", {
        component: componentName,
        duration_ms: Math.round(commitDuration),
      });
    }
  });
}
