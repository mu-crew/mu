// The dashboard's data hook. Refreshes run through the runtime (single-flight,
// sync outside render) in a SEQUENTIAL loop: the next poll is scheduled only
// after the previous one settled, so refreshes never overlap. `pollMs: null`
// loads once (tests, and a static render). Cleanup cancels the pending timer
// and ignores a result that lands after unmount.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "../../dashboard-data.js";
import type { DashboardQuery, DashboardRuntime } from "./runtime.js";

export interface SnapshotState {
  loading: boolean;
  /** The last refresh's failure; a later success clears it. */
  error: string | null;
  /** The last good snapshot, kept across a failed refresh. */
  snapshot: DashboardSnapshot | null;
  warnings: readonly string[];
  /** Refresh now (shares an in-flight refresh instead of stacking one). */
  refresh(): void;
}

export function useSnapshot(
  runtime: DashboardRuntime,
  query: DashboardQuery,
  pollMs: number | null,
): SnapshotState {
  const [state, setState] = useState<Omit<SnapshotState, "refresh">>({
    loading: true,
    error: null,
    snapshot: null,
    warnings: [],
  });
  // The query is a value, not an identity: re-run only when its content changes.
  const queryKey = JSON.stringify(query);
  const wake = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const q = JSON.parse(queryKey) as DashboardQuery;
    const loop = async (): Promise<void> => {
      while (!cancelled) {
        try {
          const r = await runtime.refresh(q);
          if (cancelled) return;
          setState({ loading: false, error: null, snapshot: r.snapshot, warnings: r.warnings });
        } catch (err) {
          if (cancelled) return;
          const error = err instanceof Error ? err.message : String(err);
          setState((s) => ({ ...s, loading: false, error }));
        }
        if (pollMs === null) return;
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, pollMs);
          wake.current = resolve;
        });
        wake.current = null;
      }
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      wake.current?.();
    };
  }, [runtime, queryKey, pollMs]);

  const refresh = useCallback(() => wake.current?.(), []);
  return { ...state, refresh };
}
