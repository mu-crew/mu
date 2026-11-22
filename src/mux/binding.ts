// mu — which managed backend a registered pane belongs to (spec A §8.2).
//
// Pane-id shape is not authority (src/mux/types.ts), but the tmux, herdr and
// Rex shapes are disjoint, so a row's id names the backend that made it.
// Placeholders and ids of no known shape name none (they match no shape).

import { muxByName } from "./detect.js";
import type { MuxBackendName } from "./types.js";

const NAMES: readonly MuxBackendName[] = ["tmux", "herdr", "rex"];

export function paneBackend(paneId: string): MuxBackendName | undefined {
  return NAMES.find((n) => muxByName(n).isValidPaneId(paneId));
}

/** The row's backend when it is a managed one other than `active`. */
export function foreignBackend(paneId: string, active: MuxBackendName): MuxBackendName | undefined {
  const b = paneBackend(paneId);
  return b !== undefined && b !== active ? b : undefined;
}
