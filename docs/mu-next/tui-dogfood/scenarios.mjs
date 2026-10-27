// Seeds one dogfood scenario into the DB named by $MU_DB_PATH, and spawns its fake
// workers on the private tmux socket ($MU_TMUX_SOCKET). Run by run.sh; not a mu API.
//   node scenarios.mjs <1..7>      seed scenario N
//   node scenarios.mjs driver      the scenario-6 mutator: one change every few seconds, until killed
// Needs the built checkout: $MU_DOGFOOD_REPO/dist (index.js SDK + cli.js).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.MU_DOGFOOD_REPO ?? join(HERE, "..", "..", "..");
const CLI = join(REPO, "dist", "cli.js");
const mu = await import(pathToFileURL(join(REPO, "dist", "index.js")).href);
const db = mu.openDb({ path: process.env.MU_DB_PATH });

// ── helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (...args) =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Add a task: T(ws, id, title, { by: [ids], note, impact, effort, triage }). */
function T(ws, id, title, o = {}) {
  mu.addTask(db, {
    localId: id, workstream: ws, title,
    ...(o.by ? { blockedBy: o.by } : {}),
    ...(o.impact ? { impact: o.impact } : {}),
    ...(o.effort ? { effortDays: o.effort } : {}),
    ...(o.triage ? { triage: true } : {}),
  });
  if (o.note) mu.addNote(db, id, o.note, { workstream: ws, author: o.author ?? "orchestrator" });
}
const note = (ws, id, text, author = "orchestrator") => mu.addNote(db, id, text, { workstream: ws, author });
const claim = (ws, id, agent) => mu.claimTask(db, id, { workstream: ws, agentName: agent });
const close = (ws, id, evidence, author = "orchestrator") =>
  mu.closeTask(db, id, { workstream: ws, evidence, author });

/** A real tmux pane running the fake worker (see fake-worker.mjs for the profiles). */
function worker(ws, name, profile, extra = [], banner = "") {
  const cmd = `node ${join(HERE, "fake-worker.mjs")} --profile ${profile}${banner ? ` --banner ${banner}` : ""}`;
  cli("agent", "spawn", name, "-w", ws, "--cli", "pi", "--command", cmd, ...extra);
}
const initWs = (name) => cli("workstream", "init", name);

// ── 1: empty / first run ──────────────────────────────────────────────────────
function s1() {
  // Nothing: a brand-new DB. (The launcher already created it by opening it.)
}

// ── 2: small healthy crew ─────────────────────────────────────────────────────
function s2() {
  const ws = "shop-api";
  initWs(ws);
  T(ws, "schema", "Design the v2 order schema", { impact: 80, effort: 0.5 });
  T(ws, "auth", "Token auth for the v2 endpoints", { by: ["schema"], impact: 90, effort: 2 });
  T(ws, "migrate", "Write and rehearse the v1 to v2 data migration", { by: ["schema"], impact: 70, effort: 1.5 });
  T(ws, "docs", "Document the v2 API (OpenAPI + guide page)", { impact: 40, effort: 1 });
  T(ws, "api_v2", "Implement the v2 order endpoints", { by: ["schema", "auth"], impact: 95, effort: 3 });
  T(ws, "perf", "Profile the order list query (p99 over 800 ms)", { impact: 60, effort: 0.5 });
  T(ws, "cleanup", "Delete the dead v0 handlers", { impact: 20, effort: 0.3 });
  T(ws, "flaky", "Triage: orders_test flakes 1 in 20 on CI", { triage: true, impact: 50, effort: 0.5 });
  T(ws, "release", "Release v2 to staging", { by: ["api_v2", "docs", "migrate"], impact: 100, effort: 0.5 });
  note(ws, "auth", "Read: mu task show auth -w shop-api. Use the existing session middleware; do not add a dependency.");
  note(ws, "api_v2", "Waiting on schema and auth. Keep the v1 routes untouched.");
  note(ws, "perf", "Start from `EXPLAIN QUERY PLAN` on the list query.");
  mu.parkTask(db, "cleanup", { workstream: ws, why: "after v2 ships, not before" });
  close(ws, "schema", "reviewed by orchestrator: migrations/0042_orders_v2.sql, tests green");
  worker(ws, "worker-1", "busy");
  worker(ws, "worker-2", "busy");
  worker(ws, "worker-3", "legacy"); // an extension that predates the tool field: "tool ?"
  claim(ws, "auth", "worker-1");
  claim(ws, "migrate", "worker-2");
  claim(ws, "docs", "worker-3");
  note(ws, "auth", "progress: middleware wired, 14/22 tests pass", "worker-1");
  note(ws, "migrate", "progress: dry run on the 10k-row fixture took 3.2 s", "worker-2");
  cli("task", "auto", "perf", "-w", ws, "--cli", "pi"); // gives the Next line something to say

  const web = "shop-web";
  initWs(web);
  T(web, "cart", "Cart page: show v2 totals", { impact: 70, effort: 1 });
  T(web, "e2e", "Playwright smoke for checkout", { by: ["cart"], impact: 50, effort: 1 });
  T(web, "css", "Fix the mobile header overflow", { impact: 30, effort: 0.2 });
  worker(web, "reviewer-1", "idle");
  note(web, "css", "Spotted by the reviewer; one-line fix.", "reviewer-1");
}

