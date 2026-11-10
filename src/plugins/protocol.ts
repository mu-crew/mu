// mu — the plugin protocol's wire layer (spec 2026-11-09-mu-plugins.md, D13):
// framing, the message narrowers, the handshake's shape and the load rules.
//
// JSON-RPC 2.0, one JSON object per line on the plugin's stdin and stdout,
// UTF-8, at most 1 MiB per message. Hand-rolled like src/ctl/protocol.ts: no
// dependency. Every narrower here accepts exactly what
// `schemas/plugin-protocol-v1.json` accepts for the same message
// (test/plugin-schema.test.ts runs both over one set of fixtures), and the
// handshake's `schema` is the sha256 of that file's exact bytes.
//
// A plugin only answers. A message that is not a reply to a pending request or
// a known notification (a request to mu included: there is no RPC into mu) is
// invalid, and an invalid message breaks the plugin for the invocation.

import type { MessageCheck } from "../channels/types.js";
import type { CheckPhase, LinkCaps } from "../host-link.js";
import type { HostFacts, KeyCaps, KeyLookup } from "../host-provider.js";
import type {
  JobCaps,
  JobHonours,
  JobLiveness,
  JobRole,
  JobStart,
  PaneCommand,
} from "../jobs/types.js";

/** The protocol versions this build speaks. */
export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;

/** One message, its newline excluded. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** The published schema, relative to the package root. Ships in the package. */
export const PLUGIN_SCHEMA_FILE = "schemas/plugin-protocol-v1.json";

/** sha256 of the exact bytes of PLUGIN_SCHEMA_FILE (pinned by test/plugin-schema.test.ts). */
export const PLUGIN_SCHEMA_DIGEST =
  "sha256:7c13b0bb67db6a7cbbae0d147b05d1845be3b5749278dae04e36dfb88d9b34f3";

/** Error text mu keeps from a plugin: the first line, at most this many characters (D14). */
export const ERROR_TEXT_MAX = 400;

export const PLUGIN_ERROR_KINDS = ["retryable", "permanent", "human", "unknown-outcome"] as const;
export type PluginErrorKind = (typeof PLUGIN_ERROR_KINDS)[number];

export const SEAM_NAMES = ["host", "link", "job", "channel"] as const;

/** The notifications a plugin may send: each ends a watch (D13 Streaming watch). */
export const NOTIFICATION_METHODS = ["watch/settled", "watch/restarted"] as const;
export type SeamName = (typeof SEAM_NAMES)[number];

const CHECK_PHASES: readonly CheckPhase[] = ["template", "reach", "agent"];

/** A plugin's job seam as declared (spec D8, D13): its kind's name and capabilities. */
export interface PluginJobCaps extends JobCaps {
  kind: string;
  start: KeyCaps;
}

type Dedupe = { exact: true; windowMs: number };

/** A plugin's channel capabilities (spec D9, D12): `ChannelCaps` as the wire carries it. */
export interface PluginChannelCaps {
  fence: "sync" | "none";
  receipt: "exact" | "acknowledged" | "none";
  dedupe?: Partial<Record<"send" | "fresh" | "interrupt" | "answer" | "command", Dedupe>>;
  steer: "mid-turn" | "as-send" | "none";
  interrupt: "exact" | "unconfirmed" | "none";
  fresh: "in-place" | "new-job" | "none";
  answer: boolean;
  command: boolean;
  watch: "stream" | "poll";
  settleText: "tied" | "untied" | "none";
}

/** The seams a plugin declares at the handshake, each with its capabilities. */
export interface PluginSeams {
  host?: { acquire: KeyCaps };
  /** A plugin link always names its largest script. */
  link?: LinkCaps & { maxScriptBytes: number };
  job?: PluginJobCaps;
  channel?: { name: string; caps: PluginChannelCaps };
}

/** The handshake's reply. */
export interface InitializeResult {
  protocol: number;
  plugin: { name: string; version: string };
  instance: string;
  schema: string;
  seams: PluginSeams;
}

