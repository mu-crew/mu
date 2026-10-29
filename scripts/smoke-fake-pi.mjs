#!/usr/bin/env node
// A ctl-speaking stand-in for pi, for scripts/smoke-lease.sh only (never a
// suite fixture). The smoke runs it on the "remote" side of a loopback sshd as
// the job a lease carrier dispatches, so mu's real ctl client talks to it
// through the carrier's forward. No network, no model, no real pi.
//
// It serves the mu ctl protocol (src/ctl/protocol.ts) on $MU_CTL_SOCK:
//   hello   ops, features (incarnation, msgId, fence), one incarnation per process
//   status  state/since/runs/pending; with msgId, whether that send was accepted
//   send    fenced by expectIncarnation; starts a run that settles ~300 ms later
//           with lastText "smoke-echo: <text>"; replies the runs measured before
//   wait    afterRuns / timeoutMs / incarnation, ended "settled" with lastText
//   abort   wasBusy, ends the running run
// `pi --version` and `pi list` answer as host check expects (non-login).
// SIGHUP / SIGTERM / SIGINT unlink the socket and exit.

import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const arg = process.argv[2];
if (arg === "--version") {
  console.log("0.0.0-smoke");
  process.exit(0);
}
if (arg === "list") {
  console.log("npm:@mu-crew/mu (smoke fake pi)");
  process.exit(0);
}

const sock = process.env.MU_CTL_SOCK;
if (!sock) {
  console.error("smoke-fake-pi: MU_CTL_SOCK is not set");
  process.exit(2);
}

const V = 1;
const OPS = ["hello", "status", "send", "wait", "abort"];
const FEATURES = ["incarnation", "msgId", "fence"];
const MISMATCH = "incarnation mismatch";
const RUN_MS = 300;

const g = {
  incarnation: randomUUID(),
  state: "idle",
  since: Date.now(),
  runs: 0,
  lastText: "",
  accepted: new Map(),
  waiters: new Set(),
  timer: undefined,
};

const say = (line) => {
  try {
    process.stdout.write(`smoke-fake-pi: ${line}\n`);
  } catch {
    /* the pane may be gone */
  }
};
const fail = (error, extra = {}) => ({ v: V, ok: false, error, ...extra });
const status = () => ({
  incarnation: g.incarnation,
  state: g.state,
  since: g.since,
  runs: g.runs,
  pending: false,
  tool: null,
});
const settled = () => ({ v: V, ok: true, ...status(), lastText: g.lastText, ended: "settled" });

function msgIdOf(req) {
  if (!("msgId" in req)) return {};
  const id = req.msgId;
  if (typeof id === "string" && id.length >= 1 && id.length <= 64) return { id };
  return { error: "msgId must be a string of 1-64 characters" };
}

function stale(req, key) {
  if (!(key in req) || req[key] === g.incarnation) return undefined;
  return fail(MISMATCH, { incarnation: g.incarnation });
}

function startRun(text) {
  g.state = "busy";
  g.since = Date.now();
  g.timer = setTimeout(() => endRun(`smoke-echo: ${text}`), RUN_MS);
}

function endRun(lastText) {
  g.timer = undefined;
  g.state = "idle";
  g.since = Date.now();
  g.runs++;
  g.lastText = lastText;
  say(`settled run ${g.runs}`);
  for (const w of [...g.waiters]) w();
}

function wait(req, conn) {
  const afterRuns = typeof req.afterRuns === "number" ? req.afterRuns : undefined;
  if (afterRuns !== undefined && g.runs > afterRuns && g.state === "idle") {
    return Promise.resolve(settled());
  }
  return new Promise((resolve) => {
    let timer;
    const done = (r) => {
      g.waiters.delete(waiter);
      if (timer) clearTimeout(timer);
      conn.off("close", onClose);
      resolve(r);
    };
    const waiter = () => {
      if (afterRuns !== undefined && g.runs <= afterRuns) return;
      done(settled());
    };
    const onClose = () => done(fail("client closed"));
    g.waiters.add(waiter);
    conn.on("close", onClose);
    if (typeof req.timeoutMs === "number")
      timer = setTimeout(() => done(fail("timeout")), req.timeoutMs);
  });
}

async function handle(req, conn) {
  switch (req.op) {
    case "hello":
      return {
        v: V,
        ok: true,
        agent: process.env.MU_AGENT_NAME,
        workstream: process.env.MU_WORKSTREAM,
        piVersion: "0.0.0-smoke",
        incarnation: g.incarnation,
        ops: OPS,
        features: FEATURES,
      };
    case "status": {
      const id = msgIdOf(req);
      if (id.error) return fail(id.error);
      if (id.id === undefined) return { v: V, ok: true, ...status() };
      const got = g.accepted.get(id.id);
      const msg = got ? { id: id.id, accepted: true, ...got } : { id: id.id, accepted: false };
      return { v: V, ok: true, ...status(), msg };
    }
    case "send": {
      const refused = stale(req, "expectIncarnation");
      if (refused) return refused;
      if (typeof req.text !== "string") return fail("send needs a string text");
      const id = msgIdOf(req);
      if (id.error) return fail(id.error);
      const before = status();
      if (g.state === "idle") startRun(req.text);
      if (id.id !== undefined) g.accepted.set(id.id, { runs: before.runs, at: Date.now() });
      say(`received ${JSON.stringify(req.text)}`);
      return { v: V, ok: true, ...before };
    }
    case "wait": {
      const refused = stale(req, "incarnation");
      if (refused) return refused;
      return wait(req, conn);
    }
    case "abort": {
      const wasBusy = g.state === "busy";
      if (wasBusy) {
        clearTimeout(g.timer);
        endRun("");
      }
      return { v: V, ok: true, state: g.state, wasBusy };
    }
    default:
      return fail(`unknown op: ${String(req.op)}`, { ops: OPS });
  }
}

function onConnection(conn) {
  conn.setEncoding("utf8");
  conn.on("error", () => {});
  let buf = "";
  let seen = false;
  conn.on("data", (chunk) => {
    buf += chunk;
    const i = buf.indexOf("\n");
    if (i < 0 || seen) return;
    seen = true; // one request per connection
    let req;
    try {
      req = JSON.parse(buf.slice(0, i));
    } catch {
      conn.end(`${JSON.stringify(fail("bad json"))}\n`);
      return;
    }
    if (typeof req !== "object" || req === null) {
      conn.end(`${JSON.stringify(fail("request must be an object"))}\n`);
      return;
    }
    handle(req, conn).then(
      (r) => {
        if (!conn.destroyed) conn.end(`${JSON.stringify(r)}\n`);
      },
      (e) => {
        if (!conn.destroyed) conn.end(`${JSON.stringify(fail(String(e)))}\n`);
      },
    );
  });
}

// Bind as the extension does: listen on a private name, link it into place.
mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
rmSync(sock, { force: true });
const tmp = join(dirname(sock), `.smoke-${process.pid}`);
rmSync(tmp, { force: true });
const server = createServer(onConnection);
server.listen(tmp, () => {
  chmodSync(tmp, 0o600);
  linkSync(tmp, sock);
  rmSync(tmp, { force: true });
  say(`listening on ${sock} (incarnation ${g.incarnation})`);
});

let quitting = false;
const quit = (code) => {
  if (quitting) return;
  quitting = true;
  rmSync(sock, { force: true });
  process.exit(code);
};
process.on("SIGHUP", () => quit(129));
process.on("SIGTERM", () => quit(143));
process.on("SIGINT", () => quit(130));
