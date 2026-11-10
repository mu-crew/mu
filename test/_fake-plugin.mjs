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
// link.checkSteps result to return), initDelayMs (answer the handshake late),
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
//   ok             the normal answer
//
// The job seam (declared through `seams.job`) and the channel's deliveries keep
// a fake backend in `<config>.jobs` (JSON): jobs by key, and counters of the
// effects that really happened (`starts`, `stops`, `deliveries`). A repeat of a
// key (a start) or a msgId (a send) returns the first result and makes no
// second effect (exact dedupe). Config: viewCommand (a start's view),
// lookupAnswer (job.lookup's answer for an unknown key; default none),
// receiptAnswer (channel.receipt's for an unknown msgId; default not-accepted).
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
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, timeoutMs);
  child.on("error", (e) => {
    clearTimeout(timer);
    running.delete(id);
    done({ exitCode: 127, stdout: "", stderr: String(e.message), partial: false });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    running.delete(id);
    done({ exitCode: timedOut ? null : code, stdout, stderr, partial: false });
  });
}

const jobsPath = `${configPath}.jobs`;
const backend = () =>
  existsSync(jobsPath)
    ? JSON.parse(readFileSync(jobsPath, "utf8"))
    : { jobs: {}, sends: {}, starts: 0, stops: 0, deliveries: 0 };
const save = (b) => writeFileSync(jobsPath, JSON.stringify(b));
const byHandle = (b, handle) => Object.values(b.jobs).find((j) => j.start.handle === handle);

/** The job seam and the deliveries, over the fake backend. Undefined: not one of these. */
function backendAnswer(method, params, c) {
  const b = backend();
  switch (method) {
    case "job.start": {
      const seen = b.jobs[params.key];
      if (seen !== undefined) return seen.start;
      b.starts += 1;
      const start = {
        view: { command: c.viewCommand ?? "sleep 600", env: {} },
        ...(c.seams?.job?.handle === "file" ? {} : { handle: `job-${b.starts}` }),
      };
      b.jobs[params.key] = { start, stopped: false };
      save(b);
      return start;
    }
    case "job.lookup": {
      const seen = b.jobs[params.key];
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
      if (b.sends[params.msgId] === undefined) {
        b.deliveries += 1;
        b.sends[params.msgId] = { channel: c.seams?.channel?.name ?? "fake", ack: "exact" };
        save(b);
      }
      return b.sends[params.msgId];
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
  const home = c.home ?? process.cwd();
  const fromBackend = backendAnswer(method, params, c);
  if (fromBackend !== undefined) {
    reply(id, fromBackend);
    return;
  }
  switch (method) {
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