/** One message from a plugin. */
export type PluginMessage =
  | { type: "result"; id: number; result: unknown }
  | {
      type: "error";
      id: number | null;
      error: { code: number; message: string; kind: PluginErrorKind; remedy?: string };
    }
  | { type: "notification"; method: string; params: unknown };

export type Narrowed<T> = { ok: true; value: T } | { ok: false; reason: string };

// ─── Framing ────────────────────────────────────────────────────────────

/** One message as a line. A message over MAX_MESSAGE_BYTES is a bug in mu: it throws. */
export function encodeMessage(msg: Record<string, unknown>): string {
  const line = JSON.stringify(msg);
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
    throw new Error(`plugin message over ${MAX_MESSAGE_BYTES} bytes`);
  }
  return `${line}\n`;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Splits a byte stream into lines. `invalid` is set, and no further line read, once a line
 * passes MAX_MESSAGE_BYTES or is not valid UTF-8: an invalid frame, never a repaired one.
 */
export class LineReader {
  private parts: Buffer[] = [];
  private size = 0;
  invalid: string | undefined;

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    if (this.invalid !== undefined) return lines;
    let at = 0;
    for (let nl = chunk.indexOf(10, at); nl !== -1; nl = chunk.indexOf(10, at)) {
      this.add(chunk.subarray(at, nl));
      if (this.invalid !== undefined) return lines;
      try {
        lines.push(UTF8.decode(Buffer.concat(this.parts)));
      } catch {
        this.invalid = "not UTF-8";
        return lines;
      }
      this.parts = [];
      this.size = 0;
      at = nl + 1;
    }
    this.add(chunk.subarray(at));
    return lines;
  }

  private add(b: Buffer): void {
    this.size += b.length;
    if (this.size > MAX_MESSAGE_BYTES) this.invalid = "a message over 1 MiB";
    else if (b.length > 0) this.parts.push(Buffer.from(b));
  }
}

/** The first line of `text`, trimmed and cut to ERROR_TEXT_MAX characters. */
export function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return line.length > ERROR_TEXT_MAX ? `${line.slice(0, ERROR_TEXT_MAX - 1)}…` : line;
}

// ─── Narrowing ──────────────────────────────────────────────────────────

class Invalid extends Error {}

type Obj = Record<string, unknown>;

function fail(path: string, want: string): never {
  throw new Invalid(`${path}: expected ${want}`);
}

function obj(x: unknown, path: string, keys: readonly string[]): Obj {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail(path, "an object");
  for (const k of Object.keys(x)) if (!keys.includes(k)) fail(`${path}.${k}`, "no such field");
  return x as Obj;
}

function str(x: unknown, path: string, max = 256): string {
  if (typeof x !== "string" || x.length === 0 || x.length > max) {
    fail(path, `a string of 1-${max} characters`);
  }
  return x;
}

function bool(x: unknown, path: string): boolean {
  if (typeof x !== "boolean") fail(path, "a boolean");
  return x;
}

function int(x: unknown, path: string, min: number): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < min) fail(path, `an integer >= ${min}`);
  return x;
}

function oneOf<T extends string>(x: unknown, path: string, values: readonly T[]): T {
  if (typeof x !== "string" || !(values as readonly string[]).includes(x)) {
    fail(path, values.map((v) => JSON.stringify(v)).join(" | "));
  }
  return x as T;
}

function phases(x: unknown, path: string): CheckPhase[] {
  if (!Array.isArray(x)) fail(path, "an array of check phases");
  return x.map((p, i) => oneOf(p, `${path}[${i}]`, CHECK_PHASES));
}

function dedupe(x: unknown, path: string): Dedupe {
  const d = obj(x, path, ["exact", "windowMs"]);
  if (d.exact !== true) fail(`${path}.exact`, "true");
  return { exact: true, windowMs: int(d.windowMs, `${path}.windowMs`, 1) };
}

