// mu — host profiles: ssh-free command templates, and the channels they use.
//
// mu never connects to a host and knows no ssh flags. A profile is three
// templates the user wrote (`shell`, `exec`, `fetch`), a `repo` path and an
// optional `max_sessions`. mu fills the documented placeholders and runs the
// result with `/bin/sh -c`; `host init --ssh` only PRINTS a starter to edit.
//
// A profile has a TRANSPORT. `session` (the default): the pane runs the `shell`
// template, a held ssh. `lease`: the pane runs a local CARRIER that owns a
// detached remote job and writes its handle to `{job_file}`; a `stop` template
// ends a job given its handle (`{job}`), and an optional `attach` template opens
// a new carrier for a job that still runs. A lease pane holds no channel.
//
// ─── Template grammar (one pass over the ORIGINAL template) ─────────────
//   {{ and }}   literal braces. A lone `{` or `}`, or an unknown name, is an
//               error: nothing is guessed. (A shell `${HOME}` is `${{HOME}}`.)
//   {name}      one of env, cmd, local_sock, remote_sock, cwd, job_file, job.
//               The value is substituted once and never rescanned, so braces
//               inside a value are inert. A placeholder valid only in some
//               fields is refused elsewhere (`TEMPLATE_SCOPES`): `job_file`
//               only in a lease `shell` and `attach`, `job` only in `stop`
//               and `attach`, `stop` takes nothing but `job` and `cwd`
//               (always `.`), and `attach` no `env` or `cmd`. The lexer
//               decides, so `{{job}}` and a `:sh` modifier are read right.
// A small lexer tracks '...' and "..." so every value stays exactly the text
// the template author asked for. Quote characters never imply a second shell;
// a second layer is always asked for by name:
//   {name}      ONE layer, the local /bin/sh. Unquoted: the value as one
//               single-quoted word. Inside '...' or "...": the value escaped
//               to be literal text of that string (`'` -> `'\''`;
//               `\ " $ \`` backslash-escaped), so `tool "{cwd}"` and
//               `tool '{cwd}'` pass the value itself.
//   {name:sh}   TWO layers: the value is first quoted as one word for a second
//               shell (what the template hands command text to, e.g. ssh's
//               remote login shell), then for the layer it lands in. Atomic
//               at both layers.
// A placeholder after a backslash, or inside $(...) / backticks within double
// quotes, is refused (the lexer does not nest shells).
// {env} is a run of KEY=VALUE assignment words, so it can precede a command.
// Keys are the seven of `HOST_ENV_KEYS` only: the five remote identity
// variables plus a hook harness worker's two (never the local DB, state or
// sync dir); each VALUE is shell-quoted (`hostEnvWords`). The words
// are shell text, so in '...' or "..." they are escaped for that quote like
// any text, and `{env:sh}` is refused (it is already text for the inner shell).
//
// ─── Channels ───────────────────────────────────────────────────────────
// `max_sessions` counts every channel mu holds open to a host. A channel is
// one `host_channels` row (machine-local), reserved BEFORE the connection is
// opened, under BEGIN IMMEDIATE that covers reserve/count/cleanup only, never
// the awaited template run:
//   transient   rides one invocation (exec, fetch, check); released in
//               `finally` by token; reclaimed only when its pid is proven
//               gone (ESRCH, or the pid's start time changed) AND the
//               template's process group (`pgid`, recorded before the command
//               starts) is gone: kill(-pgid, 0) succeeding or EPERM holds the
//               slot, so a caller that died by SIGKILL mid-reap cannot free it
//               under a live transport. EPERM or any unknown keeps the row.
//   attached    rides an agent's pane (registry id + pane, no pid): reserve,
//               `bindHostChannel` once the pane exists, and
//               `releaseHostChannelsForAgent(id, pane)` at close. Reclaimed
//               only when the pane is proven dead; a liveness probe that
//               throws, or no probe, keeps the row.
// `spawn --host` reserves BEFORE its pane opens, binds the lease to the new
// agent's id + pane, and `deleteAgent` (close, reconcile, rollback, teardown)
// frees it: the pane IS the transport, so pane death is transport death.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ctlProbe } from "./ctl/client.js";
import { ctlSocketPath } from "./ctl/path.js";
import type { Db } from "./db.js";
import { execGroupCapture } from "./exec-file.js";
import {
  type HostCapabilities,
  harnessesDetail,
  harnessProbeScript,
  hooksStep,
  noHarnessDetail,
  parseHarnessProbe,
  recordHostCapabilities,
} from "./host-harnesses.js";
import type { CheckContext, CheckPhase } from "./host-link.js";
import { say } from "./messages.js";
import { PluginNotFoundError, PluginRefusedError } from "./plugins/errors.js";
import { shellQuote } from "./shell-quote.js";

// ─── Errors ─────────────────────────────────────────────────────────────

/** A profile field mu refuses (name, cap, repo, template). Exit 2. */
export class HostProfileError extends Error {
  override readonly name: string = "HostProfileError";
}

/** A template mu refuses to expand. Exit 2. */
export class HostTemplateError extends HostProfileError {
  override readonly name: string = "HostTemplateError";
}

export class HostNotFoundError extends Error {
  override readonly name = "HostNotFoundError";
  constructor(public readonly host: string) {
    super(say("host.not_found", host));
  }
}

export class HostExistsError extends Error {
  override readonly name = "HostExistsError";
  constructor(public readonly host: string) {
    super(say("host.exists", host));
  }
}

