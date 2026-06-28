import { useState, useEffect } from "react";
import type { ReplayData } from "../types";
import { api } from "../api";

export function useMatchEvents(sessionId: number | null) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId === null) return;
    setLoading(true);
    setError(null);
    api
      .getSessionEvents(sessionId)
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  return { data, loading, error };
}