function keyCaps(x: unknown, path: string): KeyCaps {
  const k = obj(x, path, ["lookup", "dedupe", "fenceKey", "inFlightMs"]);
  return {
    lookup: bool(k.lookup, `${path}.lookup`),
    fenceKey: bool(k.fenceKey, `${path}.fenceKey`),
    ...(k.dedupe !== undefined ? { dedupe: dedupe(k.dedupe, `${path}.dedupe`) } : {}),
    ...(k.inFlightMs !== undefined
      ? { inFlightMs: int(k.inFlightMs, `${path}.inFlightMs`, 0) }
      : {}),
  };
}

function linkCaps(x: unknown, path: string): NonNullable<PluginSeams["link"]> {
  const l = obj(x, path, [
    "fetch",
    "push",
    "slots",
    "remoteOnTimeout",
    "quiescence",
    "maxScriptBytes",
    "checks",
  ]);
  return {
    fetch: bool(l.fetch, `${path}.fetch`),
    ...(l.push !== undefined ? { push: bool(l.push, `${path}.push`) } : {}),
    slots: oneOf(l.slots, `${path}.slots`, ["mu", "self"] as const),
    remoteOnTimeout: oneOf(l.remoteOnTimeout, `${path}.remoteOnTimeout`, [
      "stopped",
      "unknown",
    ] as const),
    quiescence: oneOf(l.quiescence, `${path}.quiescence`, ["provable", "unprovable"] as const),
    maxScriptBytes: int(l.maxScriptBytes, `${path}.maxScriptBytes`, 1),
    ...(l.checks !== undefined ? { checks: phases(l.checks, `${path}.checks`) } : {}),
  };
}

const ROLES: readonly JobRole[] = ["full-access", "read-only"];

function honours(x: unknown, path: string): JobHonours {
  const h = obj(x, path, ["command", "env", "sockets", "roles"]);
  if (!Array.isArray(h.roles)) fail(`${path}.roles`, "an array of roles");
  const roles = h.roles.map((r, i) => oneOf(r, `${path}.roles[${i}]`, ROLES));
  if (new Set(roles).size !== roles.length) fail(`${path}.roles`, "each role once");
  return {
    command: bool(h.command, `${path}.command`),
    env: bool(h.env, `${path}.env`),
    sockets: bool(h.sockets, `${path}.sockets`),
    roles,
  };
}

function jobCaps(x: unknown, path: string): PluginJobCaps {
  const j = obj(x, path, [
    "kind",
    "view",
    "handle",
    "start",
    "channel",
    "checks",
    "firstTurn",
    "outlivesHost",
    "honours",
  ]);
  return {
    kind: str(j.kind, `${path}.kind`, 64),
    view: oneOf(j.view, `${path}.view`, ["bound", "detached"] as const),
    handle: oneOf(j.handle, `${path}.handle`, ["pane", "file", "reply"] as const),
    start: keyCaps(j.start, `${path}.start`),
    ...(j.channel !== undefined ? { channel: str(j.channel, `${path}.channel`, 64) } : {}),
    ...(j.checks !== undefined ? { checks: phases(j.checks, `${path}.checks`) } : {}),
    ...(j.firstTurn !== undefined
      ? { firstTurn: oneOf(j.firstTurn, `${path}.firstTurn`, ["on-send", "at-start"] as const) }
      : {}),
    ...(j.outlivesHost !== undefined
      ? { outlivesHost: bool(j.outlivesHost, `${path}.outlivesHost`) }
      : {}),
    ...(j.honours !== undefined ? { honours: honours(j.honours, `${path}.honours`) } : {}),
  };
}

const DELIVERY_METHODS = ["send", "fresh", "interrupt", "answer", "command"] as const;

