// The contract suites' fake plugin (plugins spec D16): a real executable that
// speaks mu's plugin protocol on stdin and stdout, backed by a JSON file.
//
//   node test/_fake-plugin.mjs <config.json>
//
// The config is re-read on every request, so a test changes the fake's
// behaviour between calls. Every request is appended to `<config>.log`
// (JSON lines: method, params); a fault queue is consumed per method in
// `<config>.state`. The link runs scripts locally with /bin/sh in its own
// process group, under `home` (a script's `.`), and fetches from a local
// path; that host is this machine.
//
// Config (all optional): name, version, instance, speaks [min, max], liar
// (reply its own protocol even with no overlap), schema (the digest it
// claims; default the published file's), seams, home, lateMs, ignoreEof (keep
// running on stdin EOF), detach (leave a setsid'd helper holding stdout; a
// string: the file its pid is written to), detachExec (hostile: run each
// exec in its own session, out of the fake's group), checkSteps (the
// link.checkSteps result to return), stopLateMs (answer a timed-out run at once,
// stop it this much later), initDelayMs (answer the handshake late),
// replyOnCancel (answer a cancelled call at once), eofDelayMs (take this long
// to exit on EOF, logging "(clean exit)"), leakCanary (write MU_PLUGIN_CANARY to stderr and into a reply), envDump (a
// path the start-up env is written to), stderr (a line written at start),
// faults: { "<method>": ["<fault>", ...] }, the nth call taking the nth entry:
//   retryable | permanent | human | unknown-outcome   an error of that kind
//   malformed      a line that is not JSON
//   big            a line over 1 MiB
//   badResult      a result of the wrong shape
//   request        a request to mu instead of a reply
//   noId           an error reply with a null id
//   hang           no reply, ever; a $/cancel is ignored
//   late           the reply after lateMs, a $/cancel ignored
//   exit           the process exits mid-call
//   exitWithHelper the process exits mid-call, leaving a helper in its group
//                  that holds stdout (its pid in `<config>.helper`)
//   badUtf8        a reply with a byte that is not UTF-8
//   effectThenExit the effect happens, then the process exits before replying
//   lateRetryable  a retryable error after 200 ms (nothing happened)
//   ok             the normal answer
//
// The job seam (declared through `seams.job`) and the channel's deliveries keep
// a fake backend in `<config>.jobs` (JSON): jobs by key, and counters of the
// effects that really happened (`starts`, `stops`, `deliveries`). A repeat of a
// key (a start) or a msgId (a send) returns the first result and makes no
// second effect (exact dedupe). Config: viewCommand (a start's view),
// lookupAnswer (job.lookup's answer for an unknown key; default none),
// receiptAnswer (channel.receipt's for an unknown msgId; default not-accepted),
// replies ({ "<method>": <result> }: that method's reply, verbatim, whatever it
// is asked; the contract tests' malformed and foreign answers).
//
// The channel seam (declared through `seams.channel`) keeps its agents in the same
// file: each a dense turn count, an incarnation and the running turn, which a
// delivery (or an at-start job.start's firstPrompt) begins and which settles
// `turnMs` later (default 100) with text `done: <prompt>`. channelState forces
// every reading's and observation's state (the liveness plants); watchSilent: a
// watch is answered but never notified.
//
// The host seam (declared through `seams.host`) keeps its hosts in the same
// backend file: hosts by acquire key, and the effects that happened (`acquires`,
// `releases`). Config: hostFacts (merged into an acquire's facts), hostGone (a
// reason: every status answers gone), hostStatusFacts (an up status's facts
// instead of the acquire's, the handle kept), hostLookupAnswer (host.lookup's answer
// for an unknown key; default none). `link.push` fetches the commit into the
// remote repo (a path under `home`), initialising it when absent; pushNoop
// answers success without pushing. requireHostHandle: a job or link call whose
// target.host carries no handle and instance fails (a plugin with no map of its own).
//
// Every request and every $/cancel is logged.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configPath = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(here, "..", "schemas", "plugin-protocol-v1.json");
const digest = `sha256:${createHash("sha256").update(readFileSync(SCHEMA)).digest("hex")}`;

const DEFAULT_SEAMS = {
  link: {
    fetch: true,
    slots: "self",
    remoteOnTimeout: "stopped",
    quiescence: "provable",
    maxScriptBytes: 131072,
    checks: ["reach"],
  },
};

const config = () => {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
};

const statePath = `${configPath}.state`;
const nextFault = (method) => {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const n = state[method] ?? 0;
  state[method] = n + 1;
  writeFileSync(statePath, JSON.stringify(state));
  return config().faults?.[method]?.[n] ?? "ok";
};

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const fail = (id, kind, message, remedy) =>
  write({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message, data: { kind, ...(remedy ? { remedy } : {}) } },
  });

