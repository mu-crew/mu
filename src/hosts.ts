// mu — host profiles: ssh-free command templates, and the channels they use.
//
// mu never connects to a host and knows no ssh flags. A profile is three
// templates the user wrote (`shell`, `exec`, `fetch`), a `repo` path and an
// optional `max_sessions`. mu fills the documented placeholders and runs the
// result with `/bin/sh -c`; `host init --ssh` only PRINTS a starter to edit.
//
// ─── Template grammar (one pass over the ORIGINAL template) ─────────────
//   {{ and }}   literal braces. A lone `{` or `}`, or an unknown name, is an
//               error: nothing is guessed. (A shell `${HOME}` is `${{HOME}}`.)
//   {name}      one of env, cmd, local_sock, remote_sock, cwd. The value is
//               substituted once and never rescanned, so braces inside a
//               value are inert.
// A small lexer tracks '...' and "..." so every value stays ONE atomic word
// where it lands:
//   unquoted    the value as one single-quoted word of the local shell.
//   '...' "..." the template is writing a command for a SECOND shell (what
//               ssh hands the remote side), so the value is quoted for that
//               shell first, then escaped for the enclosing quote
//               (`'` -> `'\''`; `\ " $ \`` backslash-escaped). It is atomic at
//               both layers.
// A placeholder after a backslash, or inside $(...) / backticks within double
// quotes, is refused (the lexer does not nest shells).
// {env} is the exception: a run of KEY=VALUE assignment words, so it can
// precede a command. Keys are the four remote identity variables only (never
// the local DB, state or sync dir) and values a safe charset, so it is valid
// in every context.
//
// ─── Channels ───────────────────────────────────────────────────────────
// `max_sessions` counts every channel mu holds open to a host. A channel is
// one `host_channels` row (machine-local), reserved BEFORE the connection is
// opened, under BEGIN IMMEDIATE that covers reserve/count/cleanup only, never
// the awaited template run:
//   transient   rides one invocation (exec, fetch, check); released in
//               `finally` by token; reclaimed only when its pid is proven
//               gone (ESRCH, or the pid's start time changed). EPERM or any
//               unknown keeps the row.
//   attached    rides an agent's pane (registry id + pane, no pid): reserve,
//               `bindHostChannel` once the pane exists, and
//               `releaseHostChannelsForAgent(id, pane)` at close. Reclaimed
//               only when the pane is proven dead; a liveness probe that
//               throws, or no probe, keeps the row.
// Wiring attached channels into spawn and close is v_remote_spawn.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ctlProbe } from "./ctl/client.js";
import { ctlSocketPath } from "./ctl/path.js";
import type { Db } from "./db.js";
import { execFileCapture } from "./exec-file.js";
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
    super(`no host profile named ${host}`);
  }
}

