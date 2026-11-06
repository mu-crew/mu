// A fake claude, codex, cursor-agent or Muse Code for `check`: a terminal program that reads its
// pane like the real one and fires the real one's hooks, from the real one's config files, with
// the real one's payloads (fake-payloads.ts). mu, murmur, muzzle and the eval observer hook run for
// real; only the model is scripted, with the faux step format (faux-steps.ts), so every judge is
// proven at zero model cost through the same hook path a live run takes.
//
// Started as `node <dir>/<harness>.mjs` (a stub that imports this file, so `ps` shows an argv
// murmur reads as that harness), or `node fake-harness.ts <harness>`.
//
// - Script: a worker loads <workers>/<agent>[.<n>].json or default.json (as a faux pi does); the
//   AUT (MU_AGENT_NAME aut or aut-2) loads the file named in <workers>/aut-script, the second AUT
//   only the steps after the first `{die}` (the replacement after a crash).
// - Input: bracketed paste is text, C-u clears the line, Enter submits, Escape interrupts a turn.
//   claude puts an interrupted prompt back in the line (U0), so an unclear paste merges into it.
// - A turn runs steps until a text, then fires the stop event; a block continues the turn with
//   its reason (Muse re-checks once and ignores the reason, D6). `{die}` is a crash: SIGKILL, no
//   events. `{error}` fires the failure event where the harness has one.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AUT_NAMES,
  cursorResponse,
  type FakeEvent,
  type FakeHarness,
  FRESH,
  handlersFor,
  hookEnv,
  hookFiles,
  isFakeHarness,
  LineEditor,
  NATIVE,
  newSessionId,
  type PayloadCtx,
  payload,
  type Reply,
  readReply,
  SHAPE,
  SHELL_TOOL,
  STARTUP,
} from "./fake-payloads.ts";
import { autPhaseSteps, FauxScript, loadAutScript, loadWorkerScript } from "./faux-steps.ts";

function harnessName(): FakeHarness {
  const fromStub = basename(process.argv[1] ?? "").replace(/\.(mjs|js|ts)$/, "");
  const name = isFakeHarness(fromStub) ? fromStub : (process.argv[2] ?? "");
  if (!isFakeHarness(name)) {
    console.error(`fake-harness: unknown harness ${JSON.stringify(name)}`);
    process.exit(2);
  }
  return name;
}

const h = harnessName();
const env = process.env;
const workerDir = env.EVAL_WORKER_DIR ?? null;
const agent = env.MU_AGENT_NAME ?? "-";
const isAut = (AUT_NAMES as readonly string[]).includes(agent);
const cwd = process.cwd();
const home = env.HOME ?? cwd;
const projectRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
})();

function debug(line: string): void {
  if (workerDir === null) return;
  try {
    appendFileSync(join(workerDir, "fake-harness.log"), `${Date.now()} ${agent} ${h} ${line}\n`);
  } catch {
    // a debug line never stops a turn
  }
}

function loadScript(): FauxScript {
  if (workerDir === null) return new FauxScript([{ text: "(no worker dir)" }], null, agent);
  if (isAut) {
    const file = join(workerDir, "aut-script");
    const path = existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
    const steps = autPhaseSteps(loadAutScript(path), agent === "aut" ? 1 : 2);
    return new FauxScript(steps, workerDir, "aut");
  }
  return new FauxScript(loadWorkerScript(workerDir, agent), workerDir, agent);
}

const script = loadScript();
const editor = new LineEditor();
let sessionId = newSessionId(h);
let started = false;
let turnId = newSessionId(h);
let promptsInSession = 0;
let running = false;
let aborted = false;
let child: ReturnType<typeof spawn> | null = null;
const queue: string[] = [];

function ctx(extra: Partial<PayloadCtx> = {}): PayloadCtx {
  return { sessionId, turnId, cwd, home, model: "fake-model", ...extra };
}

function readDoc(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Every handler the harness's config files hold for a native event, in run order. */
function handlers(name: string, tool: string | null) {
  return hookFiles(h, { projectRoot, home, codexHome: env.CODEX_HOME }).flatMap((f) =>
    handlersFor(SHAPE[h], readDoc(f.path), name, tool),
  );
}

function runHook(
  command: string,
  body: string,
  timeoutS: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", command], { cwd, env: hookEnv(h, env), stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    p.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    p.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutS * 1000);
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(body);
  });
}

/** Fire one event through every matching handler; the replies of the ones the harness waits for. */
async function fire(
  event: FakeEvent,
  extra: Partial<PayloadCtx> = {},
  body?: Record<string, unknown>,
): Promise<Reply[]> {
  const name = body ? String(body.hook_event_name) : NATIVE[h][event];
  if (name === null) return [];
  const doc = body ?? payload(h, event, ctx(extra));
  const text = JSON.stringify(doc);
  const tool = event === "pre_tool" ? SHELL_TOOL[h] : null;
  const replies: Reply[] = [];
  for (const hd of handlers(name, tool)) {
    if (hd.async) {
      const p = spawn("sh", ["-c", hd.command], {
        cwd,
        env: hookEnv(h, env),
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      });
      p.stdin?.on("error", () => {});
      p.stdin?.end(text);
      p.unref();
      continue;
    }
    const r = await runHook(hd.command, text, hd.timeout);
    const reply = readReply(h, event, r);
    debug(`${name} exit=${r.code} ${reply.kind}`);
    replies.push(reply);
  }
  return replies;
}

/** Fire synchronously (the process is going away): the session's end. */
function fireSync(event: FakeEvent, extra: Partial<PayloadCtx>): void {
  const name = NATIVE[h][event];
  if (name === null) return;
  const text = JSON.stringify(payload(h, event, ctx(extra)));
  for (const hd of handlers(name, null)) {
    spawnSync("sh", ["-c", hd.command], {
      cwd,
      env: hookEnv(h, env),
      input: text,
      timeout: Math.min(hd.timeout, 10) * 1000,
      stdio: ["pipe", "ignore", "ignore"],
    });
  }
}

