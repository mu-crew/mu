// The job seam on the wire (plugins spec D8, D13; round 6): the job caps
// `firstTurn`, `outlivesHost` and `honours` and the link cap `push`, in the
// narrowers and the published schema alike, their load rules, and the job
// methods' params and results. test/plugin-schema.test.ts holds P6b's fixtures.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_HANDLE_RE } from "../src/hosts.js";
import {
  HANDLE_RE,
  loadRefusals,
  type Narrowed,
  narrowHostFacts,
  narrowHostLookup,
  narrowInitializeResult,
  narrowJobLiveness,
  narrowJobLookup,
  narrowJobStart,
  narrowMessageCheck,
  narrowNull,
  narrowPaneCommand,
  PLUGIN_SCHEMA_DIGEST,
  PLUGIN_SCHEMA_FILE,
} from "../src/plugins/protocol.js";
import { ROOT } from "./_imports.js";
import { validates } from "./_json-schema.js";

const schema = JSON.parse(readFileSync(join(ROOT, PLUGIN_SCHEMA_FILE), "utf8")) as Record<
  string,
  unknown
>;

const LINK = {
  fetch: false,
  slots: "self",
  remoteOnTimeout: "unknown",
  quiescence: "provable",
  maxScriptBytes: 131072,
};
const JOB = {
  kind: "cloud",
  view: "detached",
  handle: "reply",
  start: { lookup: true, fenceKey: true },
};
const HONOURS = { command: true, env: true, sockets: false, roles: ["full-access"] };
const init = (seams: Record<string, unknown>) => ({
  protocol: 1,
  plugin: { name: "cloud", version: "1" },
  instance: "i",
  schema: PLUGIN_SCHEMA_DIGEST,
  seams,
});
const VIEW = { command: "attach-view", env: { A: "1" } };

type Fixture = [string, string, (x: unknown) => Narrowed<unknown>, unknown, boolean];
const FIXTURES: Fixture[] = [
  [
    "a link with push",
    "initializeResult",
    narrowInitializeResult,
    init({ link: { ...LINK, push: true } }),
    true,
  ],
  [
    "a non-boolean push",
    "initializeResult",
    narrowInitializeResult,
    init({ link: { ...LINK, push: 1 } }),
    false,
  ],
  [
    "a job with firstTurn, outlivesHost and honours",
    "initializeResult",
    narrowInitializeResult,
    init({ job: { ...JOB, firstTurn: "at-start", outlivesHost: true, honours: HONOURS } }),
    true,
  ],
  [
    "an unknown firstTurn",
    "initializeResult",
    narrowInitializeResult,
    init({ job: { ...JOB, firstTurn: "later" } }),
    false,
  ],
  [
    "honours without roles",
    "initializeResult",
    narrowInitializeResult,
    init({ job: { ...JOB, honours: { command: true, env: true, sockets: true } } }),
    false,
  ],
  [
    "honours with a role twice",
    "initializeResult",
    narrowInitializeResult,
    init({ job: { ...JOB, honours: { ...HONOURS, roles: ["read-only", "read-only"] } } }),
    false,
  ],
  [
    "honours with an unknown role",
    "initializeResult",
    narrowInitializeResult,
    init({ job: { ...JOB, honours: { ...HONOURS, roles: ["root"] } } }),
    false,
  ],
  ["a start reply", "jobStart", narrowJobStart, { view: VIEW, handle: "s-1" }, true],
  [
    "an at-start reply with its baseline",
    "jobStart",
    narrowJobStart,
    { view: { ...VIEW, cwd: "/w" }, handle: "s-1", baseline: { runs: 0, incarnation: "inc" } },
    true,
  ],
  ["a start without a view", "jobStart", narrowJobStart, { handle: "s-1" }, false],
  ["a handle with a space", "jobStart", narrowJobStart, { view: VIEW, handle: "a b" }, false],
  [
    "a view env that is not strings",
    "jobStart",
    narrowJobStart,
    { view: { command: "c", env: { A: 1 } } },
    false,
  ],
  [
    "a negative baseline",
    "jobStart",
    narrowJobStart,
    { view: VIEW, baseline: { runs: -1 } },
    false,
  ],
  ["a found job", "jobLookup", narrowJobLookup, { found: { view: VIEW, handle: "s-1" } }, true],
  ["a found job without a handle", "jobLookup", narrowJobLookup, { found: { view: VIEW } }, false],
  ["pending", "jobLookup", narrowJobLookup, { pending: true }, true],
  ["none", "jobLookup", narrowJobLookup, { none: true }, true],
  ["unknown", "jobLookup", narrowJobLookup, { unknown: "the backend is down" }, true],
  ["none false", "jobLookup", narrowJobLookup, { none: false }, false],
  ["two answers", "jobLookup", narrowJobLookup, { none: true, pending: true }, false],
  ["nothing", "jobLookup", narrowJobLookup, {}, false],
  ["running", "jobLiveness", narrowJobLiveness, { state: "running" }, true],
  ["ended", "jobLiveness", narrowJobLiveness, { state: "ended", exit: 3 }, true],
  ["ended by a signal", "jobLiveness", narrowJobLiveness, { state: "ended", exit: null }, true],
  ["ended without exit", "jobLiveness", narrowJobLiveness, { state: "ended" }, false],
  ["lost", "jobLiveness", narrowJobLiveness, { state: "lost", reason: "gone" }, true],
  ["unknown without a reason", "jobLiveness", narrowJobLiveness, { state: "unknown" }, false],
  [
    "running with a reason",
    "jobLiveness",
    narrowJobLiveness,
    { state: "running", reason: "x" },
    false,
  ],
  ["an attach view", "paneCommand", narrowPaneCommand, VIEW, true],
  ["an empty command", "paneCommand", narrowPaneCommand, { command: "", env: {} }, false],
  ["a stop's null", "null", narrowNull, null, true],
  ["a stop's object", "null", narrowNull, {}, false],
  [
    "host facts",
    "hostFacts",
    narrowHostFacts,
    { handle: "h-1", deadlineAt: 1, idleReclaimMs: 0, maxJobs: 2 },
    true,
  ],
  ["zero max jobs", "hostFacts", narrowHostFacts, { handle: "h-1", maxJobs: 0 }, false],
  ["a found host", "hostLookup", narrowHostLookup, { found: { handle: "h-1" } }, true],
  [
    "accepted",
    "messageCheck",
    narrowMessageCheck,
    { state: "accepted", id: "m", runs: 2, incarnation: "i" },
    true,
  ],
  ["not accepted", "messageCheck", narrowMessageCheck, { state: "not-accepted", id: "m" }, true],
  [
    "unreachable",
    "messageCheck",
    narrowMessageCheck,
    { state: "unreachable", id: "m", reason: "r" },
    true,
  ],
  [
    "not accepted with runs",
    "messageCheck",
    narrowMessageCheck,
    { state: "not-accepted", id: "m", runs: 1 },
    false,
  ],
];