// ── 3: a wave of delegates, mid-flight and finished ───────────────────────────
function s3() {
  const ws = "hail-cache";
  initWs(ws);
  T(ws, "evict", "Fix the LRU eviction under memory pressure", { impact: 90, effort: 1 });
  T(ws, "ttl", "Per-key TTL for the session cache", { impact: 60, effort: 1 });
  T(ws, "warm", "Warm the cache on deploy", { impact: 40, effort: 1 });
  let n = 0;
  const call = (label, state, record, wave = "refute-1") => {
    const callId = `pi:dogfood:${++n}`;
    mu.registerDelegateCall(db, {
      callId, caller: "pi:dogfood", workstream: "scratch", wave,
      state: state === "queued" || state === "refused" ? state : "starting",
      request: { text: `Refute: ${label}. Reply with a VERDICT: line first.`, label },
      ...(record ? { record: { workstream: ws, task: record } } : {}),
    });
    return callId;
  };
  const done = (id, agent, text) => {
    mu.markDelegate(db, id, "running", { agent });
    mu.finishDelegate(db, id, { outcome: "done", text, author: agent, elapsedMs: 4 * 60e3 + 12e3 });
  };
  done(call("evict-claim-1", "done", "evict"), "delegate-evict-claim-1",
    "VERDICT: CONFIRMED\nEVIDENCE: lru.ts:88 pops before the size check, so the bound is exceeded by one.");
  done(call("evict-claim-2", "done", "evict"), "delegate-evict-claim-2",
    "VERDICT: REFUTED\nEVIDENCE: the pop on lru.ts:88 is guarded two lines above; test/lru.test.ts:41 covers it.");
  done(call("evict-claim-3", "done", "evict"), "delegate-evict-claim-3",
    "I read the code and it seems fine, but I did not run the tests.\n(no verdict line: counted UNVERIFIED)");
  done(call("ttl-claim-1", "done", "ttl"), "delegate-ttl-claim-1",
    "VERDICT: CONFIRMED\nEVIDENCE: ttl is stored per cache, not per key (cache.ts:12).");
  const failed = call("ttl-claim-2", "failed", "ttl");
  mu.markDelegate(db, failed, "running", { agent: "delegate-ttl-claim-2" });
  mu.finishDelegate(db, failed, { outcome: "died", text: "pane gone after 40 s: out of memory", author: "delegate-ttl-claim-2", record: false });
  const cancelled = call("warm-claim-1", "cancelled", "warm");
  mu.markDelegate(db, cancelled, "running", { agent: "delegate-warm-claim-1" });
  mu.finishDelegate(db, cancelled, { outcome: "cancelled", text: "cancelled by the caller", author: "pi:dogfood", record: false });
  // Mid-flight: two running with real panes, one queued, one refused past the queue.
  for (const [label, rec] of [["warm-claim-2", "warm"], ["evict-claim-4", "evict"]]) {
    const id = call(label, "running", rec);
    const agent = `delegate-${label}`;
    worker("scratch", agent, "busy");
    mu.markDelegate(db, id, "running", { agent });
    claim("scratch", mu.getDelegateCall(db, id).task, agent);
  }
  call("ttl-claim-3", "queued", "ttl");
  call("evict-claim-5", "refused", "evict");
  // A second, unrelated wave with no record target.
  const lone = call("survey-flags", "done", undefined, "survey");
  done(lone, "delegate-survey-flags", "VERDICT: UNVERIFIED\nEVIDENCE: could not reproduce.");
}

