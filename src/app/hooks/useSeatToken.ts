import { useState, useEffect, useRef } from "react";

interface UseSeatTokenReturn {
  token: string | null;
  hasSeatToken: boolean;
}

export function useSeatToken(draftId: string | null): UseSeatTokenReturn {
  const [token, setToken] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external storage */
  useEffect(() => {
    if (!draftId) return;

    const url = new URL(window.location.href);
    const urlToken = url.searchParams.get("token");
    if (urlToken) {
      localStorage.setItem(`seatToken:${draftId}`, urlToken);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
      setToken(urlToken);
    } else {
      const stored = localStorage.getItem(`seatToken:${draftId}`);
      setToken(stored);
    }
    hydratedRef.current = true;
  }, [draftId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    token,
    hasSeatToken: token !== null,
  };
}