/** The host is at `max_sessions`, or the holder already holds a channel. One line, names the holder. */
export class HostChannelBusyError extends Error {
  override readonly name = "HostChannelBusyError";
  constructor(
    public readonly host: string,
    public readonly holders: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

/** `host rm` of a host that still holds a channel. */
export class HostInUseError extends Error {
  override readonly name = "HostInUseError";
  constructor(
    public readonly host: string,
    public readonly holders: readonly string[],
  ) {
    super(say("host.in_use", host, holders));
  }
}

/** The active multiplexer cannot run a host profile's shell template. One line, exit 2. */
export class HostSpawnUnsupportedError extends Error {
  override readonly name = "HostSpawnUnsupportedError";
  constructor(
    public readonly host: string,
    public readonly mux: string,
  ) {
    super(say("host.spawn_unsupported", host, mux));
  }
}

/**
 * A host template exited 3: the hand-back (a human must act, e.g. a hardware key). Exit 5,
 * label `human needed`. Never retried, and never recorded as `human-needed` here: that record
 * is always a decision (VISION). Thrown for `exec` and `fetch` runs only, never for a pane.
 */
export class HostHandbackError extends Error {
  override readonly name = "HostHandbackError";
  readonly handback = true;
  constructor(
    public readonly host: string,
    public readonly field: "exec" | "fetch" | "stop",
    /** The first non-blank line of stderr, else of stdout. */
    public readonly detail: string,
  ) {
    super(say("host.handback", host, field, detail));
  }
}

/** `host check` found a failing step. The report rides on `failureWithData`. */
export class HostCheckFailedError extends Error {
  override readonly name = "HostCheckFailedError";
  constructor(
    public readonly host: string,
    public readonly failed: readonly string[],
  ) {
    super(say("host.check_failed", host, failed));
  }
}

// ─── Profiles ───────────────────────────────────────────────────────────

export interface HostProfile {
  name: string;
  /** The pane's template; null only on a `--plugin` profile. */
  shell: string | null;
  /** The exec template; null only on a `--plugin` profile, whose link is the plugin. */
  exec: string | null;
  /** The fetch template; "" only on a `--plugin` profile whose plugin's link fetches. */
  fetch: string;
  /** Default remote repo for a spawn without `--root`; null: none. */
  repo: string | null;
  max_sessions: number | null;
  /** `session`: the pane holds an ssh. `lease`: the pane is a carrier owning a detached remote job. */
  transport: HostTransport;
  /** Lease only: the template that ends a job given its handle (`{job}`); null for a session profile. */
  stop: string | null;
  /** Lease only, optional: a new carrier for a running job (`{job}`, `{job_file}`, both socks); null: none. */
  attach: string | null;
  /**
   * The last `host check` harness probe (JSON, src/host-harnesses.ts: what the host can run, and
   * when it was probed); null: never probed. Read it with `hostCapabilities`.
   */
  capabilities?: string | null;
  /**
   * The registered plugin that is this host's link (`mu host add --plugin`); null: the
   * templates. A `--plugin` profile has no `shell` or `exec`, keeps its `fetch` template
   * (run where the plugin's link does not fetch; optional where it does) and is a session
   * profile.
   */
  plugin?: string | null;
}

export const HOST_TRANSPORTS = ["session", "lease"] as const;
export type HostTransport = (typeof HOST_TRANSPORTS)[number];

/**
 * What `addHost` takes: a session profile needs neither `transport`, `stop` nor `attach`; a
 * probe is never given. `shell` and `exec` are given exactly when `plugin` is not; `fetch`
 * may be left out only when `plugin`'s link fetches.
 */
export type NewHostProfile = Omit<
  HostProfile,
  "shell" | "exec" | "fetch" | "transport" | "stop" | "attach" | "capabilities" | "plugin"
> &
  Partial<
    Pick<HostProfile, "shell" | "exec" | "fetch" | "transport" | "stop" | "attach" | "plugin">
  >;

/** A job handle is opaque to mu: one line of these bytes, never parsed further. */
export const JOB_HANDLE_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

const HOST_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidHostName(name: string): boolean {
  return HOST_NAME_RE.test(name);
}

/** A row as mu holds it: `plugin` only on a `--plugin` profile, so a template profile is as it was. */
function profileOf(row: HostProfile): HostProfile {
  if (row.plugin != null) return row;
  const { plugin: _none, ...rest } = row;
  return rest;
}

export function getHost(db: Db, name: string): HostProfile {
  const row = db.prepare("SELECT * FROM host_profiles WHERE name = ?").get(name) as
    | HostProfile
    | undefined;
  if (row === undefined) throw new HostNotFoundError(name);
  return profileOf(row);
}

export function listHosts(db: Db): HostProfile[] {
  return (db.prepare("SELECT * FROM host_profiles ORDER BY name").all() as HostProfile[]).map(
    profileOf,
  );
}

/** The profiles whose link is plugin `plugin`: `mu plugin rm` refuses while one names it. */
export function hostsOfPlugin(db: Db, plugin: string): string[] {
  return (
    db.prepare("SELECT name FROM host_profiles WHERE plugin = ? ORDER BY name").all(plugin) as {
      name: string;
    }[]
  ).map((h) => h.name);
}

/** Store a profile. Validates the name, cap, default repo, transport and every template first; stores nothing on refusal. */
export function addHost(db: Db, input: NewHostProfile): HostProfile {
  const p: HostProfile = {
    name: input.name,
    shell: input.shell ?? null,
    exec: input.exec ?? null,
    fetch: input.fetch ?? "",
    repo: input.repo,
    max_sessions: input.max_sessions,
    transport: input.transport ?? "session",
    stop: input.stop ?? null,
    attach: input.attach ?? null,
    plugin: input.plugin ?? null,
  };
  if (!isValidHostName(p.name)) {
    throw new HostProfileError(
      `invalid host name ${JSON.stringify(p.name)}: lowercase letters, digits, - and _, starting with a letter (max 32)`,
    );
  }
  if (p.max_sessions !== null && !(Number.isInteger(p.max_sessions) && p.max_sessions > 0)) {
    throw new HostProfileError("--max-sessions must be a positive integer");
  }
  if (p.repo !== null && p.repo.trim() === "") {
    throw new HostProfileError("--repo must not be empty");
  }
  if (p.plugin !== null) {
    refusePluginProfile(db, p);
  } else {
    for (const f of ["shell", "exec"] as const) {
      if (p[f] === null) {
        throw new HostProfileError(`--${f} is required (or --plugin <name>: a plugin as the link)`);
      }
    }
    if (p.fetch === "") throw new HostProfileError("--fetch is required");
  }
  if (!(HOST_TRANSPORTS as readonly string[]).includes(p.transport)) {
    throw new HostProfileError(
      `invalid --transport ${JSON.stringify(p.transport)}: ${HOST_TRANSPORTS.join(" or ")}`,
    );
  }
  if (p.transport === "lease" && p.stop === null) {
    throw new HostProfileError(
      "--stop is required for --transport lease: the template that ends a job given its handle ({job})",
    );
  }
  if (p.transport === "session" && p.stop !== null) {
    throw new HostProfileError(
      "--stop is only for --transport lease: a session has no job to stop",
    );
  }
  if (p.transport === "session" && p.attach !== null) {
    throw new HostProfileError(
      "--attach is only for --transport lease: a session has no job to attach to",
    );
  }
  const problem = profileTemplateProblem(p);
  if (problem !== undefined) throw new HostTemplateError(problem);
  // A name is a profile's or a provider host's, never both (plugins spec D1): checked and
  // inserted in ONE immediate transaction, as an acquire's record is. Read here, not through
  // src/host-records.ts: that module needs this one loaded first.
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM hosts WHERE name = ?").get(p.name) !== undefined) {
      throw new HostExistsError(p.name);
    }
    try {
      // A template profile's row is the one it always was: `plugin` is written only when given.
      db.prepare(
        p.plugin === null
          ? "INSERT INTO host_profiles (name, shell, exec, fetch, repo, max_sessions, transport, stop, attach) VALUES (@name, @shell, @exec, @fetch, @repo, @max_sessions, @transport, @stop, @attach)"
          : "INSERT INTO host_profiles (name, shell, exec, fetch, repo, max_sessions, transport, stop, attach, plugin) VALUES (@name, @shell, @exec, @fetch, @repo, @max_sessions, @transport, @stop, @attach, @plugin)",
      ).run(p);
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new HostExistsError(p.name);
      }
      throw e;
    }
  }).immediate();
  return getHost(db, p.name);
}