// ── 4: trouble ────────────────────────────────────────────────────────────────
function s4() {
  const ws = "payments";
  initWs(ws);
  T(ws, "ledger", "Ledger double-entry invariants", { impact: 95, effort: 2 });
  T(ws, "refunds", "Partial refunds", { by: ["ledger"], impact: 80, effort: 2 });
  T(ws, "webhooks", "Retry webhooks with backoff", { impact: 70, effort: 1 });
  T(ws, "fx", "FX rounding policy", { impact: 60, effort: 1 });
  T(ws, "audit", "Audit log export", { impact: 40, effort: 1 });
  T(ws, "legal", "Terms wording for refunds", { impact: 50, effort: 0.5 });
  T(ws, "old", "Drop the legacy gateway", { impact: 30, effort: 1 });
  T(ws, "dup", "Same as webhooks", { impact: 30, effort: 1 });
  T(ws, "idea", "Triage: add Apple Pay?", { triage: true });
  worker(ws, "worker-1", "busy");
  worker(ws, "worker-2", "stalled"); // one bash tool for 3 h
  worker(ws, "worker-3", "blocked"); // confirm dialog open for 20 min
  worker(ws, "worker-4", "busy"); // killed below: a dead worker
  claim(ws, "ledger", "worker-1");
  claim(ws, "webhooks", "worker-2");
  claim(ws, "fx", "worker-3");
  claim(ws, "audit", "worker-4");
  note(ws, "webhooks", "progress: retry loop written, running the integration suite", "worker-2");
  note(ws, "webhooks",
    'no close (malformed): the line after CLOSE: is not exactly REPORT:', "worker-2");
  note(ws, "fx", "dialog: Run `rm -rf build/`? (waiting 20 min)", "worker-3");
  mu.closeTask(db, "old", { workstream: ws, as: "wontfix", why: "gateway contract ends in Q3 anyway" });
  mu.closeTask(db, "dup", { workstream: ws, as: "duplicate", why: "same as webhooks" });
  mu.recordHumanNeeded(db, {
    workstream: ws, caller: "pi:dogfood",
    reason: "Decide the FX rounding policy: banker's rounding (matches the bank) or half-up (matches the invoices)? worker-3 is blocked on it.",
  });
  mu.parkTask(db, "legal", { workstream: ws, why: "waiting for counsel" });
  // Kill worker-4's window last: the row stays, the pane is gone.
  const sock = process.env.MU_TMUX_SOCKET;
  execFileSync("tmux", ["-L", sock, "kill-window", "-t", "mu-payments:worker-4"]);
}

// ── 5: big ────────────────────────────────────────────────────────────────────
function s5() {
  const ws = "monorepo";
  initWs(ws);
  const words = "refactor migrate harden extract inline rename split merge audit profile benchmark document stabilise".split(" ");
  const things = "scheduler allocator parser lexer renderer tokenizer cache index resolver linker planner optimizer".split(" ");
  const long = (i) =>
    `${words[i % words.length]} the ${things[(i * 7) % things.length]} so that ${things[(i * 3) % things.length]} no longer depends on ${things[(i * 5) % things.length]} internals, ` +
    "keeping every public signature stable, adding regression tests for each edge case found in the last three incidents, and updating the guide page and the changelog entry as we go";
  const ids = [];
  for (let i = 0; i < 200; i++) {
    const id = i === 7 ? "a_very_long_task_id_that_goes_on_and_on_to_cut_the_id_column_off" : `t${String(i).padStart(3, "0")}`;
    let title;
    if (i % 17 === 0) title = long(i);
    else if (i === 3) title = "日本語のタイトル: 全角文字の幅を確かめる (wide characters) 🚀🔥 émoji and àccents";
    else if (i === 5) title = "ANSI \u001b[31mred\u001b[0m and a\ttab and trailing spaces    ";
    else if (i === 9) title = "x".repeat(400);
    else title = `${words[i % words.length]} ${things[(i * 7) % things.length]} (${i})`;
    // A layered DAG: each task depends on one or two tasks from the previous 10.
    const by = [];
    if (i >= 10 && i % 3 !== 0) by.push(ids[i - 10 + (i % 4)]);
    if (i >= 20 && i % 5 === 0) by.push(ids[i - 15]);
    T(ws, id, title, { by: [...new Set(by)], impact: 10 + ((i * 37) % 90), effort: 0.2 + ((i * 13) % 30) / 10 });
    ids.push(id);
  }
  for (let i = 0; i < 12; i++) note(ws, ids[i], `note ${i}: ${"a long line of prose that should wrap or cut cleanly in the notes drill, ".repeat(6)}`);
  for (let k = 0; k < 60; k++) note(ws, ids[1], `status ping ${k}: still going, ${k * 3} files touched`, "worker-1");
  note(ws, ids[2], `${"a 5 KB brief: ".padEnd(5000, "lorem ipsum dolor sit amet ")}`);
  note(ws, ids[4], "line one\nline two\n\n  indented line four\nline five (multi-line note)");
  const profiles = ["busy", "busy", "busy", "legacy", "idle", "churn", "churn", "stalled", "blocked", "busy"];
  for (let a = 1; a <= 10; a++) worker(ws, `worker-${a}`, profiles[a - 1]);
  // A little closed history (hidden by the default `active` filter; `s` shows it), then claims.
  // The claimed ones are the odd-title tasks and the many-notes ones, so they sit in view.
  for (const i of [0, 6, 8]) close(ws, ids[i], `ran suite ${i}: ok`);
  [1, 2, 3, 4, 5, 7, 9].forEach((i, k) => claim(ws, ids[i], `worker-${k + 1}`));
  // Workstreams with long names, so the picker line has to scroll.
  for (const n of ["infra-observability-rewrite", "docs-site-new-generator-move", "mobile-offline-sync-engine", "billing-tax-rules-2027"]) {
    T(n, "a", `first task of ${n}`);
    T(n, "b", "second", { by: ["a"] });
  }
}

