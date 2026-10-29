// The dashboard's ONE poll loop (3.x `useDashboardSnapshot`, v3.13.3 state.ts), owned
// by <App> and kept running while a drill is open so every view shares its cadence:
//
//   FAST tier   every `tickMs` (default 1 s, +/- live: 100 ms .. 10 s): SQL only, agent
//               states from the slow tier's cache (runtime.ts).
//   SLOW tier   every SLOW_TICK_MS (10 s): the same read, re-probing every agent's state
//               (control socket, gate pane). `refresh()` (r / F5) runs it now.
//
// Flicker guard, as 3.x:
//   (A) a snapshot whose key (its visible content, `snapshotKey`) equals the published
//       one is dropped: no setState, the same data reference, no re-render;
//   (B) `nonce` moves ONLY when that key changes: drills depend on it to re-read;
//       `slowNonce` moves after every slow read (pane captures ride on it);
//   (C) nothing else is preloaded on the fast tick.
//
// Ticks never overlap: the next one is scheduled after the previous settled (the
// runtime is single-flight too). `pollMs: null` loads once (tests, a static render).

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "../../dashboard-data.js";
import type { DashboardQuery, DashboardRuntime } from "./runtime.js";

/** The slow tier's gap (3.x SLOW_TICK_MS). */
export const SLOW_TICK_MS = 10_000;
export const TICK_FLOOR_MS = 100;
export const TICK_CEILING_MS = 10_000;

/** A tick inside [floor, ceiling]. */
export const clampTick = (ms: number): number =>
  Math.max(TICK_FLOOR_MS, Math.min(TICK_CEILING_MS, ms));
/** `+`: halve the fast tick (floor 100 ms). */
export const fasterTick = (ms: number): number => clampTick(Math.floor(ms / 2));
/** `-`: double it (ceiling 10 s). */
export const slowerTick = (ms: number): number => clampTick(ms * 2);

/**
 * What a snapshot shows, as one string: two snapshots with the same key render the
 * same frame. A running tool's elapsed and quiet times count in whole seconds, the unit shown.
 */
export const snapshotKey = (s: DashboardSnapshot): string =>
  JSON.stringify(s, (k, v: unknown) =>
    (k === "elapsed_ms" || k === "quiet_ms") && typeof v === "number" ? Math.floor(v / 1000) : v,
  );

export interface SnapshotState {
  loading: boolean;
  /** The last refresh's failure; a later success clears it. */
  error: string | null;
  /** The last good snapshot, kept across a failed refresh. */
  snapshot: DashboardSnapshot | null;
  /** The snapshot was read for an older query than the current one (a filter just changed). */
  stale: boolean;
  /** Moves only when the published snapshot's key changes (flicker guard B). */
  nonce: number;
  /** Moves after every slow-tier read (agent state re-probed): pane captures follow it. */
  slowNonce: number;
  /** Run the slow tier now (r / F5; a tab switch). Never stacks a second read. */
  refresh(): void;
}

interface Published {
  loading: boolean;
  error: string | null;
  snapshot: DashboardSnapshot | null;
  /** The query the snapshot was read for. */
  key: string;
  nonce: number;
  slowNonce: number;
}

export function useSnapshot(
  runtime: DashboardRuntime,
  query: DashboardQuery,
  pollMs: number | null,
  slowMs: number = SLOW_TICK_MS,
): SnapshotState {
  const [state, setState] = useState<Published>({
    loading: true,
    error: null,
    snapshot: null,
    key: "",
    nonce: 0,
    slowNonce: 0,
  });
  // The query is a value, not an identity: re-run only when its content changes.
  const queryKey = JSON.stringify(query);
  const wake = useRef<(() => void) | null>(null);
  const forceSlow = useRef(false);
  const published = useRef("");
  // Survives a query change (a filter, the first workstream pick): only the clock or r runs the slow tier.
  const lastSlow = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const q = JSON.parse(queryKey) as DashboardQuery;
    const loop = async (): Promise<void> => {
      while (!cancelled) {
        const slow = forceSlow.current || Date.now() - lastSlow.current >= slowMs;
        forceSlow.current = false;
        if (slow) lastSlow.current = Date.now();
        try {
          const r = await runtime.refresh(q, { slow });
          if (cancelled) return;
          const key = `${queryKey}\u0000${snapshotKey(r.snapshot)}`;
          const changed = key !== published.current;
          published.current = key;
          if (changed || slow)
            setState((s) => {
              const next = {
                ...s,
                loading: false,
                error: null,
                key: queryKey,
                slowNonce: slow ? s.slowNonce + 1 : s.slowNonce,
              };
              if (!changed && s.error === null && !s.loading)
                return { ...next, snapshot: s.snapshot };
              return { ...next, snapshot: r.snapshot, nonce: s.nonce + 1 };
            });
          else
            setState((s) =>
              // Byte-equal and nothing to clear: the same state object, no re-render.
              s.error === null && !s.loading ? s : { ...s, loading: false, error: null },
            );
        } catch (err) {
          if (cancelled) return;
          const error = err instanceof Error ? err.message : String(err);
          setState((s) => (s.error === error && !s.loading ? s : { ...s, loading: false, error }));
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
  }, [runtime, queryKey, pollMs, slowMs]);

  const refresh = useCallback(() => {
    forceSlow.current = true;
    wake.current?.();
  }, []);
  const { key, ...rest } = state;
  return { ...rest, stale: state.snapshot !== null && key !== queryKey, refresh };
}