/**
 * A `--plugin` profile names a registered plugin whose handshake declared a link, and carries
 * none of a template profile's pane or job fields: its link is the plugin, and it is a session
 * profile (the plugin's job kind joins later).
 */
function refusePluginProfile(db: Db, p: HostProfile): void {
  const given = (["shell", "exec", "stop", "attach"] as const).filter((f) => p[f] !== null);
  if (given.length > 0) {
    throw new HostProfileError(
      `--plugin takes no ${given.map((f) => `--${f}`).join(", ")}: the plugin is the host's link`,
    );
  }
  if (p.transport !== "session") {
    throw new HostProfileError("--plugin takes no --transport: a plugin host is a session profile");
  }
  const name = p.plugin ?? "";
  const row = db.prepare("SELECT caps_json FROM plugins WHERE name = ?").get(name) as
    | { caps_json: string }
    | undefined;
  if (row === undefined) throw new PluginNotFoundError(name);
  const link = (JSON.parse(row.caps_json) as { link?: { fetch?: boolean } }).link;
  if (link === undefined) {
    throw new PluginRefusedError(name, ["it implements no link seam, which a --plugin host needs"]);
  }
  if (p.fetch === "" && link.fetch !== true) {
    throw new HostProfileError(`--fetch is required: plugin ${name}'s link does not fetch`);
  }
}

/**
 * Remove a profile; false when there was none. Refuses while a channel is
 * held, after reclaiming proven-dead transient ones. An attached channel is
 * freed by closing its agent, never here.
 */
export function removeHost(db: Db, name: string): boolean {
  return db
    .transaction(() => {
      reclaim(db, name, []);
      const held = listHostChannels(db, name).map((c) => c.holder);
      if (held.length > 0) throw new HostInUseError(name, held);
      return db.prepare("DELETE FROM host_profiles WHERE name = ?").run(name).changes > 0;
    })
    .immediate();
}

/**
 * The starter for `host init <name> --ssh`: printed for the user to edit,
 * never run. The shell template is a command for the remote login shell
 * (inside quotes, so each value asks for `:sh`, quoting for that shell): cd, env, `$SHELL -ilc`.
 */
export function hostStarter(host: string): { shell: string; exec: string; fetch: string } {
  const ssh = "ssh -o ControlMaster=no -o ControlPath=none";
  return {
    // ControlMaster=no ControlPath=none: a `-L` through a shared control master is bound by the
    // master, not by this client. The listener outlives the pane, and a later ssh asking for
    // the same forward exits 0 with no socket file (the master never re-binds it). Each pane
    // keeps its own connection, so its forward dies with it.
    shell: `${ssh} -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L {local_sock}:{remote_sock} ${host} -t 'cd {cwd:sh} && {env} "$SHELL" -ilc {cmd:sh}'`,
    exec: `${ssh} -o BatchMode=yes ${host} {cmd}`,
    fetch: `git fetch ssh://${host}{cwd} HEAD`,
  };
}

/**
 * The starter for `host init <name> --mule`: a lease profile for a session-capped host,
 * printed for the user to edit, never run. `env {env} sh -c {cmd}`, not `{env} {cmd}`:
 * mule quotes each argv word, so a bare `K='v'` word would run as a program name.
 */
export function hostMuleStarter(host: string): {
  shell: string;
  exec: string;
  fetch: string;
  stop: string;
  attach: string;
} {
  return {
    shell: `mule run --host ${host} --lease --human --cwd {cwd} --job-file {job_file} --forward-unix {local_sock}:{remote_sock} -- env {env} sh -c {cmd}`,
    exec: `mule exec --host ${host} -- sh -c {cmd}`,
    fetch: `git fetch ssh://${host}{cwd} HEAD`,
    stop: `mule rm --host ${host} {job}`,
    attach: `mule run --host ${host} --lease --attach {job} --job-file {job_file} --forward-unix {local_sock}:{remote_sock}`,
  };
}

// ─── Template grammar ───────────────────────────────────────────────────

export const HOST_PLACEHOLDERS = [
  "env",
  "cmd",
  "local_sock",
  "remote_sock",
  "cwd",
  "job_file",
  "job",
] as const;
export type HostPlaceholder = (typeof HOST_PLACEHOLDERS)[number];
export type HostTemplateValues = Partial<Record<HostPlaceholder, string>>;

/** The field a template is stored in; `lease-shell` is the `shell` of a lease profile. */
export type HostTemplateScope = "shell" | "lease-shell" | "exec" | "fetch" | "stop" | "attach";

const LEGACY_PLACEHOLDERS: readonly HostPlaceholder[] = [
  "env",
  "cmd",
  "local_sock",
  "remote_sock",
  "cwd",
];

/** The placeholders each field takes. A name outside its set is refused by the lexer. */
const TEMPLATE_SCOPES: Record<HostTemplateScope, readonly HostPlaceholder[]> = {
  shell: LEGACY_PLACEHOLDERS,
  "lease-shell": [...LEGACY_PLACEHOLDERS, "job_file"],
  exec: LEGACY_PLACEHOLDERS,
  fetch: LEGACY_PLACEHOLDERS,
  stop: ["job", "cwd"],
  attach: ["job", "job_file", "local_sock", "remote_sock", "cwd"],
};