const start = config();
if (start.envDump) writeFileSync(start.envDump, JSON.stringify(process.env));
if (start.stderr) process.stderr.write(`${start.stderr}\n`);
if (start.leakCanary && process.env.MU_PLUGIN_CANARY) {
  process.stderr.write(`canary ${process.env.MU_PLUGIN_CANARY}\n`);
}
if (start.detach) {
  // A helper that leaves the group (setsid) and keeps stdout: what a plugin must never do.
  const helper = spawn("/bin/sleep", ["30"], {
    detached: true,
    stdio: ["ignore", "inherit", "ignore"],
  });
  if (typeof start.detach === "string") writeFileSync(start.detach, String(helper.pid));
  helper.unref();
}

/** In-flight runs by request id: their pids, for $/cancel and EOF. */
const running = new Map();
/** Requests whose reply is withheld (hang, late): a $/cancel does not answer them. */
const deaf = new Set();

/** pid, ppid and pgid of every process. */
const processes = () =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));

const kill = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

/** A run and everything it started that still descends from it. */
const killTree = (root) => {
  const table = processes();
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of table) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  for (const pid of tree) kill(pid);
};

/** Everything left in the fake's own group but the fake (a run's orphans included). */
const killGroupButMe = () => {
  for (const [pid, , pgid] of processes())
    if (pgid === process.pid && pid !== process.pid) kill(pid);
};

// Runs stay in the fake's process group, so nothing they start can outlive it (D13
// no-detach). `detachExec` is the hostile variant: each run in its own session.
function run(id, argv, cwd, timeoutMs, done) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    detached: config().detachExec === true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.set(id, child.pid);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  let answered = false;
  const finish = (r) => {
    if (answered) return;
    answered = true;
    done(r);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    // stopLateMs: answer the timeout at once and stop the run only afterwards (a relay whose
    // remote stops asynchronously: `remoteOnTimeout: "stopping"`).
    const late = config().stopLateMs;
    if (late === undefined) {
      killTree(child.pid);
      return;
    }
    finish({ exitCode: null, stdout, stderr, partial: false });
    setTimeout(() => killTree(child.pid), late);
  }, timeoutMs);
  child.on("error", (e) => {
    clearTimeout(timer);
    running.delete(id);
    finish({ exitCode: 127, stdout: "", stderr: String(e.message), partial: false });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    running.delete(id);
    finish({ exitCode: timedOut ? null : code, stdout, stderr, partial: false });
  });
}

const jobsPath = `${configPath}.jobs`;
const backend = () =>
  existsSync(jobsPath)
    ? JSON.parse(readFileSync(jobsPath, "utf8"))
    : { jobs: {}, sends: {}, starts: 0, stops: 0, deliveries: 0 };
const hostsOf = (b) => {
  b.hosts ??= {};
  b.acquires ??= 0;
  b.releases ??= 0;
  return b.hosts;
};
const hostByHandle = (b, handle) =>
  Object.values(hostsOf(b)).find((h) => h.facts.handle === handle);
const save = (b) => writeFileSync(jobsPath, JSON.stringify(b));
const byHandle = (b, handle) => Object.values(b.jobs).find((j) => j.start.handle === handle);

/**
 * The channel's agents, by `<workstream>/<name>`: a dense turn count, an incarnation and the
 * running turn, which settles `turnMs` after its delivery (read lazily: the fake lives only as
 * long as one mu invocation). A settled turn's text is `done: <prompt>`.
 */
function agentOf(b, target) {
  const t = target?.agent ?? {};
  b.agents ??= {};
  const key = `${t.workstream}/${t.name}`;
  b.agents[key] ??= { runs: 0, inc: "inc-1", turn: null, lastText: null };
  const a = b.agents[key];
  if (a.turn !== null && Date.now() >= a.turn.settleAt) endTurn(a);
  return a;
}
function startTurn(a, text, c) {
  a.turn = { text, settleAt: Date.now() + (c.turnMs ?? 100) };
}
function endTurn(a, error) {
  a.runs += 1;
  a.lastText = error ? null : `done: ${a.turn.text}`;
  a.lastError = error ?? null;
  a.turn = null;
}
function observe(a, settled, c) {
  return {
    status: c.channelState ?? (a.turn ? "busy" : "idle"),
    settled,
    since: null,
    runs: a.runs,
    incarnation: a.inc,
    ...(settled && a.lastText !== null ? { lastText: a.lastText } : {}),
    ...(settled && a.lastError ? { lastError: a.lastError } : {}),
  };
}

