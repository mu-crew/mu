// mu — the host provider seam (spec 2026-11-09-mu-plugins.md, D6): who
// acquires a host, reports its status and its facts, and releases it, and
// `resolveHost`, the one way mu turns `--host <name>` into what it holds for
// that host (a `HostView`). Outside the profile verbs (`mu host add`, `list`,
// `show`, `rm`, `check`, over src/hosts.ts), every host lookup goes through
// here: `test/host-imports.test.ts` fails a `getHost`, a `listHosts` or a
// `host_profiles` read anywhere else; `hostIdentity` here is the one read
// besides `resolveHost`'s.
//
// The built-in provider is `static`: a host profile is always ready, and
// `mu host add`/`rm` are its whole lifecycle, so `status` answers `up` with no
// round trip and `acquire`, `lookup` and `release` refuse. A provider host
// (a `hosts` record, any state) joins with the records in P6d; then
// `resolveHost` reads both tables, refuses a name found in both, and each
// verb checks the state it needs (spawn `ready`; close, stop and collect
// `ready`, `draining`, `lost`; release `draining`, `lost`, `releasing`).
// Until then every view is a profile's.

import type { Db } from "./db.js";
import { type HostLink, templateLink } from "./host-link.js";
import { getHost, HostNotFoundError, type HostProfile, HostProfileError } from "./hosts.js";
import { jobKind } from "./jobs/kinds.js";
import type { JobKind } from "./jobs/types.js";
import { pluginJobKind } from "./plugins/job.js";
import { pluginLink } from "./plugins/link.js";

/** An idempotency key: mu-generated, persisted with its effect before the call (spec D4). */
export type EffectKey = string;

/** One call across a seam: past `deadline` (epoch ms) mu cancels it through `signal`. */
export interface Call {
  deadline: number;
  signal: AbortSignal;
}

/** A lookup by key (spec D4): `none` proves nothing happened only under the D4 gate. */
export type KeyLookup<T> = { found: T } | { pending: true } | { none: true } | { unknown: string };

/** What a provider reports about a host it holds. */
export interface HostFacts {
  /** Opaque, `JOB_HANDLE_RE`-shaped (src/hosts.ts). */
  handle: string;
  deadlineAt?: number;
  idleReclaimMs?: number;
  maxJobs?: number;
}

/** `gone` is a proof: the machine and everything on it (jobs, worktrees) no longer exist. */
export type HostStatus =
  | ({ state: "up" } & HostFacts)
  | { state: "gone"; reason: string }
  | { state: "needs-human"; remedy: string }
  | { state: "unknown"; reason: string };

/** Shared by every keyed seam: declared at the handshake (spec D13). */
export interface KeyCaps {
  lookup: boolean;
  dedupe?: { exact: true; windowMs: number };
  fenceKey: boolean;
  inFlightMs?: number;
}

export interface HostProvider {
  /** "static", or the plugin's name. */
  readonly name: string;
  readonly caps: { acquire: KeyCaps };
  acquire(params: Readonly<Record<string, string>>, key: EffectKey, call: Call): Promise<HostFacts>;
  lookup(key: EffectKey, opts: { fence: boolean }, call: Call): Promise<KeyLookup<HostFacts>>;
  status(handle: string, call: Call): Promise<HostStatus>;
  /** Idempotent: a host already released resolves. */
  release(handle: string, key: EffectKey, call: Call): Promise<void>;
}

/** A provider host's state (spec D1): mu alone moves it. */
export type HostState = "acquiring" | "ready" | "draining" | "releasing" | "lost";