export class HostExistsError extends Error {
  override readonly name = "HostExistsError";
  constructor(public readonly host: string) {
    super(`host profile ${host} already exists: remove it first (mu host rm ${host})`);
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
  errorNextSteps(): { intent: string; command: string }[] {
    return [{ intent: "See what holds the host", command: `mu host show ${this.host}` }];
  }
}

/** `host rm` of a host that still holds a channel. */
export class HostInUseError extends Error {
  override readonly name = "HostInUseError";
  constructor(
    public readonly host: string,
    public readonly holders: readonly string[],
  ) {
    super(`host ${host} still holds channels (${holders.join(", ")}): close those agents first`);
  }
}

/** `host check` found a failing step. The report rides on `failureWithData`. */
export class HostCheckFailedError extends Error {
  override readonly name = "HostCheckFailedError";
  constructor(
    public readonly host: string,
    public readonly failed: readonly string[],
  ) {
    super(`host ${host} check failed: ${failed.join(", ")}`);
  }
}

// ─── Profiles ───────────────────────────────────────────────────────────

export interface HostProfile {
  name: string;
  shell: string;
  exec: string;
  fetch: string;
  repo: string;
  max_sessions: number | null;
}

const HOST_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidHostName(name: string): boolean {
  return HOST_NAME_RE.test(name);
}

export function getHost(db: Db, name: string): HostProfile {
  const row = db.prepare("SELECT * FROM host_profiles WHERE name = ?").get(name) as
    | HostProfile
    | undefined;
  if (row === undefined) throw new HostNotFoundError(name);
  return row;
}

export function listHosts(db: Db): HostProfile[] {
  return db.prepare("SELECT * FROM host_profiles ORDER BY name").all() as HostProfile[];
}

/** Store a profile. Validates the name, cap, repo and every template first; stores nothing on refusal. */
export function addHost(db: Db, p: HostProfile): HostProfile {
  if (!isValidHostName(p.name)) {
    throw new HostProfileError(
      `invalid host name ${JSON.stringify(p.name)}: lowercase letters, digits, - and _, starting with a letter (max 32)`,
    );
  }
  if (p.max_sessions !== null && !(Number.isInteger(p.max_sessions) && p.max_sessions > 0)) {
    throw new HostProfileError("--max-sessions must be a positive integer");
  }
  if (p.repo.trim() === "") throw new HostProfileError("--repo must not be empty");
  for (const f of ["shell", "exec", "fetch"] as const) {
    try {
      validateHostTemplate(p[f]);
    } catch (e) {
      if (e instanceof HostTemplateError) throw new HostTemplateError(`--${f}: ${e.message}`);
      throw e;
    }
  }
  try {
    db.prepare(
      "INSERT INTO host_profiles (name, shell, exec, fetch, repo, max_sessions) VALUES (@name, @shell, @exec, @fetch, @repo, @max_sessions)",
    ).run(p);
  } catch (e) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      throw new HostExistsError(p.name);
    }
    throw e;
  }
  return getHost(db, p.name);
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
 * (inside quotes, so each value is quoted for it): cd, env, `$SHELL -ilc`.
 */
export function hostStarter(host: string): { shell: string; exec: string; fetch: string } {
  const ssh = "ssh -o ControlMaster=no -o ControlPath=none";
  return {
    // ControlMaster=no: a multiplexed ssh never binds the local end of the forward.
    shell: `${ssh} -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L {local_sock}:{remote_sock} ${host} -t 'cd {cwd} && {env} "$SHELL" -ilc {cmd}'`,
    exec: `${ssh} -o BatchMode=yes ${host} {cmd}`,
    fetch: `git fetch ssh://${host}{cwd} HEAD`,
  };
}

// ─── Template grammar ───────────────────────────────────────────────────

export const HOST_PLACEHOLDERS = ["env", "cmd", "local_sock", "remote_sock", "cwd"] as const;
export type HostPlaceholder = (typeof HOST_PLACEHOLDERS)[number];
export type HostTemplateValues = Partial<Record<HostPlaceholder, string>>;

/** The only variables a remote worker is given: its identity, never the local DB, state or sync dir. */
export const HOST_ENV_KEYS = [
  "MU_MANAGED_AGENT",
  "MU_AGENT_NAME",
  "MU_WORKSTREAM",
  "MU_CTL_SOCK",
] as const;

const ENV_WORD = `(?:${HOST_ENV_KEYS.join("|")})=[A-Za-z0-9_./@+-]+`;
const ENV_WORDS_RE = new RegExp(`^${ENV_WORD}(?: ${ENV_WORD})*$`);
const ENV_VALUE_RE = /^[A-Za-z0-9_./@+-]+$/;

/** `K=V` words for `{env}`: whitelisted keys, safe values, nothing else. */
export function hostEnvWords(env: Record<string, string>): string {
  const words: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!(HOST_ENV_KEYS as readonly string[]).includes(k)) {
      throw new HostTemplateError(
        `{env} may carry only ${HOST_ENV_KEYS.join(", ")}; ${k} is not forwarded`,
      );
    }
    if (!ENV_VALUE_RE.test(v)) {
      throw new HostTemplateError(
        `{env} value for ${k} must match [A-Za-z0-9_./@+-]+ (got ${JSON.stringify(v)})`,
      );
    }
    words.push(`${k}=${v}`);
  }
  return words.join(" ");
}

type Ctx = "none" | "sq" | "dq";
type Token = { lit: string } | { ph: HostPlaceholder; ctx: Ctx };