// ── 6: live ───────────────────────────────────────────────────────────────────
function s6() {
  const ws = "live-demo";
  initWs(ws);
  for (let i = 1; i <= 8; i++) T(ws, `seed${i}`, `Seed task ${i}`, { by: i > 2 ? [`seed${i - 2}`] : [], impact: 20 + i * 5 });
  for (let a = 1; a <= 3; a++) worker(ws, `worker-${a}`, "churn");
  claim(ws, "seed1", "worker-1");
  claim(ws, "seed2", "worker-2");
}
// The mutator: kept running by run.sh, killed at exit. It never closes seed1: the live smoke keeps a notes drill open on it.
async function driver() {
  const ws = "live-demo";
  let n = 100;
  const open = () => db.prepare(
    `SELECT t.local_id AS id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
      WHERE w.name = ? AND t.status = 'OPEN' AND t.substate = 'todo'`).all(ws).map((r) => r.id);
  const mine = () => db.prepare(
    `SELECT t.local_id AS id, a.name AS owner FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
       JOIN agents a ON a.id = t.owner_id WHERE w.name = ? AND t.status = 'IN_PROGRESS'`).all(ws);
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  for (;;) {
    await sleep(2000 + Math.random() * 3000);
    try {
      const r = Math.random();
      if (r < 0.3) T(ws, `new${++n}`, `Task created at ${new Date().toTimeString().slice(0, 8)}`, { impact: 10 + Math.floor(Math.random() * 90) });
      else if (r < 0.55 && open().length) await claim(ws, pick(open()), `worker-${1 + Math.floor(Math.random() * 3)}`);
      else if (r < 0.8 && mine().length) { const t = pick(mine()); note(ws, t.id, `progress ${new Date().toTimeString().slice(0, 8)}`, t.owner); }
      else if (mine().some((t) => t.id !== "seed1")) { const t = pick(mine().filter((t) => t.id !== "seed1")); close(ws, t.id, "ran tests: ok", t.owner); }
    } catch (e) { /* blocked, owned, gone: the next tick tries again */ }
  }
}

// ── 7: a remote host agent (simulated) ────────────────────────────────────────
function s7() {
  const ws = "remote-demo";
  initWs(ws);
  const dir = join(dirname(process.env.MU_DB_PATH), "remote-cwd");
  mkdirSync(dir, { recursive: true });
  cli("host", "add", "dev",
    "--shell", `exec node ${join(HERE, "fake-ssh.mjs")} {local_sock} {remote_sock} {cwd} -- {env} {cmd}`,
    "--exec", "sh -c {cmd}", "--fetch", "true", "--repo", dir, "--max-sessions", "2");
  T(ws, "remote_build", "Build on the big machine", { impact: 70, effort: 1 });
  T(ws, "local_check", "Check on this machine", { impact: 50, effort: 1 });
  // Banners say where each pane runs; the profiles differ too (busy vs waiting for input), so
  // the two rows and the two panes cannot be mistaken for each other.
  const cmd = `node ${join(HERE, "fake-worker.mjs")} --profile busy --banner remote:dev`;
  cli("agent", "spawn", "worker-1", "-w", ws, "--cli", "pi", "--host", "dev", "--cwd", dir, "--command", cmd);
  worker(ws, "worker-2", "idle", [], "local"); // a local one next to it, for contrast
  claim(ws, "remote_build", "worker-1");
  claim(ws, "local_check", "worker-2");
}

const table = { 1: s1, 2: s2, 3: s3, 4: s4, 5: s5, 6: s6, 7: s7 };
const arg = process.argv[2];
if (arg === "driver") await driver();
else if (table[arg]) {
  await table[arg]();
  db.close();
} else {
  console.error("usage: scenarios.mjs <1..7>|driver");
  process.exit(2);
}