const SCOPE_LABEL: Record<HostTemplateScope, string> = {
  shell: "session shell",
  "lease-shell": "lease shell",
  exec: "exec",
  fetch: "fetch",
  stop: "stop",
  attach: "attach",
};

/**
 * The only variables a remote worker is given: its identity, never the local
 * DB, state or sync dir. `MU_REMOTE=1` tells the remote extension there is no
 * mu DB over there (it skips the close nudge; CLOSE is applied here). A hook
 * harness worker (claude, codex, cursor-agent, muse) also gets its harness,
 * `MU_AGENT_CLI`, and `MU_REMOTE_KEY`, the key its hooks report under on its
 * node (spec D11); a pi worker gets neither.
 */
export const HOST_ENV_KEYS = [
  "MU_MANAGED_AGENT",
  "MU_AGENT_NAME",
  "MU_WORKSTREAM",
  "MU_CTL_SOCK",
  "MU_REMOTE",
  "MU_AGENT_CLI",
  "MU_REMOTE_KEY",
] as const;

/** One shell-quoted value as `shellQuote` writes it: single-quoted runs and `"'"`. */
const QUOTED = `(?:'[^']*'|"'")+`;
const ENV_WORD = `(?:${HOST_ENV_KEYS.join("|")})=${QUOTED}`;
const ENV_WORDS_RE = new RegExp(`^(?:${ENV_WORD}(?: ${ENV_WORD})*)?$`);

/** `K='v'` words for `{env}`: whitelisted keys, every value shell-quoted (any text survives), nothing else. */
export function hostEnvWords(env: Record<string, string>): string {
  const words: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!(HOST_ENV_KEYS as readonly string[]).includes(k)) {
      throw new HostTemplateError(
        `{env} may carry only ${HOST_ENV_KEYS.join(", ")}; ${k} is not forwarded`,
      );
    }
    if (v.includes("\0")) throw new HostTemplateError(`{env} value for ${k} contains a NUL byte`);
    words.push(`${k}=${shellQuote(v)}`);
  }
  return words.join(" ");
}

type Ctx = "none" | "sq" | "dq";
type Token = { lit: string } | { ph: HostPlaceholder; ctx: Ctx; layers: 1 | 2 };

const KNOWN = `${HOST_PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}; {name:sh} quotes for a second shell`;

function parseTemplate(t: string, scope?: HostTemplateScope): Token[] {
  const out: Token[] = [];
  let lit = "";
  let ctx: Ctx = "none";
  let subst = false; // inside $( or backticks within double quotes
  const flush = (): void => {
    if (lit !== "") out.push({ lit });
    lit = "";
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    const next = t[i + 1];
    if (c === "{") {
      if (next === "{") {
        lit += "{";
        i++;
        continue;
      }
      const end = t.indexOf("}", i);
      const body = end === -1 ? "" : t.slice(i + 1, end);
      const colon = body.indexOf(":");
      const name = colon === -1 ? body : body.slice(0, colon);
      const mod = colon === -1 ? undefined : body.slice(colon + 1);
      if (!(HOST_PLACEHOLDERS as readonly string[]).includes(name)) {
        throw new HostTemplateError(
          end === -1 || name === "" || /\s/.test(name)
            ? `stray { in template (write {{ for a literal brace; placeholders: ${KNOWN})`
            : `unknown placeholder {${name}} (known: ${KNOWN})`,
        );
      }
      if (mod !== undefined && mod !== "sh") {
        throw new HostTemplateError(`unknown modifier {${body}} (the only one is {${name}:sh})`);
      }
      if (name === "env" && mod !== undefined) {
        throw new HostTemplateError(
          "{env:sh} is refused: {env} is already text for the inner shell",
        );
      }
      if (scope !== undefined && !TEMPLATE_SCOPES[scope].includes(name as HostPlaceholder)) {
        throw new HostTemplateError(
          `{${name}} is not valid in the ${SCOPE_LABEL[scope]} template (it takes ${TEMPLATE_SCOPES[scope].map((p) => `{${p}}`).join(" ")})`,
        );
      }
      if (ctx === "dq" && subst) {
        throw new HostTemplateError(`{${name}} inside $(...) or backticks in double quotes`);
      }
      flush();
      out.push({ ph: name as HostPlaceholder, ctx, layers: mod === undefined ? 1 : 2 });
      i = end;
      continue;
    }
    if (c === "}") {
      if (next !== "}")
        throw new HostTemplateError("stray } in template (write }} for a literal brace)");
      lit += "}";
      i++;
      continue;
    }
    lit += c;
    if (ctx === "sq") {
      if (c === "'") ctx = "none";
    } else if (c === "\\") {
      if (next === undefined) continue;
      if (next === "{" || next === "}") {
        throw new HostTemplateError(
          "a brace right after a backslash is ambiguous: quote it instead",
        );
      }
      lit += next;
      i++;
    } else if (ctx === "dq") {
      if (c === '"') {
        ctx = "none";
        subst = false;
      } else if (c === "`" || (c === "$" && next === "(")) subst = true;
    } else if (c === "'") ctx = "sq";
    else if (c === '"') ctx = "dq";
  }
  flush();
  return out;
}

/** Throws HostTemplateError unless `template` is well-formed (and, with a `scope`, uses only that field's placeholders). */
export function validateHostTemplate(template: string, scope?: HostTemplateScope): void {
  parseTemplate(template, scope);
}

/** How often each placeholder is USED (lexer tokens: an escaped `{{x}}` is a literal, not a use). */
export function placeholderUses(
  template: string,
  scope?: HostTemplateScope,
): Record<HostPlaceholder, number> {
  const n = Object.fromEntries(HOST_PLACEHOLDERS.map((p) => [p, 0])) as Record<
    HostPlaceholder,
    number
  >;
  for (const tok of parseTemplate(template, scope)) if ("ph" in tok) n[tok.ph]++;
  return n;
}

/**
 * What a lease `shell` must contain: `{job_file}` exactly once, `{local_sock}` and `{remote_sock}`
 * at least once. An `attach` must also contain `{job}` exactly once.
 */
export function leaseShellProblems(
  shell: string,
  scope: "lease-shell" | "attach" = "lease-shell",
): string[] {
  const n = placeholderUses(shell, scope);
  const what = scope === "attach" ? "an attach" : "a lease shell";
  return [
    ...(scope === "attach" && n.job !== 1
      ? [`an attach template must contain {job} exactly once (found ${n.job})`]
      : []),
    ...(n.job_file === 1
      ? []
      : [`${what} template must contain {job_file} exactly once (found ${n.job_file})`]),
    ...(n.local_sock > 0 ? [] : [`${what} template must contain {local_sock}`]),
    ...(n.remote_sock > 0 ? [] : [`${what} template must contain {remote_sock}`]),
  ];
}

