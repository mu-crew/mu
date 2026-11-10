// The published schema and mu's narrowers agree (plugins spec D13 Schema
// publication): one set of fixture messages, valid and invalid, run through
// both. The handshake's `schema` digest is the sha256 of the file's exact bytes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Narrowed,
  narrowCheckSteps,
  narrowInitializeResult,
  narrowLinkRun,
  PLUGIN_SCHEMA_DIGEST,
  PLUGIN_SCHEMA_FILE,
  type PluginMethod,
  parseMessage,
  replyNarrower,
} from "../src/plugins/protocol.js";
import { ROOT } from "./_imports.js";
import { validates } from "./_json-schema.js";

const bytes = readFileSync(join(ROOT, PLUGIN_SCHEMA_FILE));
const schema = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;

const LINK = {
  fetch: false,
  slots: "self",
  remoteOnTimeout: "unknown",
  quiescence: "provable",
  maxScriptBytes: 131072,
  checks: ["reach"],
};
const CHANNEL = {
  fence: "none",
  receipt: "exact",
  dedupe: { send: { exact: true, windowMs: 86_400_000 } },
  steer: "none",
  interrupt: "exact",
  fresh: "none",
  answer: false,
  command: false,
  watch: "stream",
  settleText: "tied",
};
const INIT = {
  protocol: 1,
  plugin: { name: "mule", version: "0.5.0" },
  instance: "9f2c",
  schema: PLUGIN_SCHEMA_DIGEST,
  seams: {
    link: LINK,
    job: {
      kind: "lease",
      view: "bound",
      handle: "file",
      start: { lookup: true, fenceKey: false },
      checks: ["template", "agent"],
    },
  },
};
const ERR = (data: unknown) => ({
  jsonrpc: "2.0",
  id: 3,
  error: { code: -32000, message: "no", data },
});

/** [name, def, narrower, value, valid] */
type Fixture = [string, string, (x: unknown) => Narrowed<unknown>, unknown, boolean];
const msg = (x: unknown): Narrowed<unknown> => parseMessage(JSON.stringify(x));