/** A `hosts` row (spec D5). The table joins in P6d; until then no view carries one. */
export interface HostRecord {
  id: number;
  name: string;
  provider: string;
  params_json: string;
  repo: string | null;
  handle: string | null;
  instance: string | null;
  state: HostState;
  deadline_at: number | null;
  idle_reclaim_ms: number | null;
  max_jobs: number | null;
  creator_pid: number | null;
  creator_start: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What mu holds for `--host <name>`: the link that reaches it, the provider that holds it,
 * the job kind its jobs run as, and its profile (a static host) or its record (a provider
 * host, any state). For a held call, `profile` is the ADMITTED snapshot.
 *
 * A static profile's job kind is its transport's: `lease` is the lease kind, `session` the
 * pane kind. A command gate on a session profile runs as the gate kind; that is the spawn's
 * call (`isCommandGate`), not the host's.
 */
export interface HostView {
  name: string;
  link: HostLink;
  provider: HostProvider;
  jobKind: JobKind;
  profile?: HostProfile;
  record?: HostRecord;
}

/** A call `static` refuses: static hosts are added and removed with `mu host add`/`rm`. Exit 2. */
export class StaticHostError extends HostProfileError {
  override readonly name: string = "StaticHostError";
  constructor(
    public readonly op: "acquire" | "lookup" | "release",
    message = `the static provider cannot ${op}: static hosts are added and removed with mu host add/rm`,
  ) {
    super(message);
  }
}

/** The built-in provider over host profiles. */
export const staticProvider: HostProvider = {
  name: "static",
  caps: { acquire: { lookup: false, fenceKey: false } },
  acquire: () => Promise.reject(new StaticHostError("acquire")),
  lookup: () => Promise.reject(new StaticHostError("lookup")),
  status: (handle) => Promise.resolve({ state: "up", handle }),
  release: () => Promise.reject(new StaticHostError("release")),
};

/**
 * The view of a profile already read: an admitted snapshot (inside `withHostChannel`). A
 * `--plugin` profile's link is the plugin's (src/plugins/link.ts), and so is its job kind
 * when the plugin declares a job seam (src/plugins/job.ts); a link-only plugin's jobs are
 * panes. Spawn refuses a `--plugin` host until P6e drives its spawn path.
 */
export function admittedView(db: Db, profile: HostProfile): HostView {
  const plugin = profile.plugin ?? null;
  return {
    name: profile.name,
    link: plugin === null ? templateLink(db) : pluginLink(db, plugin),
    provider: staticProvider,
    jobKind:
      (plugin === null ? undefined : pluginJobKind(db, plugin)) ??
      jobKind(profile.transport === "lease" ? "lease" : "pane"),
    profile,
  };
}

/** The view of host `name`. Throws `HostNotFoundError` when nothing holds the name. */
export function resolveHost(db: Db, name: string): HostView {
  return admittedView(db, getHost(db, name));
}

/** `resolveHost`, or undefined when nothing holds the name (any other error propagates). */
export function findHost(db: Db, name: string): HostView | undefined {
  try {
    return resolveHost(db, name);
  } catch (e) {
    if (e instanceof HostNotFoundError) return undefined;
    throw e;
  }
}

/**
 * The identity a remote recovery pins for host `name` (spec D5), as `link.fingerprint`
 * computes it: a template profile's exec bytes, read alone (one column, not the view:
 * recovery's last read before a remote command, src/remote-recovery.ts, as it was); a
 * `--plugin` profile's `plugin:<name>:<instance>`, from its view. Undefined when no host
 * holds the name.
 */
export function hostIdentity(db: Db, name: string): string | undefined {
  const row = db.prepare("SELECT exec FROM host_profiles WHERE name = ?").get(name) as
    | { exec: string | null }
    | undefined;
  if (row === undefined) return undefined;
  if (row.exec !== null) return row.exec;
  // No exec: a `--plugin` profile, whose link computes its identity.
  const view = findHost(db, name);
  return view?.link.fingerprint(view);
}

/** The view's profile, for what only a static host has (its templates, its transport). */
export function requireProfile(host: HostView): HostProfile {
  if (host.profile !== undefined) return host.profile;
  throw new HostProfileError(`host ${host.name} is a provider host: it has no host profile`);
}