async function startSession(source: string): Promise<void> {
  started = true;
  promptsInSession = 0;
  await fire("session_start", { source });
}

/** Run one shell command as the harness's tool would, after its tool hook. */
async function shell(command: string): Promise<string> {
  let cmd = command;
  for (const r of await fire("pre_tool", { command })) {
    if (r.kind === "deny") return `(${h} refused the command: ${r.reason})`;
    if (r.kind === "rewrite") cmd = r.command;
  }
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", cmd], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child = p;
    let out = "";
    p.stdout?.setEncoding("utf8").on("data", (d: string) => {
      out += d;
    });
    p.stderr?.setEncoding("utf8").on("data", (d: string) => {
      out += d;
    });
    p.on("error", (e) => {
      child = null;
      resolve(`${out}${e.message}`);
    });
    p.on("close", (code) => {
      child = null;
      resolve(code === 0 ? out : `${out}\n(exit ${code})`);
    });
  });
}

function show(prefix: string, text: string): void {
  const lines = text.replace(/\s+$/, "").split("\n");
  const shown =
    lines.length > 12 ? [...lines.slice(0, 12), `… (${lines.length - 12} more)`] : lines;
  process.stdout.write(`${shown.map((l, i) => `${i === 0 ? prefix : "  "}${l}`).join("\r\n")}\r\n`);
}

/** Continuations a Stop block may cause in a row before the fake gives up (a real model would too). */
const MAX_CONTINUES = 25;

async function turn(prompt: string): Promise<void> {
  running = true;
  aborted = false;
  turnId = newSessionId(h);
  if (!started) await startSession("startup");
  promptsInSession++;
  await fire("prompt", { prompt });
  show("> ", prompt);
  let lastResult: string | null = null;
  const results: string[] = [];
  let resumed = false;
  let continues = 0;
  let lastText = "";
  for (;;) {
    const action = script.next({
      lastUser: prompt,
      lastResult,
      results,
      messages: promptsInSession,
    });
    if (aborted) return;
    if (action.kind === "die") {
      debug("die");
      process.kill(process.pid, "SIGKILL");
      return;
    }
    if (action.kind === "error") {
      show("! ", action.message);
      await fire("failed", { lastText: null });
      running = false;
      return;
    }
    if (action.kind === "calls") {
      for (const c of action.calls) {
        const cmd = typeof c.args.command === "string" ? c.args.command : "";
        const out =
          c.name === "bash" ? await shell(cmd) : `(${c.name} is not a ${h} tool; nothing ran)`;
        if (aborted) return;
        show("$ ", c.name === "bash" ? cmd : c.name);
        show("  ", out);
        lastResult = out;
        results.push(out);
      }
      continue;
    }
    // a continuation past the end of the script repeats the turn's answer, as a model would
    const text = resumed && action.text === "(script exhausted)" ? lastText : action.text;
    lastText = text;
    show("● ", text);
    if (h === "cursor-agent") await fire("stop", {}, cursorResponse(ctx({ lastText: text })));
    const replies = await fire("stop", { lastText: text, resumed, status: "completed" });
    const block = replies.find((r): r is Extract<Reply, { kind: "block" }> => r.kind === "block");
    if (block === undefined || continues >= MAX_CONTINUES) break;
    continues++;
    show("↻ ", block.reason);
    if (h === "muse") {
      // Muse re-checks the answer on a block and does not follow the reason (D6)
      await fire("stop", { lastText: text, resumed: true });
      break;
    }
    resumed = true;
    lastResult = block.reason;
  }
  running = false;
}

async function interrupt(): Promise<void> {
  if (!running) return;
  aborted = true;
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  running = false;
  show("■ ", "interrupted");
  if (h === "claude") {
    // claude puts the interrupted prompt back in its input box (U0)
    const last = workerDir ? readLast() : "";
    editor.line = last;
  }
  if (NATIVE[h].interrupt !== null) await fire("interrupt", { status: "aborted" });
}

function readLast(): string {
  const f = join(workerDir ?? "", `last-prompt.${isAut ? "aut" : agent}`);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

async function fresh(): Promise<void> {
  if (h === "claude" || h === "cursor-agent") {
    await fire("session_end", { reason: "clear" });
    sessionId = newSessionId(h);
    await startSession("clear");
    return;
  }
  // codex and muse report the new session with its first prompt
  sessionId = newSessionId(h);
  started = false;
  promptsInSession = 0;
}

async function submit(text: string): Promise<void> {
  if (text.trim() === FRESH[h]) {
    if (!running) await fresh();
    return;
  }
  if (running) {
    queue.push(text);
    return;
  }
  await turn(text);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) await turn(next);
}

let ending = false;
function end(): void {
  if (ending) return;
  ending = true;
  // a tool still running goes with the harness (it runs in its own process group)
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    if (started || STARTUP[h] === "immediate") fireSync("session_end", { reason: "other" });
  } finally {
    process.exit(0);
  }
}

async function main(): Promise<void> {
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(sig, end);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?2004h");
  process.stdout.write(`fake ${h} (${isAut ? "orchestrator" : "worker"} ${agent}) in ${cwd}\r\n`);
  if (STARTUP[h] === "immediate") await startSession("startup");
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8").on("data", (chunk: string) => {
    for (const key of editor.feed(chunk)) {
      if (key.kind === "escape") void interrupt();
      else if (key.kind === "submit") chain = chain.then(() => submit(key.text));
    }
  });
  process.stdin.on("end", end);
}

void main();