function channelCaps(x: unknown, path: string): PluginChannelCaps {
  const c = obj(x, path, [
    "fence",
    "receipt",
    "dedupe",
    "steer",
    "interrupt",
    "fresh",
    "answer",
    "command",
    "watch",
    "settleText",
  ]);
  let dd: PluginChannelCaps["dedupe"];
  if (c.dedupe !== undefined) {
    const d = obj(c.dedupe, `${path}.dedupe`, DELIVERY_METHODS);
    dd = {};
    for (const m of DELIVERY_METHODS) {
      if (d[m] !== undefined) dd[m] = dedupe(d[m], `${path}.dedupe.${m}`);
    }
  }
  return {
    fence: oneOf(c.fence, `${path}.fence`, ["sync", "none"] as const),
    receipt: oneOf(c.receipt, `${path}.receipt`, ["exact", "acknowledged", "none"] as const),
    ...(dd !== undefined ? { dedupe: dd } : {}),
    steer: oneOf(c.steer, `${path}.steer`, ["mid-turn", "as-send", "none"] as const),
    interrupt: oneOf(c.interrupt, `${path}.interrupt`, ["exact", "unconfirmed", "none"] as const),
    fresh: oneOf(c.fresh, `${path}.fresh`, ["in-place", "new-job", "none"] as const),
    answer: bool(c.answer, `${path}.answer`),
    command: bool(c.command, `${path}.command`),
    watch: oneOf(c.watch, `${path}.watch`, ["stream", "poll"] as const),
    settleText: oneOf(c.settleText, `${path}.settleText`, ["tied", "untied", "none"] as const),
  };
}

function seams(x: unknown, path: string): PluginSeams {
  const s = obj(x, path, SEAM_NAMES);
  const out: PluginSeams = {};
  if (s.host !== undefined) {
    const h = obj(s.host, `${path}.host`, ["acquire"]);
    out.host = { acquire: keyCaps(h.acquire, `${path}.host.acquire`) };
  }
  if (s.link !== undefined) out.link = linkCaps(s.link, `${path}.link`);
  if (s.job !== undefined) out.job = jobCaps(s.job, `${path}.job`);
  if (s.channel !== undefined) {
    const c = obj(s.channel, `${path}.channel`, ["name", "caps"]);
    out.channel = {
      name: str(c.name, `${path}.channel.name`, 64),
      caps: channelCaps(c.caps, `${path}.channel.caps`),
    };
  }
  return out;
}

function narrow<T>(read: () => T): Narrowed<T> {
  try {
    return { ok: true, value: read() };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, reason: e.message };
    throw e;
  }
}

/** The handshake reply's shape (D13). The load rules are `loadRefusals`. */
export function narrowInitializeResult(x: unknown): Narrowed<InitializeResult> {
  return narrow(() => {
    const r = obj(x, "result", ["protocol", "plugin", "instance", "schema", "seams"]);
    const p = obj(r.plugin, "result.plugin", ["name", "version"]);
    return {
      protocol: int(r.protocol, "result.protocol", 0),
      plugin: {
        name: str(p.name, "result.plugin.name", 64),
        version: str(p.version, "result.plugin.version", 64),
      },
      instance: str(r.instance, "result.instance", 128),
      schema: str(r.schema, "result.schema", 128),
      seams: seams(r.seams, "result.seams"),
    };
  });
}

/** The seams object alone (a stored registration's `caps_json`). */
export function narrowSeams(x: unknown): Narrowed<PluginSeams> {
  return narrow(() => seams(x, "seams"));
}

