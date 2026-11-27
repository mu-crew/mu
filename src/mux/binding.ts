// mu — which backend a registered pane belongs to (spec A §8.2).
//
// Pane-id shape is not authority (src/mux/types.ts), but the tmux, Rex and
// retired herdr shapes are disjoint, so a row's id names the backend that made it.
// Placeholders and ids of no known shape name none (they match no shape).

import { muxByName } from "./detect.js";
import { ForeignPaneError, type MuxBackendName, RetiredPaneError } from "./types.js";

/** A backend mu no longer drives (herdr, retired in mu 6). Its rows stay foreign:
 *  no backend can list their panes, so reconcile must never read them as ghosts. */
export type RetiredBackendName = "herdr";

/** The backend a row's pane id names: a live one or a retired one. */
export type PaneBackendName = MuxBackendName | RetiredBackendName;

const NAMES: readonly MuxBackendName[] = ["tmux", "rex"];

/** herdr pane ids, `w1:p1` (ordinals are Crockford base32, `pA` follows `p9`). */
const HERDR_PANE_ID_RE = /^w[0-9A-Z]+:p[0-9A-Z]+$/;

/** Whether `paneId` is a retired backend's pane: one no live backend may read as alive or dead. */
export function isRetiredPane(paneId: string): boolean {
  return HERDR_PANE_ID_RE.test(paneId);
}

/** Refuse (`RetiredPaneError`) a pane-addressed action on a retired backend's pane. */
export function assertDrivablePane(paneId: string, agent?: string, workstream?: string): void {
  if (isRetiredPane(paneId)) throw new RetiredPaneError(paneId, agent, workstream);
}

export function paneBackend(paneId: string): PaneBackendName | undefined {
  if (HERDR_PANE_ID_RE.test(paneId)) return "herdr";
  return NAMES.find((n) => muxByName(n).isValidPaneId(paneId));
}

/** The row's backend when it is one other than `active` (a retired one always is). */
export function foreignBackend(
  paneId: string,
  active: MuxBackendName,
): PaneBackendName | undefined {
  const b = paneBackend(paneId);
  return b !== undefined && b !== active ? b : undefined;
}

/**
 * Refuse a pane `active` cannot drive: a retired backend's (`RetiredPaneError`) or another
 * live backend's (`ForeignPaneError`). Its probe would read the pane as gone without asking.
 */
export function assertOwnPane(paneId: string, active: MuxBackendName): void {
  assertDrivablePane(paneId);
  const b = foreignBackend(paneId, active);
  if (b !== undefined && b !== "herdr") throw new ForeignPaneError(paneId, b, active);
}