describe("the job seam on the wire", () => {
  it.each(FIXTURES)("%s: narrower and schema agree", (_name, def, narrow, value, valid) => {
    expect(validates(schema, def, value)).toBe(valid);
    expect(narrow(value).ok).toBe(valid);
  });

  it("the handle pattern is mu's JOB_HANDLE_RE", () => {
    expect(HANDLE_RE.source).toBe(JOB_HANDLE_RE.source);
  });

  it("the job methods' params are valid under their definitions", () => {
    const target = { job: { kind: "cloud", key: "tok" }, host: { name: "dev" } };
    const spec = {
      workstream: "ws",
      name: "w",
      harness: "claude",
      role: "read-only",
      cmd: "claude",
      commandSource: "cli-key",
      cwd: "/r",
      env: { MU_AGENT_NAME: "w" },
      firstPrompt: { text: "brief", msgId: "m1" },
    };
    expect(validates(schema, "jobStartParams", { target, deadline: 1, key: "tok", spec })).toBe(
      true,
    );
    expect(
      validates(schema, "jobStartParams", {
        target,
        deadline: 1,
        key: "tok",
        spec: { ...spec, role: "root" },
      }),
    ).toBe(false);
    expect(validates(schema, "jobStopParams", { target, deadline: 1, key: "tok:stop" })).toBe(true);
    expect(
      validates(schema, "lookupParams", { target, deadline: 1, key: "tok", fence: true }),
    ).toBe(true);
    expect(validates(schema, "targetParams", { target, deadline: 1 })).toBe(true);
    const push = {
      target,
      deadline: 1,
      localRepo: "/l",
      remoteRepo: "/r",
      rev: "a".repeat(40),
      timeoutMs: 1,
    };
    expect(validates(schema, "linkPushParams", push)).toBe(true);
    expect(validates(schema, "linkPushParams", { ...push, rev: "HEAD" })).toBe(false);
  });

  it.each([
    [
      { ...JOB, firstTurn: "at-start", handle: "file", start: { lookup: true, fenceKey: false } },
      /at-start" needs handle "reply"/,
    ],
    [{ ...JOB, honours: { ...HONOURS, env: false } }, /honours\.env false needs a channel/],
  ])("a load rule refuses %o", (job, re) => {
    const r = narrowInitializeResult(init({ link: LINK, job }));
    if (!r.ok) throw new Error(r.reason);
    expect(loadRefusals(r.value, { name: "cloud" }).join("; ")).toMatch(re);
  });

  it("at-start with a reply handle, and honours.env false with a channel, load", () => {
    const channel = {
      name: "cloud",
      caps: {
        fence: "none",
        receipt: "exact",
        steer: "none",
        interrupt: "exact",
        fresh: "none",
        answer: false,
        command: false,
        watch: "stream",
        settleText: "tied",
      },
    };
    const r = narrowInitializeResult(
      init({
        link: LINK,
        job: {
          ...JOB,
          firstTurn: "at-start",
          honours: { ...HONOURS, env: false },
          channel: "cloud",
        },
        channel,
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(loadRefusals(r.value, { name: "cloud" })).toEqual([]);
  });
});