/** One line from a plugin, as a message. Anything else is invalid. */
export function parseMessage(line: string): Narrowed<PluginMessage> {
  let x: unknown;
  try {
    x = JSON.parse(line);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  return narrow((): PluginMessage => {
    const m = obj(x, "message", ["jsonrpc", "id", "result", "error", "method", "params"]);
    if (m.jsonrpc !== "2.0") fail("message.jsonrpc", '"2.0"');
    if (m.method !== undefined) {
      // A request to mu (it has an id) is refused: there is no RPC into mu.
      if (m.id !== undefined) fail("message.id", "no id on a plugin's notification");
      if (m.result !== undefined || m.error !== undefined) fail("message", "a notification");
      const method = oneOf(m.method, "message.method", NOTIFICATION_METHODS);
      if (typeof m.params !== "object" || m.params === null || Array.isArray(m.params)) {
        fail("message.params", "an object");
      }
      return { type: "notification", method, params: m.params };
    }
    if (m.params !== undefined) fail("message.params", "no params on a reply");
    if (m.error !== undefined) {
      if (m.result !== undefined) fail("message", "result or error, not both");
      const id = m.id === null ? null : int(m.id, "message.id", 1);
      const e = obj(m.error, "message.error", ["code", "message", "data"]);
      if (typeof e.code !== "number" || !Number.isInteger(e.code)) {
        fail("message.error.code", "an integer");
      }
      if (typeof e.message !== "string") fail("message.error.message", "a string");
      const d = obj(e.data, "message.error.data", ["kind", "remedy"]);
      const kind = oneOf(d.kind, "message.error.data.kind", PLUGIN_ERROR_KINDS);
      const remedy =
        d.remedy === undefined ? undefined : str(d.remedy, "message.error.data.remedy", 4096);
      return {
        type: "error",
        id,
        error: {
          code: e.code,
          message: e.message,
          kind,
          ...(remedy !== undefined ? { remedy } : {}),
        },
      };
    }
    // A reply always carries `result`; an absent result is `null`.
    if (!("result" in m)) fail("message.result", "a result or an error");
    return { type: "result", id: int(m.id, "message.id", 1), result: m.result };
  });
}

/** A `link.exec` or `link.fetch` result (D7 `LinkRun`). */
export interface WireLinkRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  partial: boolean;
}

export function narrowLinkRun(x: unknown): Narrowed<WireLinkRun> {
  return narrow(() => {
    const r = obj(x, "result", ["exitCode", "stdout", "stderr", "partial"]);
    const exitCode = r.exitCode === null ? null : int(r.exitCode, "result.exitCode", 0);
    if (typeof r.stdout !== "string") fail("result.stdout", "a string");
    if (typeof r.stderr !== "string") fail("result.stderr", "a string");
    return {
      exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      partial: bool(r.partial, "result.partial"),
    };
  });
}

/** A `link.checkSteps` result: the steps, named by the plugin (mu prefixes `<plugin>:`). */
export interface WireCheckStep {
  step: string;
  ok: boolean | null;
  detail: string;
}

export function narrowCheckSteps(x: unknown): Narrowed<WireCheckStep[]> {
  return narrow(() => {
    if (!Array.isArray(x)) fail("result", "an array of steps");
    return x.map((s, i) => {
      const o = obj(s, `result[${i}]`, ["step", "ok", "detail"]);
      if (o.ok !== null && typeof o.ok !== "boolean") fail(`result[${i}].ok`, "a boolean or null");
      if (typeof o.detail !== "string") fail(`result[${i}].detail`, "a string");
      return {
        step: str(o.step, `result[${i}].step`, 64),
        ok: o.ok as boolean | null,
        detail: o.detail,
      };
    });
  });
}

/** A job or host handle: opaque, one line of these bytes (src/hosts.ts JOB_HANDLE_RE). */
export const HANDLE_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

function handle(x: unknown, path: string): string {
  if (typeof x !== "string" || !HANDLE_RE.test(x)) fail(path, "a handle ([A-Za-z0-9._:@-]{1,128})");
  return x;
}

function strings(x: unknown, path: string): Record<string, string> {
  const o = obj(x, path, Object.keys((x as Obj | null) ?? {}));
  for (const [k, v] of Object.entries(o))
    if (typeof v !== "string") fail(`${path}.${k}`, "a string");
  return o as Record<string, string>;
}

function paneCommand(x: unknown, path: string): PaneCommand {
  const v = obj(x, path, ["command", "env", "cwd"]);
  return {
    command: str(v.command, `${path}.command`, 65536),
    env: strings(v.env, `${path}.env`),
    ...(v.cwd !== undefined ? { cwd: str(v.cwd, `${path}.cwd`, 4096) } : {}),
  };
}

