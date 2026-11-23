// A tmux id is unique within ONE server lifetime. A ref with saved birth evidence
// acts only on that server. A legacy row (spawned before `agents.pane_identity`)
// has an unverified ref: tmux acts on its bare id, the check mu made before the column.

import { MuxError } from "./types.js";

export const PANE_ID_RE = /^%\d+$/;
export const SERVER_IDENTITY_RE = /^\d+\|\d+$/;

const verified = Symbol("verified pane ref");

export interface VerifiedPaneRef {
  readonly kind: "verified";
  readonly paneId: string;
  readonly identity: string;
  readonly [verified]: true;
}

export type PaneRef = VerifiedPaneRef | { readonly kind: "unverified"; readonly paneId: string };

/** Herdr and Rex use opaque native handles; only tmux needs a server fence. */
export type ActionPaneRef = PaneRef | { readonly kind: "native"; readonly paneId: string };

/** Construct from a tmux birth reply or the identity recorded with the pane, never a new lookup. */
export function paneRef(paneId: string, identity?: string | null): PaneRef {
  if (identity == null || identity === "") return { kind: "unverified", paneId };
  if (!PANE_ID_RE.test(paneId) || !SERVER_IDENTITY_RE.test(identity)) {
    throw new MuxError(`invalid tmux pane identity for ${paneId}`);
  }
  return { kind: "verified", paneId, identity, [verified]: true };
}

export function requireVerifiedPane(ref: PaneRef | ActionPaneRef): VerifiedPaneRef {
  if (ref.kind === "verified" && ref[verified] === true) return ref;
  throw new MuxError(`tmux pane ${ref.paneId} has no recorded server identity; inspect it in tmux`);
}

/**
 * The tmux ref for an action: verified (guarded on its server) or a legacy row's
 * unverified id (unguarded, as before the column). Never a native handle.
 */
export function tmuxPaneTarget(ref: ActionPaneRef): PaneRef {
  if (ref.kind === "verified") return requireVerifiedPane(ref);
  if (ref.kind === "unverified" && PANE_ID_RE.test(ref.paneId)) return ref;
  throw new MuxError(`pane ${ref.paneId} is not a tmux pane`);
}

export function nativePaneId(ref: ActionPaneRef): string {
  if (ref.kind === "native") return ref.paneId;
  throw new MuxError(`tmux pane ${ref.paneId} cannot be used on another backend`);
}

export class TmuxPaneBirthError extends MuxError {
  override readonly name = "TmuxPaneBirthError";
  constructor(paneId?: string) {
    const detail = paneId === undefined ? "the new pane" : `pane ${paneId}`;
    super(
      `could not establish which tmux server holds ${detail}; creation is uncertain, inspect the session in tmux`,
    );
  }
}