/** Open watches: their timers, by watchId. */
const watches = new Map();

/** `channel.watch`: the reply, then one `watch/settled` once a turn past `afterRuns` settled. */
function watch(id, params, c) {
  const b = backend();
  const a = agentOf(b, params.target);
  save(b);
  const watchId = `w-${id}`;
  const after = params.afterRuns ?? (a.turn ? a.runs : a.runs);
  reply(id, { watchId, initial: observe(a, false, c), afterRuns: after });
  if (c.watchSilent) return;
  const notify = () => {
    watches.delete(watchId);
    const now = backend();
    const x = agentOf(now, params.target);
    save(now);
    if (x.runs > after) {
      write({
        jsonrpc: "2.0",
        method: "watch/settled",
        params: { watchId, observation: observe(x, true, c) },
      });
    } else if (x.turn !== null) {
      watches.set(watchId, setTimeout(notify, Math.max(0, x.turn.settleAt - Date.now()) + 5));
    } else watches.set(watchId, setTimeout(notify, 50));
  };
  if (a.runs > after) notify();
  else
    watches.set(
      watchId,
      setTimeout(notify, a.turn ? Math.max(0, a.turn.settleAt - Date.now()) + 5 : 50),
    );
}

/** The job seam and the deliveries, over the fake backend. Undefined: not one of these. */
function backendAnswer(method, params, c) {
  const b = backend();
  switch (method) {
    case "job.start": {
      const seen = b.jobs[params.key];
      if (seen !== undefined) return seen.start;
      b.starts += 1;
      // An at-start kind's first prompt begins turn 1 (D8): its baseline is runs 0.
      const first = params.spec?.firstPrompt;
      const a = first ? agentOf(b, { agent: params.spec }) : undefined;
      if (a !== undefined) startTurn(a, first.text, c);
      const start = {
        view: { command: c.viewCommand ?? "sleep 600", env: {} },
        ...(c.seams?.job?.handle === "file" ? {} : { handle: `job-${b.starts}` }),
        ...(a !== undefined ? { baseline: { runs: 0, incarnation: a.inc } } : {}),
      };
      // A file-handle kind's handle is the one its view pane would publish.
      const fileHandle = c.seams?.job?.handle === "file" ? `file-job-${b.starts}` : undefined;
      b.jobs[params.key] = { start, stopped: false, ...(fileHandle ? { fileHandle } : {}) };
      save(b);
      return start;
    }
    case "job.lookup": {
      const seen = b.jobs[params.key];
      if (seen?.fileHandle !== undefined) return { found: { handle: seen.fileHandle } };
      return seen !== undefined ? { found: seen.start } : (c.lookupAnswer ?? { none: true });
    }
    case "job.status": {
      const j = byHandle(b, params.target?.job?.handle);
      if (j === undefined) return { state: "unknown", reason: "no such job" };
      return j.stopped ? { state: "ended", exit: 0 } : { state: "running" };
    }
    case "job.stop": {
      const j = Object.entries(b.jobs).find(
        ([, v]) => v.start.handle === params.target?.job?.handle,
      );
      if (j !== undefined && !j[1].stopped) {
        j[1].stopped = true;
        b.stops += 1;
        save(b);
      }
      return null;
    }
    case "job.attach": {
      const j = byHandle(b, params.target?.job?.handle);
      return j?.start.view ?? { command: "true", env: {} };
    }
    case "job.checkSteps":
      return c.jobCheckSteps ?? [];
    case "channel.send":
    case "channel.fresh":
    case "channel.command": {
      const msgId = params.msgId ?? `cmd-${b.deliveries + 1}`;
      if (b.sends[msgId] === undefined) {
        b.deliveries += 1;
        const a = agentOf(b, params.target);
        const baseline = { runs: a.runs, incarnation: a.inc };
        startTurn(a, params.text ?? `/${params.name}`, c);
        b.sends[msgId] = {
          channel: c.seams?.channel?.name ?? "fake",
          ack: "exact",
          baseline,
          ...(params.msgId ? { msgId } : {}),
        };
        save(b);
      }
      return b.sends[msgId];
    }
    case "channel.readStates": {
      const out = {};
      for (const t of params.targets ?? []) {
        const a = agentOf(b, t);
        out[`${t.agent?.workstream}/${t.agent?.name}`] = {
          state: c.channelState ?? (a.turn ? "busy" : "idle"),
          since: null,
          runs: a.runs,
          incarnation: a.inc,
        };
      }
      save(b);
      return out;
    }
    case "channel.baseline": {
      const a = agentOf(b, params.target);
      save(b);
      return { runs: a.runs, incarnation: a.inc };
    }
    case "channel.lastRun": {
      const a = agentOf(b, params.target);
      save(b);
      return a.runs > params.afterRuns ? observe(a, true, c) : null;
    }
    case "channel.interrupt": {
      const a = agentOf(b, params.target);
      const wasBusy = a.turn !== null;
      if (wasBusy) endTurn(a, "interrupted");
      b.deliveries += 1;
      const runs = a.runs;
      startTurn(a, params.text, c);
      save(b);
      return { wasBusy, pending: false, runs, msgId: params.msgId, incarnation: a.inc };
    }
    case "channel.abort": {
      const a = agentOf(b, params.target);
      const busy = a.turn !== null;
      if (busy) endTurn(a, "aborted");
      save(b);
      return {
        before: busy ? "busy" : "idle",
        after: "idle",
        settled: true,
        aborted: busy,
        pending: false,
      };
    }
    case "channel.answer":
      return { keys: params.keys, ack: "unknown" };
    case "host.acquire": {
      const seen = hostsOf(b)[params.key];
      if (seen !== undefined) return seen.facts;
      b.acquires += 1;
      const facts = { handle: `host-${b.acquires}`, ...(c.hostFacts ?? {}) };
      b.hosts[params.key] = { facts, released: false };
      save(b);
      return facts;
    }
    case "host.lookup": {
      const seen = hostsOf(b)[params.key];
      return seen !== undefined ? { found: seen.facts } : (c.hostLookupAnswer ?? { none: true });
    }
    case "host.status": {
      const h = hostByHandle(b, params.target?.host?.handle);
      if (h === undefined) return { state: "unknown", reason: "no such host" };
      if (h.released) return { state: "gone", reason: "released" };
      if (c.hostGone) return { state: "gone", reason: c.hostGone };
      return c.hostStatusFacts
        ? { state: "up", handle: h.facts.handle, ...c.hostStatusFacts }
        : { state: "up", ...h.facts };
    }
    case "host.release": {
      const h = hostByHandle(b, params.target?.host?.handle);
      if (h !== undefined && !h.released) {
        h.released = true;
        b.releases += 1;
        save(b);
      }
      return null;
    }
    case "channel.receipt":
      return b.sends[params.msgId] !== undefined
        ? { state: "accepted", id: params.msgId }
        : (c.receiptAnswer ?? { state: "not-accepted", id: params.msgId });
    default:
      return undefined;
  }
}