function jobStart(x: unknown, path: string): JobStart {
  const r = obj(x, path, ["view", "handle", "baseline"]);
  let baseline: JobStart["baseline"];
  if (r.baseline !== undefined) {
    const b = obj(r.baseline, `${path}.baseline`, ["runs", "incarnation"]);
    baseline = {
      runs: int(b.runs, `${path}.baseline.runs`, 0),
      ...(b.incarnation !== undefined
        ? { incarnation: str(b.incarnation, `${path}.baseline.incarnation`) }
        : {}),
    };
  }
  return {
    view: paneCommand(r.view, `${path}.view`),
    ...(r.handle !== undefined ? { handle: handle(r.handle, `${path}.handle`) } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
  };
}

function hostFacts(x: unknown, path: string): HostFacts {
  const r = obj(x, path, ["handle", "deadlineAt", "idleReclaimMs", "maxJobs"]);
  const opt = (k: string, min: number) =>
    r[k] !== undefined ? { [k]: int(r[k], `${path}.${k}`, min) } : {};
  return {
    handle: handle(r.handle, `${path}.handle`),
    ...opt("deadlineAt", 0),
    ...opt("idleReclaimMs", 0),
    ...opt("maxJobs", 1),
  };
}

/** A `job.start` reply (D8 `JobStart`). */
export const narrowJobStart = (x: unknown): Narrowed<JobStart> =>
  narrow(() => jobStart(x, "result"));

/** A `host.acquire` reply (D6 `HostFacts`). */
export const narrowHostFacts = (x: unknown): Narrowed<HostFacts> =>
  narrow(() => hostFacts(x, "result"));

/** A lookup by key (D4): `found` carries the method's result; a job's always has a handle. */
function keyLookup<T>(
  found: (x: unknown, path: string) => T,
): (x: unknown) => Narrowed<KeyLookup<T>> {
  return (x) =>
    narrow(() => {
      const r = obj(x, "result", ["found", "pending", "none", "unknown"]);
      const keys = Object.keys(r);
      if (keys.length !== 1) fail("result", "exactly one of found, pending, none, unknown");
      if (r.found !== undefined) return { found: found(r.found, "result.found") };
      if (r.pending !== undefined) {
        if (r.pending !== true) fail("result.pending", "true");
        return { pending: true };
      }
      if (r.none !== undefined) {
        if (r.none !== true) fail("result.none", "true");
        return { none: true };
      }
      return { unknown: str(r.unknown, "result.unknown", 4096) };
    });
}

export const narrowJobLookup = keyLookup((x, path) => {
  const s = jobStart(x, path);
  if (s.handle === undefined) fail(`${path}.handle`, "a handle");
  return s as JobStart & { handle: string };
});

export const narrowHostLookup = keyLookup(hostFacts);

/** A `job.status` reply (D1 liveness). */
export function narrowJobLiveness(x: unknown): Narrowed<JobLiveness> {
  return narrow((): JobLiveness => {
    const state = oneOf(obj(x, "result", ["state", "exit", "reason"]).state, "result.state", [
      "running",
      "ended",
      "lost",
      "unknown",
    ] as const);
    if (state === "running") {
      obj(x, "result", ["state"]);
      return { state };
    }
    if (state === "ended") {
      const r = obj(x, "result", ["state", "exit"]);
      if (!("exit" in r)) fail("result.exit", "an exit code or null");
      return { state, exit: r.exit === null ? null : int(r.exit, "result.exit", 0) };
    }
    return {
      state,
      reason: str(obj(x, "result", ["state", "reason"]).reason, "result.reason", 4096),
    };
  });
}

/** A `job.attach` reply: the command a new view runs. */
export const narrowPaneCommand = (x: unknown): Narrowed<PaneCommand> =>
  narrow(() => paneCommand(x, "result"));

/** An idempotent effect's reply (`job.stop`, `host.release`): `null`. */
export function narrowNull(x: unknown): Narrowed<null> {
  return x === null ? { ok: true, value: null } : { ok: false, reason: "result: expected null" };
}

/** A delivery's reply. Its fields are the channel adapter's (P6e); here, an object. */
export function narrowObject(x: unknown): Narrowed<Record<string, unknown>> {
  return narrow(() => obj(x, "result", Object.keys((x as Obj | null) ?? {})));
}

/** A `channel.receipt` reply (D9 `MessageCheck`). */
export function narrowMessageCheck(x: unknown): Narrowed<MessageCheck> {
  return narrow((): MessageCheck => {
    const any = obj(x, "result", ["state", "id", "runs", "at", "incarnation", "reason"]);
    const state = oneOf(any.state, "result.state", [
      "accepted",
      "not-accepted",
      "unreachable",
    ] as const);
    const id = str(any.id, "result.id");
    if (state === "not-accepted") {
      obj(x, "result", ["state", "id"]);
      return { state, id };
    }
    if (state === "unreachable") {
      const r = obj(x, "result", ["state", "id", "reason"]);
      return { state, id, reason: str(r.reason, "result.reason", 4096) };
    }
    const r = obj(x, "result", ["state", "id", "runs", "at", "incarnation"]);
    return {
      state,
      id,
      ...(r.runs !== undefined ? { runs: int(r.runs, "result.runs", 0) } : {}),
      ...(r.at !== undefined ? { at: int(r.at, "result.at", 0) } : {}),
      ...(r.incarnation !== undefined
        ? { incarnation: str(r.incarnation, "result.incarnation") }
        : {}),
    };
  });
}

// ─── Load rules ─────────────────────────────────────────────────────────

/**
 * Why mu refuses a handshake (D13, D4 load-time rules); empty when it loads. `name` is the
 * registered name; `needs`, the seams the registration or the host asks for.
 */
export function loadRefusals(
  r: InitializeResult,
  expect: { name: string; needs?: readonly SeamName[] },
): string[] {
  const out: string[] = [];
  if (r.protocol < PROTOCOL_MIN || r.protocol > PROTOCOL_MAX) {
    out.push(`protocol ${r.protocol} is outside mu's ${PROTOCOL_MIN}..${PROTOCOL_MAX}`);
  }
  if (r.plugin.name !== expect.name) {
    out.push(
      `it names itself ${JSON.stringify(r.plugin.name)}, registered as ${JSON.stringify(expect.name)}`,
    );
  }
  if (r.schema !== PLUGIN_SCHEMA_DIGEST) {
    out.push(
      `its schema digest ${r.schema} is not ${PLUGIN_SCHEMA_FILE}'s (${PLUGIN_SCHEMA_DIGEST})`,
    );
  }
  const s = r.seams;
  for (const need of expect.needs ?? []) {
    if (s[need] === undefined) out.push(`it implements no ${need} seam, which this needs`);
  }
  if (SEAM_NAMES.every((n) => s[n] === undefined)) out.push("it declares no seam");
  if (s.host !== undefined && (s.link === undefined || s.job === undefined)) {
    out.push("a host seam needs the link and job seams for the hosts it provides");
  }
  if (s.host !== undefined && !keyed(s.host.acquire)) {
    out.push("host.acquire declares neither lookup nor exact dedupe");
  }
  if (s.job?.handle === "reply" && !keyed(s.job.start)) {
    out.push('job.start with handle "reply" declares neither lookup nor exact dedupe');
  }
  if (s.job?.firstTurn === "at-start" && s.job.handle !== "reply") {
    out.push('firstTurn "at-start" needs handle "reply"');
  }
  if (s.job?.honours?.env === false && s.job.channel === undefined) {
    out.push("honours.env false needs a channel: a harness's own channel finds its agent by env");
  }
  if (s.channel !== undefined) {
    const c = s.channel.caps;
    if (c.watch !== "stream") out.push('a plugin channel must declare watch "stream"');
    if (c.settleText === "none")
      out.push('a plugin channel must declare a settleText other than "none"');
    if (c.fence !== "none") out.push('a plugin channel has no write fence: fence must be "none"');
  }
  if (s.job?.channel !== undefined && s.job.channel !== s.channel?.name) {
    out.push(`job.channel ${JSON.stringify(s.job.channel)} is not the channel seam's name`);
  }
  return out;
}

function keyed(k: KeyCaps): boolean {
  return k.lookup || k.dedupe !== undefined;
}

/** The seams declared, in SEAM_NAMES order. */
export function declaredSeams(s: PluginSeams): SeamName[] {
  return SEAM_NAMES.filter((n) => s[n] !== undefined);
}