/**
 * The first reason a profile's templates are refused, `--field:`-prefixed, or undefined.
 * Grammar and per-field placeholders for all five; a lease shell's and an attach's shape; a stop's `{job}`.
 */
function profileTemplateProblem(
  p: Pick<HostProfile, "shell" | "exec" | "fetch" | "transport" | "stop" | "attach">,
): string | undefined {
  const fields: [string, string, HostTemplateScope][] = [
    ...(p.shell === null
      ? []
      : [
          ["shell", p.shell, p.transport === "lease" ? "lease-shell" : "shell"] as [
            string,
            string,
            HostTemplateScope,
          ],
        ]),
    ...(p.exec === null ? [] : [["exec", p.exec, "exec"] as [string, string, HostTemplateScope]]),
    ...(p.fetch === "" ? [] : [["fetch", p.fetch, "fetch"] as [string, string, HostTemplateScope]]),
    ...(p.stop === null ? [] : [["stop", p.stop, "stop"] as [string, string, HostTemplateScope]]),
    ...(p.attach === null
      ? []
      : [["attach", p.attach, "attach"] as [string, string, HostTemplateScope]]),
  ];
  for (const [f, t, scope] of fields) {
    try {
      validateHostTemplate(t, scope);
      const extra =
        scope === "lease-shell" || scope === "attach"
          ? leaseShellProblems(t, scope)
          : scope === "stop" && placeholderUses(t, scope).job === 0
            ? ["a stop template must contain {job}"]
            : [];
      if (extra.length > 0) return `--${f}: ${extra.join("; ")}`;
    } catch (e) {
      if (e instanceof HostTemplateError) return `--${f}: ${e.message}`;
      throw e;
    }
  }
  return undefined;
}

/**
 * Expand `template` in one pass. Every value is quoted for the layer it lands
 * in and stays one word (`{name:sh}` adds the second-shell layer); {env} is
 * whitelisted assignment words. A placeholder with
 * no value in this context is an error, never blanked.
 */
export function expandHostTemplate(
  template: string,
  values: HostTemplateValues,
  scope?: HostTemplateScope,
): string {
  let out = "";
  for (const tok of parseTemplate(template, scope)) {
    if ("lit" in tok) {
      out += tok.lit;
      continue;
    }
    const v = values[tok.ph];
    if (v === undefined) throw new HostTemplateError(`{${tok.ph}} has no value in this template`);
    if (v.includes("\0")) throw new HostTemplateError(`{${tok.ph}} value contains a NUL byte`);
    let text: string;
    if (tok.ph === "env") {
      if (!ENV_WORDS_RE.test(v)) {
        throw new HostTemplateError(
          `{env} must be KEY='value' words of ${HOST_ENV_KEYS.join(", ")} (build it with hostEnvWords)`,
        );
      }
      text = v;
    } else if (tok.ctx === "none") {
      out += tok.layers === 2 ? shellQuote(shellQuote(v)) : shellQuote(v);
      continue;
    } else text = tok.layers === 2 ? shellQuote(v) : v;
    if (tok.ctx === "sq") out += text.replace(/'/g, `'\\''`);
    else if (tok.ctx === "dq") out += text.replace(/[\\"$`]/g, "\\$&");
    else out += text;
  }
  return out;
}

/** A remote path as a shell word: a leading `~` becomes "$HOME" (quoting would stop tilde expansion). */
export function remotePathWord(p: string): string {
  if (p === "~") return '"$HOME"';
  if (p.startsWith("~/")) return `"$HOME"/${shellQuote(p.slice(2))}`;
  return shellQuote(p);
}

// ─── Channels ───────────────────────────────────────────────────────────

export interface HostChannel {
  host: string;
  holder: string;
  kind: "transient" | "attached";
  token: string;
  pid: number | null;
  pid_start: string | null;
  /** The template's process group (its leader's pid), set before the command starts. */
  pgid: number | null;
  pgid_start: string | null;
  agent_id: number | null;
  pane_id: string | null;
  opened_at: string;
}

/** Proof of a reservation: release and bind are compare-and-set on `token`. */
export interface HostLease {
  host: string;
  holder: string;
  token: string;
}

export interface ChannelOpts {
  /** Is this pane alive? Throwing or absent means unknown, which keeps the channel. */
  paneAlive?: (paneId: string) => Promise<boolean>;
}

export function listHostChannels(db: Db, host?: string): HostChannel[] {
  return (
    host === undefined
      ? db.prepare("SELECT * FROM host_channels ORDER BY host, holder").all()
      : db.prepare("SELECT * FROM host_channels WHERE host = ? ORDER BY holder").all(host)
  ) as HostChannel[];
}

/** The pid's start time (Linux: /proc stat field 22), or null when unreadable. */
export function pidStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** True only when the holder is certainly gone: ESRCH, or the pid now has another start time. */
export function pidProvenGone(pid: number, start: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  if (start === null) return false;
  const now = pidStart(pid);
  return now !== null && now !== start;
}

/**
 * Is the template's process group still there? `kill(-pgid, 0)` succeeding
 * or failing with EPERM means yes. Only ESRCH, or proof that the pid was
 * reused (the leader pid is alive with another start time: a pid cannot be
 * reused while its group has members), means gone.
 */
export function groupAlive(pgid: number, start: string | null): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (start === null) return true;
  const now = pidStart(pgid);
  return now === null || now === start;
}

/** Attached channels whose pane is proven dead. Runs OUTSIDE any transaction. */
async function probeAttached(
  db: Db,
  host: string,
  paneAlive: ChannelOpts["paneAlive"],
): Promise<HostChannel[]> {
  if (paneAlive === undefined) return [];
  const dead: HostChannel[] = [];
  for (const c of listHostChannels(db, host)) {
    if (c.kind !== "attached" || c.pane_id === null) continue;
    try {
      if (!(await paneAlive(c.pane_id))) dead.push(c);
    } catch {
      /* unknown: keep */
    }
  }
  return dead;
}

/**
 * Delete proven-dead rows: transient by pid, and held while its template's
 * process group lives, whoever died; attached only the identity that
 * was PROBED dead. `deadPanes` is the snapshot read before the awaited probe;
 * a row matches only if holder, token, agent id and pane all equal it, and
 * the DELETE binds the snapshot's values, never the re-read row's.
 */