function answer(id, method, params) {
  const c = config();
  const h = params?.target?.host;
  if (c.requireHostHandle && /^(job|link)\./.test(method) && !(h?.handle && h?.instance)) {
    fail(id, "permanent", `${method}: target.host names no handle and instance`);
    return;
  }
  const home = c.home ?? process.cwd();
  if (c.replies !== undefined && method in c.replies) {
    reply(id, c.replies[method]);
    return;
  }
  const fromBackend = backendAnswer(method, params, c);
  if (fromBackend !== undefined) {
    reply(id, fromBackend);
    return;
  }
  switch (method) {
    case "channel.watch":
      watch(id, params, c);
      return;
    case "link.exec":
      run(id, ["/bin/sh", "-c", params.script], resolve(home, params.cwd), params.timeoutMs, (r) =>
        reply(
          id,
          c.leakCanary ? { ...r, stdout: `${r.stdout}${process.env.MU_PLUGIN_CANARY ?? ""}` } : r,
        ),
      );
      return;
    case "link.fetch":
      run(
        id,
        ["git", "fetch", "--quiet", resolve(home, params.remoteCwd), "HEAD"],
        params.localRepo,
        params.timeoutMs,
        (r) => reply(id, r),
      );
      return;
    case "link.push": {
      if (c.pushNoop) {
        reply(id, { exitCode: 0, stdout: "", stderr: "", partial: false });
        return;
      }
      const repo = resolve(home, params.remoteRepo);
      const sh = `mkdir -p "$1" && { [ -e "$1/.git" ] || git -C "$1" init -q; } && git -C "$1" fetch -q "$2" "$3"`;
      run(
        id,
        ["/bin/sh", "-c", sh, "push", repo, params.localRepo, params.rev],
        home,
        params.timeoutMs,
        (r) => reply(id, r),
      );
      return;
    }
    case "link.checkSteps":
      if (c.checkSteps !== undefined) {
        reply(id, c.checkSteps);
        return;
      }
      reply(
        id,
        params.phase === "reach" ? [{ step: "reachable", ok: true, detail: "fake answered" }] : [],
      );
      return;
    case "shutdown":
      reply(id, null);
      return;
    default:
      fail(id, "permanent", `no method ${method}`);
  }
}

