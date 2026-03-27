import { useCallback, useEffect, useRef, useState } from "react";

type UseHoldToConfirmOptions = {
  onConfirm: () => void;
  duration?: number; // ms, default 1500
};

const FRAME_INTERVAL = 16; // ~60fps

export function useHoldToConfirm({
  onConfirm,
  duration = 1500,
}: UseHoldToConfirmOptions) {
  const [isHolding, setIsHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const confirmedRef = useRef(false);
  const onConfirmRef = useRef(onConfirm);

  // Keep the callback ref fresh
  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  const stop = useCallback(() => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    startTimeRef.current = null;
    setIsHolding(false);
    setProgress(0);
  }, []);

  const start = useCallback(() => {
    confirmedRef.current = false;
    startTimeRef.current = Date.now();
    setIsHolding(true);
    setProgress(0);

    // Confirmation fires after exact duration
    confirmTimerRef.current = setTimeout(() => {
      if (confirmedRef.current) return;
      confirmedRef.current = true;
      setProgress(1);
      // Haptic feedback (progressive enhancement)
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate(50);
      }
      onConfirmRef.current();
      // Clean up progress interval
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current);
        progressTimerRef.current = null;
      }
    }, duration);

    // Progress animation at ~60fps
    progressTimerRef.current = setInterval(() => {
      if (!startTimeRef.current) return;
      const elapsed = Date.now() - startTimeRef.current;
      const pct = Math.min(elapsed / duration, 1);
      setProgress(pct);
    }, FRAME_INTERVAL);
  }, [duration]);

  // Clean up timers on unmount (e.g., modal closes mid-hold)
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, []);

  const handlers = {
    onPointerDown: (e: React.PointerEvent | PointerEvent) => {
      // Prevent text selection during hold
      if ("preventDefault" in e) e.preventDefault();
      start();
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // Keyboard accessibility
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && !isHolding) {
        e.preventDefault();
        start();
      }
    },
    onKeyUp: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        stop();
      }
    },
  };

  return { isHolding, progress, handlers };
}
