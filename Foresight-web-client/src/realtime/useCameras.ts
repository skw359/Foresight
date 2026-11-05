// REST camera registry only; live status comes over the data channel (see useHomeRoom).
import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraDTO } from "@foresight/contract";

import { ApiRequestError, listCameras } from "../api/client";

const REFRESH_MS = 15000;

export interface CamerasState {
  cameras: CameraDTO[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCameras(homeId: string | null): CamerasState {
  const [cameras, setCameras] = useState<CameraDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!homeId) return;
      try {
        const result = await listCameras(homeId, signal);
        if (!signal?.aborted && mounted.current) {
          setCameras(result);
          setError(null);
        }
      } catch (err) {
        if (signal?.aborted || !mounted.current) return;
        setError(
          err instanceof ApiRequestError
            ? err.message
            : "Failed to load cameras.",
        );
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [homeId],
  );

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    const ctrl = new AbortController();
    load(ctrl.signal);
    const id = setInterval(() => load(), REFRESH_MS);
    return () => {
      mounted.current = false;
      ctrl.abort();
      clearInterval(id);
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { cameras, loading, error, refresh };
}
