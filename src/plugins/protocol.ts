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

import type { CheckPhase, LinkCaps } from "../host-link.js";
import type { KeyCaps } from "../host-provider.js";

/** The protocol versions this build speaks. */
export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;

/** One message, its newline excluded. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** The published schema, relative to the package root. Ships in the package. */
export const PLUGIN_SCHEMA_FILE = "schemas/plugin-protocol-v1.json";

/** sha256 of the exact bytes of PLUGIN_SCHEMA_FILE (pinned by test/plugin-schema.test.ts). */
export const PLUGIN_SCHEMA_DIGEST =
  "sha256:5fdb995f02c8dec531e06e13effe0ceb23356572b1296fccb62c0c25e05d5be4";

/** Error text mu keeps from a plugin: the first line, at most this many characters (D14). */
export const ERROR_TEXT_MAX = 400;

export const PLUGIN_ERROR_KINDS = ["retryable", "permanent", "human", "unknown-outcome"] as const;
export type PluginErrorKind = (typeof PLUGIN_ERROR_KINDS)[number];

export const SEAM_NAMES = ["host", "link", "job", "channel"] as const;

/** The notifications a plugin may send: each ends a watch (D13 Streaming watch). */
export const NOTIFICATION_METHODS = ["watch/settled", "watch/restarted"] as const;
export type SeamName = (typeof SEAM_NAMES)[number];

const CHECK_PHASES: readonly CheckPhase[] = ["template", "reach", "agent"];

/** A plugin's job seam as declared (spec D8, D13). */
export interface PluginJobCaps {
  kind: string;
  view: "bound" | "detached";
  handle: "pane" | "file" | "reply";
  start: KeyCaps;
  /** The channel the kind's agents take: the channel seam's name. */
  channel?: string;
  checks?: CheckPhase[];
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
    "slots",
    "remoteOnTimeout",
    "quiescence",
    "maxScriptBytes",
    "checks",
  ]);
  return {
    fetch: bool(l.fetch, `${path}.fetch`),
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

function jobCaps(x: unknown, path: string): PluginJobCaps {
  const j = obj(x, path, ["kind", "view", "handle", "start", "channel", "checks"]);
  return {
    kind: str(j.kind, `${path}.kind`, 64),
    view: oneOf(j.view, `${path}.view`, ["bound", "detached"] as const),
    handle: oneOf(j.handle, `${path}.handle`, ["pane", "file", "reply"] as const),
    start: keyCaps(j.start, `${path}.start`),
    ...(j.channel !== undefined ? { channel: str(j.channel, `${path}.channel`, 64) } : {}),
    ...(j.checks !== undefined ? { checks: phases(j.checks, `${path}.checks`) } : {}),
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