const KNOWN = HOST_PLACEHOLDERS.map((p) => `{${p}}`).join(" ");

function parseTemplate(t: string): Token[] {
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
      const name = end === -1 ? "" : t.slice(i + 1, end);
      if (!(HOST_PLACEHOLDERS as readonly string[]).includes(name)) {
        throw new HostTemplateError(
          end === -1 || name === "" || /\s/.test(name)
            ? `stray { in template (write {{ for a literal brace; placeholders: ${KNOWN})`
            : `unknown placeholder {${name}} (known: ${KNOWN})`,
        );
      }
      if (ctx === "dq" && subst) {
        throw new HostTemplateError(`{${name}} inside $(...) or backticks in double quotes`);
      }
      flush();
      out.push({ ph: name as HostPlaceholder, ctx });
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

/** Throws HostTemplateError unless `template` is well-formed. */
export function validateHostTemplate(template: string): void {
  parseTemplate(template);
}

/**
 * Expand `template` in one pass. Every value is quoted for its context and
 * stays one word; {env} is whitelisted assignment words. A placeholder with
 * no value in this context is an error, never blanked.
 */
export function expandHostTemplate(template: string, values: HostTemplateValues): string {
  let out = "";
  for (const tok of parseTemplate(template)) {
    if ("lit" in tok) {
      out += tok.lit;
      continue;
    }
    const v = values[tok.ph];
    if (v === undefined) throw new HostTemplateError(`{${tok.ph}} has no value in this template`);
    if (v.includes("\0")) throw new HostTemplateError(`{${tok.ph}} value contains a NUL byte`);
    if (tok.ph === "env") {
      if (!ENV_WORDS_RE.test(v)) {
        throw new HostTemplateError(
          `{env} must be KEY=VALUE words of ${HOST_ENV_KEYS.join(", ")} (build it with hostEnvWords)`,
        );
      }
      out += v;
      continue;
    }
    const word = shellQuote(v);
    if (tok.ctx === "sq") out += word.replace(/'/g, `'\\''`);
    else if (tok.ctx === "dq") out += word.replace(/[\\"$`]/g, "\\$&");
    else out += word;
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
function pidStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** True only when the holder is certainly gone: ESRCH, or the pid now has another start time. */
function pidProvenGone(pid: number, start: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  if (start === null) return false;
  const now = pidStart(pid);
  return now !== null && now !== start;
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

/** Delete proven-dead rows: transient by pid; attached only those observed dead (token + id + pane CAS). */
function reclaim(db: Db, host: string, deadPanes: readonly HostChannel[]): void {
  const del = db.prepare(
    "DELETE FROM host_channels WHERE host = ? AND holder = ? AND token = ? AND agent_id IS ? AND pane_id IS ?",
  );
  for (const c of listHostChannels(db, host)) {
    const gone =
      c.kind === "transient"
        ? c.pid !== null && pidProvenGone(c.pid, c.pid_start)
        : deadPanes.some((d) => d.holder === c.holder && d.token === c.token);
    if (gone) del.run(host, c.holder, c.token, c.agent_id, c.pane_id);
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
  const profile = getHost(db, host);
  const dead = await probeAttached(db, host, opts.paneAlive);
  const token = randomUUID();
  db.transaction(() => {
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
  }).immediate();
  return { host, holder, token };
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
        `UPDATE host_channels SET kind = 'attached', pid = NULL, pid_start = NULL, agent_id = ?, pane_id = ?
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

/** Hold a transient channel for the duration of `run`; released in `finally` by token. */
export async function withHostChannel<T>(
  db: Db,
  host: string,
  holder: string,
  run: () => Promise<T>,
  opts: ChannelOpts = {},
): Promise<T> {
  const lease = await reserveHostChannel(db, host, holder, opts);
  try {
    return await run();
  } finally {
    releaseHostChannel(db, lease);
  }
}

// ─── Running templates ──────────────────────────────────────────────────

/** Per-command budget for exec and check. */
export const HOST_COMMAND_TIMEOUT_MS = 20_000;

export interface HostRun {
  /** null: killed by the timeout or a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Expand `field` of `profile` and run it with /bin/sh -c. No retry, no fallback. */
async function runTemplate(
  profile: HostProfile,
  field: "exec" | "fetch",
  values: HostTemplateValues,
  timeoutMs: number,
): Promise<HostRun> {
  const expanded = expandHostTemplate(profile[field], values);
  return execFileCapture("/bin/sh", ["-c", expanded], { timeoutMs });
}

/** Run the profile's `exec` or `fetch` template under one transient channel. */
export async function runHostTemplate(
  db: Db,
  host: string,
  field: "exec" | "fetch",
  holder: string,
  values: HostTemplateValues,
  opts: ChannelOpts & { timeoutMs?: number } = {},
): Promise<HostRun> {
  const profile = getHost(db, host);
  const timeoutMs = opts.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS;
  return withHostChannel(
    db,
    host,
    holder,
    () => runTemplate(profile, field, values, timeoutMs),
    opts,
  );
}

// ─── Check ──────────────────────────────────────────────────────────────

export interface HostCheckStep {
  step: "reachable" | "repo" | "pi" | "extension" | "ctl";
  /** null: skipped because the host was not reachable. */
  ok: boolean | null;
  detail: string;
}

export interface HostCheckReport {
  host: string;
  ok: boolean;
  steps: HostCheckStep[];
}

export interface HostCheckOptions extends ChannelOpts {
  timeoutMs?: number;
  /** Also probe this agent's derived local control socket: the forward rides its pane. */
  agent?: { name: string; workstream: string };
}

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

/**
 * Check a host through its own stored templates, under ONE channel: the
 * host answers `exec`, the repo is a git repo, pi runs under the login
 * shell, `pi list` names mu, and with `agent` the forwarded socket answers
 * hello. Each failure is reported; none is retried; an unreachable host
 * skips the rest. The ctl probe only reads an existing forward.
 */
export async function checkHost(
  db: Db,
  host: string,
  opts: HostCheckOptions = {},
): Promise<HostCheckReport> {
  const profile = getHost(db, host);
  const timeoutMs = opts.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS;
  const steps: HostCheckStep[] = [];

  // One remote command through `exec`; `good` turns a clean exit into a detail, or undefined.
  const step = async (
    name: HostCheckStep["step"],
    cmd: string,
    good: (r: HostRun) => string | undefined,
    unmet: string,
  ): Promise<boolean> => {
    let detail: string;
    let ok = false;
    try {
      const r = await runTemplate(profile, "exec", { cmd, cwd: profile.repo }, timeoutMs);
      const why = firstLine(r.stderr) || firstLine(r.stdout);
      const good1 = r.exitCode === 0 ? good(r) : undefined;
      ok = good1 !== undefined;
      detail =
        good1 ??
        (r.exitCode === null
          ? `timed out after ${timeoutMs}ms`
          : r.exitCode === 0
            ? unmet
            : `exit ${r.exitCode}${why === "" ? "" : `: ${why}`}`);
    } catch (e) {
      if (!(e instanceof HostTemplateError)) throw e;
      detail = e.message;
    }
    steps.push({ step: name, ok, detail });
    return ok;
  };
  const login = (cmd: string): string => `"\${SHELL:-sh}" -ilc ${shellQuote(cmd)}`;

  await withHostChannel(
    db,
    host,
    `check:${process.pid}`,
    async () => {
      if (await step("reachable", "true", () => "exec answered", "")) {
        await step(
          "repo",
          `git -C ${remotePathWord(profile.repo)} rev-parse --git-dir`,
          () => profile.repo,
          "",
        );
        await step(
          "pi",
          login("pi --version"),
          (r) => lastLine(r.stdout) || undefined,
          "pi printed no version",
        );
        await step(
          "extension",
          login("pi list"),
          (r) =>
            r.stdout
              .split("\n")
              .find((l) => /\bmu\b/.test(l))
              ?.trim(),
          "pi list does not name mu",
        );
      } else {
        for (const s of ["repo", "pi", "extension"] as const) {
          steps.push({ step: s, ok: null, detail: "skipped: host not reachable" });
        }
      }
      if (opts.agent !== undefined) {
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
  return { host, ok: steps.every((s) => s.ok === true), steps };
}