function initialize(id, params) {
  const c = config();
  const [min, max] = c.speaks ?? [1, 1];
  const offered = params?.protocol ?? { min: 0, max: 0 };
  const hi = Math.min(max, offered.max);
  const common = hi >= Math.max(min, offered.min) ? hi : null;
  if (common === null && !c.liar) {
    fail(id, "permanent", `no common protocol version: the fake speaks ${min}..${max}`);
    return;
  }
  reply(id, {
    protocol: common ?? max,
    plugin: { name: c.name ?? "fake", version: c.version ?? "0.1.0" },
    instance: c.instance ?? "fake-1",
    schema: c.schema ?? digest,
    seams: c.seams ?? DEFAULT_SEAMS,
  });
}

function onMessage(msg) {
  if (msg.method === "$/cancel") {
    appendFileSync(
      `${configPath}.log`,
      `${JSON.stringify({ method: msg.method, params: msg.params })}\n`,
    );
    if (msg.params?.watchId !== undefined) {
      clearTimeout(watches.get(msg.params.watchId));
      watches.delete(msg.params.watchId);
      return;
    }
    const id = msg.params?.id;
    // replyOnCancel: answer the cancelled call at once (mu must ignore it, and wait on).
    if (config().replyOnCancel) {
      reply(id, { exitCode: null, stdout: "", stderr: "cancelled", partial: false });
      return;
    }
    if (deaf.has(id)) return;
    const pid = running.get(id);
    if (pid !== undefined) killTree(pid);
    return;
  }
  appendFileSync(
    `${configPath}.log`,
    `${JSON.stringify({ method: msg.method, params: msg.params })}\n`,
  );
  if (msg.method === "initialize") {
    const delay = config().initDelayMs;
    if (delay) setTimeout(() => initialize(msg.id, msg.params), delay);
    else initialize(msg.id, msg.params);
    return;
  }
  const fault = nextFault(msg.method);
  const id = msg.id;
  switch (fault) {
    case "retryable":
    case "permanent":
    case "unknown-outcome":
      fail(id, fault, `injected ${fault}`);
      return;
    case "human":
      fail(id, "human", "injected hand-back", "touch your security key");
      return;
    case "malformed":
      process.stdout.write("this is not json\n");
      return;
    case "big":
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, result: "x".repeat(1024 * 1024 + 10) })}\n`,
      );
      return;
    case "badResult":
      reply(id, { exitCode: "zero" });
      return;
    case "request":
      write({ jsonrpc: "2.0", id: 99, method: "mu.db.write", params: {} });
      return;
    case "noId":
      fail(null, "permanent", "an error about nothing");
      return;
    case "hang":
      deaf.add(id);
      return;
    case "late":
      deaf.add(id);
      setTimeout(() => answer(id, msg.method, msg.params), config().lateMs ?? 300);
      return;
    case "exit":
      process.exit(9);
      return;
    case "exitWithHelper": {
      // The leader exits mid-call, leaving a helper in its group that holds stdout.
      const helper = spawn("/bin/sleep", ["30"], { stdio: ["ignore", "inherit", "ignore"] });
      writeFileSync(`${configPath}.helper`, String(helper.pid));
      process.exit(9);
      return;
    }
    case "lateRetryable":
      setTimeout(() => fail(id, "retryable", "injected delayed retryable"), 200);
      return;
    case "effectThenExit":
      backendAnswer(msg.method, msg.params, config());
      process.exit(9);
      return;
    case "badUtf8":
      process.stdout.write(
        Buffer.concat([
          Buffer.from(`{"jsonrpc":"2.0","id":${id},"result":{"exitCode":0,"stdout":"`),
          Buffer.from([0xff]),
          Buffer.from('","stderr":"","partial":false}}\n'),
        ]),
      );
      return;
    default:
      answer(id, msg.method, msg.params);
  }
}

let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (line.trim() !== "") onMessage(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  // stdin EOF: end the in-flight calls and exit, well within the grace (D13).
  const c = config();
  if (c.ignoreEof) {
    setInterval(() => {}, 1000);
    return;
  }
  const finish = () => {
    for (const pid of running.values()) killTree(pid);
    if (!c.detachExec) killGroupButMe();
    appendFileSync(`${configPath}.log`, `${JSON.stringify({ method: "(clean exit)" })}\n`);
    process.exit(0);
  };
  // eofDelayMs: a cleanup that takes a while, still within the grace.
  if (c.eofDelayMs) setTimeout(finish, c.eofDelayMs);
  else finish();
});