const FIXTURES: Fixture[] = [
  ["a result", "fromPlugin", msg, { jsonrpc: "2.0", id: 1, result: { ok: 1 } }, true],
  ["a null result", "fromPlugin", msg, { jsonrpc: "2.0", id: 1, result: null }, true],
  ["a reply with no result", "fromPlugin", msg, { jsonrpc: "2.0", id: 1 }, false],
  ["a reply with id 0", "fromPlugin", msg, { jsonrpc: "2.0", id: 0, result: 1 }, false],
  ["a string id", "fromPlugin", msg, { jsonrpc: "2.0", id: "1", result: 1 }, false],
  ["jsonrpc 1.0", "fromPlugin", msg, { jsonrpc: "1.0", id: 1, result: 1 }, false],
  ["result and error", "fromPlugin", msg, { ...ERR({ kind: "permanent" }), result: 1 }, false],
  ["an extra field", "fromPlugin", msg, { jsonrpc: "2.0", id: 1, result: 1, x: 1 }, false],
  ["a retryable error", "fromPlugin", msg, ERR({ kind: "retryable" }), true],
  [
    "a human error with a remedy",
    "fromPlugin",
    msg,
    ERR({ kind: "human", remedy: "touch the key" }),
    true,
  ],
  ["an unknown-outcome error", "fromPlugin", msg, ERR({ kind: "unknown-outcome" }), true],
  ["an error with a null id", "fromPlugin", msg, { ...ERR({ kind: "permanent" }), id: null }, true],
  [
    "an error with no data",
    "fromPlugin",
    msg,
    { jsonrpc: "2.0", id: 3, error: { code: 1, message: "x" } },
    false,
  ],
  ["an error of no kind", "fromPlugin", msg, ERR({ kind: "fatal" }), false],
  ["an error with an empty remedy", "fromPlugin", msg, ERR({ kind: "human", remedy: "" }), false],
  ["an error with extra data", "fromPlugin", msg, ERR({ kind: "permanent", why: 1 }), false],
  [
    "a non-integer code",
    "fromPlugin",
    msg,
    { jsonrpc: "2.0", id: 3, error: { code: 1.5, message: "x", data: { kind: "permanent" } } },
    false,
  ],
  [
    "a settled watch",
    "fromPlugin",
    msg,
    { jsonrpc: "2.0", method: "watch/settled", params: { watchId: "w" } },
    true,
  ],
  [
    "a restarted watch",
    "fromPlugin",
    msg,
    { jsonrpc: "2.0", method: "watch/restarted", params: { watchId: "w" } },
    true,
  ],
  [
    "a request to mu",
    "fromPlugin",
    msg,
    { jsonrpc: "2.0", id: 9, method: "watch/settled", params: {} },
    false,
  ],
  [
    "an unknown notification",
    "fromPlugin",
    msg,
    { jsonrpc: "2.0", method: "db/write", params: {} },
    false,
  ],
  [
    "a notification without params",
    "fromPlugin",
    msg,
    { jsonrpc: "2.0", method: "watch/settled" },
    false,
  ],
  ["the spec's handshake", "initializeResult", narrowInitializeResult, INIT, true],
  [
    "a link that stops within the grace after a timeout",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, seams: { link: { ...LINK, remoteOnTimeout: "stopping" } } },
    true,
  ],
  [
    "a handshake with every seam",
    "initializeResult",
    narrowInitializeResult,
    {
      ...INIT,
      seams: {
        host: {
          acquire: {
            lookup: true,
            dedupe: { exact: true, windowMs: 60_000 },
            fenceKey: true,
            inFlightMs: 0,
          },
        },
        link: LINK,
        job: {
          kind: "cloud",
          view: "detached",
          handle: "reply",
          start: { lookup: true, fenceKey: true },
          channel: "cloud",
        },
        channel: { name: "cloud", caps: CHANNEL },
      },
    },
    true,
  ],
  [
    "a handshake without an instance",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, instance: undefined },
    false,
  ],
  [
    "an empty instance",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, instance: "" },
    false,
  ],
  [
    "an instance over 128 characters",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, instance: "i".repeat(129) },
    false,
  ],
  [
    "a negative protocol",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, protocol: -1 },
    false,
  ],
  [
    "an unknown seam",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, seams: { mux: {} } },
    false,
  ],
  [
    "a link without maxScriptBytes",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, seams: { link: { ...LINK, maxScriptBytes: undefined } } },
    false,
  ],
  [
    "a link with maxScriptBytes 0",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, seams: { link: { ...LINK, maxScriptBytes: 0 } } },
    false,
  ],
  [
    "a link with an unknown slots",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, seams: { link: { ...LINK, slots: "both" } } },
    false,
  ],
  [
    "a link with an unknown check phase",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, seams: { link: { ...LINK, checks: ["doctor"] } } },
    false,
  ],
  [
    "a dedupe that is not exact",
    "initializeResult",
    narrowInitializeResult,
    {
      ...INIT,
      seams: {
        host: {
          acquire: { lookup: false, fenceKey: false, dedupe: { exact: false, windowMs: 1 } },
        },
      },
    },
    false,
  ],
  [
    "a channel with a caps typo",
    "initializeResult",
    narrowInitializeResult,
    { ...INIT, seams: { channel: { name: "c", caps: { ...CHANNEL, stream: true } } } },
    false,
  ],
  [
    "a channel dedupe for no method",
    "initializeResult",
    narrowInitializeResult,
    {
      ...INIT,
      seams: {
        channel: {
          name: "c",
          caps: { ...CHANNEL, dedupe: { steer: { exact: true, windowMs: 1 } } },
        },
      },
    },
    false,
  ],
  [
    "a run",
    "linkRun",
    narrowLinkRun,
    { exitCode: 0, stdout: "x", stderr: "", partial: false },
    true,
  ],
  [
    "a timed-out run",
    "linkRun",
    narrowLinkRun,
    { exitCode: null, stdout: "", stderr: "", partial: true },
    true,
  ],
  [
    "a run with a negative exit",
    "linkRun",
    narrowLinkRun,
    { exitCode: -1, stdout: "", stderr: "", partial: false },
    false,
  ],
  [
    "a run without partial",
    "linkRun",
    narrowLinkRun,
    { exitCode: 0, stdout: "", stderr: "" },
    false,
  ],
  [
    "steps",
    "checkSteps",
    narrowCheckSteps,
    [
      { step: "reachable", ok: true, detail: "ok" },
      { step: "repo", ok: null, detail: "skipped" },
    ],
    true,
  ],
  [
    "a step at the warn level",
    "checkSteps",
    narrowCheckSteps,
    [{ step: "git", ok: "warn", detail: "no identity" }],
    true,
  ],
  [
    "a step with an empty name",
    "checkSteps",
    narrowCheckSteps,
    [{ step: "", ok: true, detail: "" }],
    false,
  ],
  [
    "a step with a string ok",
    "checkSteps",
    narrowCheckSteps,
    [{ step: "s", ok: "yes", detail: "" }],
    false,
  ],
  // The channel seam's replies (P6e), through the request-bound narrower.
  ...channelFixtures(),
];