function reclaim(db: Db, host: string, deadPanes: readonly HostChannel[]): void {
  const del = db.prepare(
    "DELETE FROM host_channels WHERE host = ? AND holder = ? AND token = ? AND agent_id IS ? AND pane_id IS ?",
  );
  for (const c of listHostChannels(db, host)) {
    if (c.kind === "transient") {
      const holderGone = c.pid !== null && pidProvenGone(c.pid, c.pid_start);
      if (holderGone && !(c.pgid !== null && groupAlive(c.pgid, c.pgid_start))) {
        del.run(host, c.holder, c.token, c.agent_id, c.pane_id);
      }
      continue;
    }
    for (const d of deadPanes) {
      if (d.holder === c.holder && d.token === c.token) {
        del.run(host, d.holder, d.token, d.agent_id, d.pane_id);
      }
    }
  }
}

/**
 * Reserve a transient channel for `holder`, or throw HostChannelBusyError
 * naming who holds the host. One holder never holds two channels, and a
 * refused call changes nothing (it can never release or steal another's).
 */
export async function reserveHostChannel(
  db: Db,
  host: string,
  holder: string,
  opts: ChannelOpts = {},
): Promise<HostLease> {
  return (await admit(db, host, holder, opts)).lease;
}

/**
 * Admission: the profile is read INSIDE the BEGIN IMMEDIATE that counts, so
 * the cap enforced is the one that exists at admission (a profile removed or
 * re-added during the awaited probe is seen, or refused as not found, never
 * an orphan row). The returned profile is that snapshot; run the template
 * from it, not from a re-read.
 */
export async function admitHostChannel(
  db: Db,
  host: string,
  holder: string,
  opts: ChannelOpts = {},
): Promise<{ lease: HostLease; profile: HostProfile }> {
  return admit(db, host, holder, opts);
}

async function admit(
  db: Db,
  host: string,
  holder: string,
  opts: ChannelOpts,
): Promise<{ lease: HostLease; profile: HostProfile }> {
  getHost(db, host); // fail fast, before probing panes
  const dead = await probeAttached(db, host, opts.paneAlive);
  const token = randomUUID();
  const profile = db
    .transaction(() => {
      const profile = getHost(db, host);
      reclaim(db, host, dead);
      const rows = listHostChannels(db, host);
      if (rows.some((r) => r.holder === holder)) {
        throw new HostChannelBusyError(
          host,
          [holder],
          `host ${host}: ${holder} already holds a channel`,
        );
      }
      const cap = profile.max_sessions;
      if (cap !== null && rows.length >= cap) {
        const names = rows.map((r) => r.holder);
        throw new HostChannelBusyError(
          host,
          names,
          `host ${host} is at --max-sessions ${cap}: held by ${names.join(", ")}`,
        );
      }
      db.prepare(
        "INSERT INTO host_channels (host, holder, kind, token, pid, pid_start, opened_at) VALUES (?, ?, 'transient', ?, ?, ?, ?)",
      ).run(host, holder, token, process.pid, pidStart(process.pid), new Date().toISOString());
      return profile;
    })
    .immediate();
  return { lease: { host, holder, token }, profile };
}

/** Free a channel by token. False when it was already gone or is another's now. */
export function releaseHostChannel(db: Db, lease: HostLease): boolean {
  return (
    db
      .prepare("DELETE FROM host_channels WHERE host = ? AND holder = ? AND token = ?")
      .run(lease.host, lease.holder, lease.token).changes > 0
  );
}

/** Transfer a transient reservation to an agent's pane (registry id + pane). False unless the lease is still live. */
export function bindHostChannel(
  db: Db,
  lease: HostLease,
  to: { agentId: number; paneId: string },
): boolean {
  return (
    db
      .prepare(
        `UPDATE host_channels SET kind = 'attached', pid = NULL, pid_start = NULL, pgid = NULL, pgid_start = NULL, agent_id = ?, pane_id = ?
         WHERE host = ? AND holder = ? AND token = ? AND kind = 'transient'`,
      )
      .run(to.agentId, to.paneId, lease.host, lease.holder, lease.token).changes === 1
  );
}

/** Free the attached channels of one agent incarnation: registry id AND pane, never a name. Touches nothing else. */
export function releaseHostChannelsForAgent(db: Db, agentId: number, paneId: string): number {
  return db
    .prepare("DELETE FROM host_channels WHERE kind = 'attached' AND agent_id = ? AND pane_id = ?")
    .run(agentId, paneId).changes;
}

/**
 * Record the template's process group on its lease (compare-and-set on the
 * token). Throws when the lease is gone, so the command never starts under a
 * channel it no longer holds.
 */
function recordGroup(db: Db, lease: HostLease, pgid: number): void {
  const n = db
    .prepare(
      "UPDATE host_channels SET pgid = ?, pgid_start = ? WHERE host = ? AND holder = ? AND token = ?",
    )
    .run(pgid, pidStart(pgid), lease.host, lease.holder, lease.token).changes;
  if (n !== 1) throw new Error(say("host.channel_lost", lease.host, lease.holder));
}

/** Hold a transient channel for the duration of `run` (given the admission snapshot of the profile and the lease); released in `finally` by token. */
export async function withHostChannel<T>(
  db: Db,
  host: string,
  holder: string,
  run: (profile: HostProfile, lease: HostLease) => Promise<T>,
  opts: ChannelOpts = {},
): Promise<T> {
  const { lease, profile } = await admit(db, host, holder, opts);
  try {
    return await run(profile, lease);
  } finally {
    releaseHostChannel(db, lease);
  }
}

// ─── Running templates ──────────────────────────────────────────────────

/** Per-command budget for exec and check. */
export const HOST_COMMAND_TIMEOUT_MS = 20_000;

/** TERM-to-KILL grace for a host template's process group (`execGroupCapture`). */
export const HOST_GRACE_MS = 5000;