/** The channel replies: one narrower per method, bound to a request naming msgId `m1` and agent ws/a. */
function channelFixtures(): Fixture[] {
  const seams = { channel: { name: "cloud", caps: CHANNEL } } as never;
  const params = { targets: [{ agent: { workstream: "ws", name: "a" } }], msgId: "m1" };
  const reply = (m: PluginMethod) => (x: unknown) => replyNarrower(m, params, seams)(x);
  const turn = { since: null, runs: 2, incarnation: "i1" };
  const obs = { status: "idle", settled: true, ...turn, lastText: "done" };
  return [
    [
      "a reading",
      "readStates",
      reply("channel.readStates"),
      { "ws/a": { state: "busy", ...turn } },
      true,
    ],
    [
      "a reading without runs",
      "reading",
      reply("channel.readStates"),
      { "ws/a": { state: "busy", since: null, incarnation: "i" } },
      false,
    ],
    [
      "a reading of a dead agent",
      "reading",
      reply("channel.readStates"),
      { "ws/a": { state: "dead", ...turn } },
      false,
    ],
    ["an observation", "observation", reply("channel.lastRun"), obs, true],
    [
      "an observation with alive",
      "observation",
      reply("channel.lastRun"),
      { ...obs, alive: false },
      false,
    ],
    ["no last run", "lastRun", reply("channel.lastRun"), null, true],
    ["a baseline", "channelBaseline", reply("channel.baseline"), { runs: 0 }, true],
    [
      "a watch",
      "watchResult",
      reply("channel.watch"),
      { watchId: "w1", initial: obs, afterRuns: 1 },
      true,
    ],
    ["a watch without its id", "watchResult", reply("channel.watch"), { initial: obs }, false],
    [
      "a send reply",
      "sendReply",
      reply("channel.send"),
      { channel: "cloud", ack: "exact", baseline: { runs: 1 }, msgId: "m1" },
      true,
    ],
    [
      "a send reply with another ack",
      "sendReply",
      reply("channel.send"),
      { channel: "cloud", ack: "confirmed" },
      false,
    ],
    [
      "an interrupt",
      "interruptResult",
      reply("channel.interrupt"),
      { wasBusy: true, pending: false, runs: 2 },
      true,
    ],
    [
      "an abort",
      "abortOutcome",
      reply("channel.abort"),
      { before: "busy", after: "idle", settled: true, aborted: true, pending: false },
      true,
    ],
    [
      "an abort without settled",
      "abortOutcome",
      reply("channel.abort"),
      { before: "busy", after: "idle", aborted: true, pending: false },
      false,
    ],
    ["an answer", "answerResult", reply("channel.answer"), { keys: ["1"], ack: "unknown" }, true],
  ];
}

describe("schemas/plugin-protocol-v1.json", () => {
  it("the handshake's digest is the sha256 of the file's exact bytes", () => {
    expect(PLUGIN_SCHEMA_DIGEST).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  });

  it("ships in the package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("schemas");
  });

  it.each(FIXTURES)("%s: narrower and schema agree", (_name, def, narrow, value, valid) => {
    const plain = JSON.parse(JSON.stringify(value)) as unknown; // undefined fields dropped, as on the wire
    expect(validates(schema, def, plain)).toBe(valid);
    expect(narrow(plain).ok).toBe(valid);
  });

  it("every message mu writes is valid under fromMu and its params' definition", () => {
    const init = { protocol: { min: 1, max: 1 }, mu: "5" };
    const exec = {
      target: { host: { name: "dev" } },
      script: "true",
      cwd: ".",
      timeoutMs: 20000,
      deadline: Date.now(),
    };
    const fetch = {
      target: { host: { name: "dev" } },
      remoteCwd: "/r",
      localRepo: "/l",
      timeoutMs: 1,
      deadline: 0,
    };
    const check = { target: { host: { name: "dev" } }, phase: "reach", root: "/r", deadline: 0 };
    expect(validates(schema, "initializeParams", init)).toBe(true);
    expect(validates(schema, "linkExecParams", exec)).toBe(true);
    expect(validates(schema, "linkFetchParams", fetch)).toBe(true);
    expect(validates(schema, "linkCheckStepsParams", check)).toBe(true);
    for (const m of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: init },
      { jsonrpc: "2.0", id: 2, method: "link.exec", params: exec },
      { jsonrpc: "2.0", id: 3, method: "shutdown", params: null },
      { jsonrpc: "2.0", method: "$/cancel", params: { id: 2 } },
    ]) {
      expect(validates(schema, "fromMu", m)).toBe(true);
    }
    expect(validates(schema, "linkExecParams", { ...exec, key: "k" })).toBe(false);
  });
});