export interface HostRun {
  /** null: killed by the timeout or a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Expand `field` of `profile` and run it with /bin/sh -c. No retry, no
 * fallback. Exit 3 throws `HostHandbackError`. The command is its own process group: on timeout or caller
 * termination the whole group (the template's transport included) is gone
 * before this returns, so the channel is never released under a live one.
 * The template runner: called by the link (src/host-link.ts), the lease kind's
 * stop (src/carrier-stop.ts) and `checkHost` only (test/link-imports.test.ts).
 */
export async function runLeasedTemplate(
  db: Db,
  lease: HostLease,
  profile: HostProfile,
  field: "exec" | "fetch" | "stop",
  values: HostTemplateValues,
  timeoutMs: number,
  /** The template's LOCAL working directory (a `--fetch` runs in the repo it fetches into). */
  localCwd?: string,
): Promise<HostRun> {
  const template = profile[field];
  if (template === null || template === "")
    throw new HostTemplateError(`host ${profile.name} has no ${field} template`);
  const expanded = expandHostTemplate(template, values, field);
  const run = await execGroupCapture("/bin/sh", ["-c", expanded], {
    timeoutMs,
    // A carrier interrupted by the timeout needs time to stop what it dispatched.
    graceMs: HOST_GRACE_MS,
    ...(localCwd !== undefined ? { cwd: localCwd } : {}),
    onSpawn: (pgid) => recordGroup(db, lease, pgid),
  });
  if (run.exitCode === 3) {
    throw new HostHandbackError(
      profile.name,
      field,
      firstLine(run.stderr) || firstLine(run.stdout),
    );
  }
  return run;
}

/** Run the profile's `exec` or `fetch` template under one transient channel. */
export async function runHostTemplate(
  db: Db,
  host: string,
  field: "exec" | "fetch",
  holder: string,
  values: HostTemplateValues,
  opts: ChannelOpts & { timeoutMs?: number; localCwd?: string } = {},
): Promise<HostRun> {
  const timeoutMs = opts.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS;
  return withHostChannel(
    db,
    host,
    holder,
    (profile, lease) =>
      runLeasedTemplate(db, lease, profile, field, values, timeoutMs, opts.localCwd),
    opts,
  );
}

// ─── Check ──────────────────────────────────────────────────────────────

export interface HostCheckStep {
  /**
   * mu's own and the built-in seams' steps: `shell`, `stop`, `attach` (the lease kind's
   * templates), `reachable`, `repo` (the template link), `harnesses`, `hooks`, `pi`,
   * `extension`, `job` (the lease kind), `ctl`, `handback`. A plugin's: `<plugin>:<step>`.
   */
  step: string;
  /** null: skipped because the host was not reachable. */
  ok: boolean | null;
  /** A plugin's step at the warn level: it passed (`ok` true), and prints as a warn line. */
  warn?: true;
  detail: string;
}

export interface HostCheckReport {
  host: string;
  ok: boolean;
  steps: HostCheckStep[];
  /** Advice that never fails the check (a heuristic, said as one). */
  warnings: string[];
  /** The harness probe this check took and recorded on the profile; absent when it got no answer. */
  capabilities?: HostCapabilities;
}

export interface HostCheckOptions extends ChannelOpts {
  timeoutMs?: number;
  /** Also probe this agent's derived local control socket: the forward rides its pane. */
  agent?: { name: string; workstream: string };
  /** The remote repo the `repo` step checks (default the profile's); with neither it is skipped. */
  root?: string;
}

/** A remote step's detail once a template handed back: every later remote step says it. */
export const HANDED_BACK = "skipped: the host handed back";

const firstLine = (s: string): string =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

/** An interactive login shell may print rc-file noise first: the answer is the last stdout line. */
const lastLine = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop() ?? "";

/** Runs a check's remote steps, one command each, and remembers a hand-back. */
export interface CheckRunner {
  /** A template exited 3: every later step is skipped, as for an unreachable host. */
  readonly handedBack: boolean;
  /**
   * Run `cmd` and push its step onto `out`: `good` turns a clean exit into a detail (or
   * undefined: `unmet`). A hand-back pushes the step skipped and a `handback` step. Each
   * failure is reported, none retried. True when the step passed.
   */
  step(
    out: HostCheckStep[],
    name: string,
    cmd: string,
    good: (r: HostRun) => string | undefined,
    unmet: string | (() => string),
  ): Promise<boolean>;
}

/** A runner over `run` (one command through the host's link); `handedBack` carries an earlier one. */
export function checkRunner(
  run: (cmd: string) => Promise<HostRun>,
  timeoutMs: number,
  handedBack = false,
): CheckRunner {
  const r = {
    handedBack,
    async step(
      out: HostCheckStep[],
      name: string,
      cmd: string,
      good: (r: HostRun) => string | undefined,
      unmet: string | (() => string),
    ): Promise<boolean> {
      if (r.handedBack) {
        out.push({ step: name, ok: null, detail: HANDED_BACK });
        return false;
      }
      let detail: string;
      let ok = false;
      try {
        const res = await run(cmd);
        const why = firstLine(res.stderr) || firstLine(res.stdout);
        const good1 = res.exitCode === 0 ? good(res) : undefined;
        ok = good1 !== undefined;
        detail =
          good1 ??
          (res.exitCode === null
            ? `timed out after ${timeoutMs}ms`
            : res.exitCode === 0
              ? typeof unmet === "string"
                ? unmet
                : unmet()
              : `exit ${res.exitCode}${why === "" ? "" : `: ${why}`}`);
      } catch (e) {
        if (e instanceof HostHandbackError) {
          r.handedBack = true;
          out.push({ step: name, ok: null, detail: HANDED_BACK });
          out.push({ step: "handback", ok: false, detail: `${name}: ${e.message}` });
          return false;
        }
        if (!(e instanceof HostTemplateError)) throw e;
        detail = e.message;
      }
      out.push({ step: name, ok, detail });
      return ok;
    },
  };
  return r;
}

/**
 * Check a host (a profile under ONE channel; a provider host, D6, through its provider's
 * link, its record's repo the default `root`), in phases (spec 2026-11-09-mu-plugins.md, D11): the
 * `template` phase (the job kind's; a lease profile's shell, stop and attach, never run),
 * the `reach` phase (the link's: it answers, and the repo, `root` else the profile's,
 * is a git repo), then mu's own steps through the link: which harnesses resolve in the
 * profile's shell mode (recorded on the profile, src/host-harnesses.ts) with murmur's
 * hook entries for each hook harness found, and, when the host has pi (or the probe got
 * no answer), pi runs and `pi list` names mu. With `agent`: the `agent` phase (a lease
 * kind's recorded job), then mu's ctl probe of the forwarded socket. A host with no pi
 * skips the pi steps, so a claude-only host passes. The host is reachable when the reach
 * phase's first step passed; an unreachable host, or one that handed back, skips the rest.
 * The ctl probe only reads an existing forward.
 */
export async function checkHost(
  db: Db,
  host: string,
  opts: HostCheckOptions = {},
): Promise<HostCheckReport> {
  // Imported at the call, not the top: host-provider.ts (and the link and kinds it views a
  // profile with) imports this module and subclasses its errors at load.
  const { withHostView } = await import("./host-provider.js");
  const holder = `check:${process.pid}`;
  const timeoutMs = opts.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS;
  const steps: HostCheckStep[] = [];
  let warnings: string[] = [];
  let capabilities: HostCapabilities | undefined;

  await withHostView(
    db,
    host,
    holder,
    async (view, lease) => {
      // A profile's view is the ADMITTED one (admission re-reads it after the pane probes),
      // never a read taken before: a profile that changed transport mid-probe would otherwise
      // get the other transport's shell mode and job kind. A provider host (D6) has no
      // profile: its record names the repo, and its link admits its own calls.
      const profile = view.profile;
      const bareShell = profile?.transport === "lease";
      const root = opts.root ?? profile?.repo ?? view.record?.repo ?? undefined;
      const call = lease !== undefined ? { lease } : { holder };
      const ctx = (phase: CheckPhase): CheckContext => ({
        db,
        host: view,
        phase,
        timeoutMs,
        ...(root !== undefined ? { root } : {}),
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      });
      const phase = async (p: CheckPhase): Promise<HostCheckStep[]> => [
        ...(view.link.caps.checks?.includes(p) && view.link.checkSteps
          ? await view.link.checkSteps(ctx(p), call)
          : []),
        ...(view.jobKind?.caps.checks?.includes(p) && view.jobKind.checkSteps
          ? await view.jobKind.checkSteps(ctx(p))
          : []),
      ];
      warnings = profile === undefined ? [] : sessionShellWarnings(profile);
      steps.push(...(await phase("template")));
      const reach = await phase("reach");
      steps.push(...reach);
      const reachable = reach[0]?.ok === true;
      const runner = checkRunner(
        // `.` without a repo: a template's `cd {cwd:sh}` stays in the login directory.
        (cmd) => view.link.exec(view, { script: cmd, cwd: root ?? ".", timeoutMs }, call),
        timeoutMs,
        reach.some((s) => s.step === "handback"),
      );
      // A lease job runs in a non-login shell (the starter's `sh -c`): a login-shell success says
      // nothing about it, so the pi and extension steps run bare for a lease profile.
      const login = (cmd: string): string =>
        bareShell ? cmd : `"\${SHELL:-sh}" -ilc ${shellQuote(cmd)}`;
      if (reachable) {
        // The literal launchers, in the shell a spawn's command gets (spec D17): recorded even
        // when none is found, so a spawn for a missing harness is refused by name.
        const shell = bareShell ? "sh" : "login";
        await runner.step(
          steps,
          "harnesses",
          login(harnessProbeScript()),
          (r) => {
            capabilities = parseHarnessProbe(r.stdout, shell);
            return capabilities === undefined ? undefined : harnessesDetail(capabilities);
          },
          () => noHarnessDetail(capabilities),
        );
        if (capabilities !== undefined) {
          // A provider host has no profile to record the probe on: the report carries it.
          if (profile !== undefined) recordHostCapabilities(db, profile, capabilities);
          const hooks = hooksStep(capabilities);
          steps.push(hooks.step);
          warnings.push(...hooks.warnings);
        } else {
          steps.push({
            step: "hooks",
            ok: null,
            detail: runner.handedBack ? HANDED_BACK : "skipped: no harness report",
          });
        }
        if (capabilities !== undefined && capabilities.harnesses.pi.command === null) {
          for (const s of ["pi", "extension"] as const) {
            steps.push({ step: s, ok: null, detail: "skipped: the host has no pi" });
          }
        } else {
          await runner.step(
            steps,
            "pi",
            login("pi --version"),
            (r) => lastLine(r.stdout) || undefined,
            "pi printed no version",
          );
          await runner.step(
            steps,
            "extension",
            login("pi list"),
            (r) =>
              r.stdout
                .split("\n")
                .find((l) => /\bmu\b/.test(l))
                ?.trim(),
            "pi list does not name mu",
          );
        }
      } else {
        for (const s of ["harnesses", "hooks", "pi", "extension"] as const) {
          steps.push({
            step: s,
            ok: null,
            detail: runner.handedBack ? HANDED_BACK : "skipped: host not reachable",
          });
        }
      }
      if (opts.agent !== undefined) steps.push(...(await phase("agent")));
      if (opts.agent !== undefined && runner.handedBack) {
        steps.push({ step: "ctl", ok: null, detail: HANDED_BACK });
      } else if (opts.agent !== undefined) {
        const { name, workstream } = opts.agent;
        const p = await ctlProbe(
          ctlSocketPath(workstream, name, dirname(db.name)),
          Math.min(timeoutMs, 5000),
        );
        const who = `${workstream}/${name}`;
        steps.push(
          p.kind === "ok"
            ? {
                step: "ctl",
                ok: true,
                detail: `${who}: extension ${p.extVersion ?? "version unknown"}${p.features ? ` (${p.features.join(", ")})` : ""}`,
              }
            : {
                step: "ctl",
                ok: false,
                detail: `${who}: ${p.kind === "refused" ? `refused: ${p.error}` : p.kind === "missing" ? "no forwarded socket" : "protocol version mismatch"}`,
              },
        );
      }
    },
    opts,
  );
  return {
    host,
    ok: steps.every((s) => s.ok !== false),
    steps,
    warnings,
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

/**
 * A session `shell` template that can ride a shared ssh master: the master, not the pane,
 * binds a `-L` and keeps it past the pane. A heuristic on the template text, never a failure.
 * Every profile is a session profile today.
 */
function sessionShellWarnings(profile: HostProfile): string[] {
  if (profile.transport !== "session" || profile.shell === null) return [];
  const noMaster = /ControlMaster[= ]+no\b/i.test(profile.shell);
  const noPath = /ControlPath[= ]+none\b/i.test(profile.shell);
  if (noMaster && noPath) return [];
  const lacks = [
    ...(noMaster ? [] : ["ControlMaster=no"]),
    ...(noPath ? [] : ["ControlPath=none"]),
  ];
  return [
    `shell template lacks ${lacks.join(" and ")}: a forward that rides a shared ssh master is bound by the master and outlives the pane (heuristic; see mu host init --ssh)`,
  ];
}
