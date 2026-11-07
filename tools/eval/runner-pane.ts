// One AUT run in a pane: claude, codex, cursor-agent or Muse Code as the orchestrator, started the
// way a user starts one (`mu orchestrate --cli <harness>` on the sandbox's tmux server; a
// cursor-agent or Muse AUT with the trust and approval flags of harness.ts AUT_FLAGS), prompted
// through mu's own hooks send (paste, confirmed by run count), and watched through murmur's view of
// its pane. The pi AUT keeps its rpc runner (runner.ts).
//
// Ready to prompt: claude and cursor-agent report their session at launch, so the runner waits for
// it; codex and Muse report one only with their first prompt, so the runner sends once no trust
// dialog is up.
//
// What the run observes is what murmur reports for the pane (its turns, its last text) and the
// mu-call record of the sandbox shim. A pane AUT has no token stream, so usage stays 0 and
// toolCalls stays empty: judges assert effects (observe.ts, provenance.ts, harness-observe.ts).
// Nothing counts its tokens either, so a scenario's tokenCap and matrix's --budget-tokens do not
// bound a pane AUT; only the timeout does.
//
// A scenario with a `replacement` crashes the orchestrator and starts a second one (`aut-2`) with
// the replacement prompt: in a fake run the AUT script's `{die}` step is the crash; in a live run
// the rig kills the AUT's harness process once `crashWhen` holds.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AUT_NAMES, STARTUP } from "./fake-payloads.ts";
import type { PaneHarness } from "./harness.ts";
import { muCalls } from "./observe.ts";
import { type ExecResult, mu, realTmux } from "./sandbox.ts";
import type { Aborted, LifecycleEvent, RunMetrics, Sandbox, Scenario } from "./types.ts";

export interface PaneRunOptions {
  harness: PaneHarness;
  /** Fake run: the AUT's faux step script (the fake harness reads it through <workers>/aut-script). */
  auTScript?: string;
  /** The orchestrator's pane command (`--command`); default: mu's own preset for the harness. */
  command?: string;
  timeoutMs?: number;
  quietMs?: number;
  maxProds?: number;
  /** JSONL of what the runner saw of the pane, for a failed run's post-mortem. */
  log?: string;
  /** A live run: the rig kills the AUT when a replacement's `crashWhen` holds (a fake one dies on `{die}`). */
  live?: boolean;
}

const TICK_MS = 500;

/** What murmur reports for the AUT's pane, as far as the runner needs it. */
export interface PaneView {
  activity: string | null;
  state: string | null;
  runCount: number | null;
  lastText: string | null;
  sessionId: string | null;
}

export function parsePaneJson(stdout: string): PaneView | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as { state?: unknown; agent?: unknown };
  const a =
    typeof d.agent === "object" && d.agent !== null ? (d.agent as Record<string, unknown>) : {};
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    state: s(d.state),
    activity: s(a.activity),
    runCount: typeof a.run_count === "number" ? a.run_count : null,
    lastText: s(a.last_text),
    sessionId: s(a.session_id),
  };
}

function murmurPane(sb: Sandbox, pane: string): PaneView | null {
  try {
    const out = execFileSync(
      join(sb.binDir, "murmur"),
      ["pane", pane, "--json", "-L", sb.tmuxSocket],
      {
        env: sb.env,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parsePaneJson(out);
  } catch {
    return null;
  }
}

function tmuxOut(sb: Sandbox, args: string[]): string | null {
  try {
    return execFileSync(realTmux(), ["-L", sb.tmuxSocket, ...args], {
      env: sb.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The pane's process, or null when the pane is gone or its process has exited. */
function panePid(sb: Sandbox, pane: string): number | null {
  const out = tmuxOut(sb, ["display-message", "-p", "-t", pane, "#{pane_dead} #{pane_pid}"]);
  if (out === null) return null;
  const [dead, pid] = out.split(" ");
  return dead === "1" ? null : Number(pid) || null;
}

const mtime = (f: string): number => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

/** Start one orchestrator pane; its pane id. */
async function orchestrate(
  sb: Sandbox,
  ws: string,
  name: string,
  o: PaneRunOptions,
): Promise<{ pane: string | null; r: ExecResult }> {
  const r = await mu(sb, [
    "orchestrate",
    "-w",
    ws,
    "--cli",
    o.harness,
    "--name",
    name,
    "--cwd",
    sb.repoDir,
    ...(o.command !== undefined ? ["--command", o.command] : []),
    "--json",
  ]);
  try {
    const doc = JSON.parse(r.stdout) as {
      agent?: { pane_id?: unknown };
      data?: { agent?: { pane_id?: unknown } };
    };
    const pane = (doc.data ?? doc).agent?.pane_id;
    return { pane: typeof pane === "string" ? pane : null, r };
  } catch {
    return { pane: null, r };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the pane runner does to the outside world; tests replace it (test/eval/runner-pane.test.ts). */
export interface PaneIO {
  /** `mu orchestrate`: a new orchestrator pane. */
  orchestrate(
    sb: Sandbox,
    ws: string,
    name: string,
    o: PaneRunOptions,
  ): Promise<{ pane: string | null; r: ExecResult }>;
  /** A mu call (the prompt's `mu agent send`). */
  mu(sb: Sandbox, args: string[]): Promise<ExecResult>;
  /** murmur's view of the pane. */
  view(sb: Sandbox, pane: string): PaneView | null;
  /** The pane's process, null when it is gone. */
  pid(sb: Sandbox, pane: string): number | null;
  capture(sb: Sandbox, pane: string): string | null;
  /** The pane's scrollback too (sandboxRefusal reads it); absent: not read. */
  scrollback?(sb: Sandbox, pane: string): string | null;
  keys(sb: Sandbox, pane: string, key: string): void;
  /** SIGKILL a pid or (negative) a process group. */
  kill(target: number): void;
  /** Newest change of a file (ms), 0 when it is missing. */
  mtime(file: string): number;
  sleep(ms: number): Promise<void>;
}

export const realPaneIO: PaneIO = {
  orchestrate,
  mu,
  view: murmurPane,
  pid: panePid,
  capture: (sb, pane) => tmuxOut(sb, ["capture-pane", "-p", "-t", pane]),
  scrollback: (sb, pane) => tmuxOut(sb, ["capture-pane", "-p", "-J", "-S", "-5000", "-t", pane]),
  keys: (sb, pane, key) => {
    tmuxOut(sb, ["send-keys", "-t", pane, key]);
  },
  kill: (target) => process.kill(target, "SIGKILL"),
  mtime,
  sleep,
};

/**
 * What a harness's own sandbox prints when it refuses a command: a seatbelt that cannot nest in a
 * launcher's (`sandbox_apply: Operation not permitted`, cursor-agent's `Failed to execute
 * sandbox-exec`), a write it denies (mu's DB, murmur's state and the tmux socket are outside the
 * sandbox repo, the harness's workspace).
 */
const SANDBOX_REFUSAL = [
  /sandbox_apply/,
  /Failed to execute sandbox-exec/,
  /sandbox-exec: /,
  /Operation not permitted/,
  /attempt to write a readonly database/,
];

/** The first line of a pane's text that shows a sandbox refusal (SANDBOX_REFUSAL), else null. */
export function sandboxRefusal(text: string): string | null {
  for (const l of text.split("\n"))
    if (SANDBOX_REFUSAL.some((re) => re.test(l))) return l.trim().slice(0, 200);
  return null;
}

/** How a run's lastError (and, in runOne, its notes) marks a failure of the environment. */
export const ENV_FAILURE = "environment:";

export const envFailure = (line: string): string =>
  `${ENV_FAILURE} the AUT's pane shows its own sandbox refusing a command (${JSON.stringify(line)}); a failed run may be the rig's environment, not the AUT (docs/eval/every-harness.md: EVAL_AUT_COMMAND)`;

export async function runPaneAut(
  sb: Sandbox,
  scenario: Scenario,
  o: PaneRunOptions,
  io: PaneIO = realPaneIO,
): Promise<RunMetrics> {
  const ws = scenario.workstream ?? "eval";
  const timeoutMs = o.timeoutMs ?? scenario.timeoutMs ?? 900_000;
  const quietMs = o.quietMs ?? scenario.quietMs ?? 30_000;
  const maxProds = o.maxProds ?? scenario.maxProds ?? 1;
  if (o.log) mkdirSync(dirname(o.log), { recursive: true });
  const note = (rec: Record<string, unknown>): void => {
    if (o.log) appendFileSync(o.log, `${JSON.stringify({ t: Date.now(), ...rec })}\n`);
  };
  if (o.auTScript !== undefined) writeFileSync(join(sb.workerDir, "aut-script"), o.auTScript);

  const events: LifecycleEvent[] = [];
  const started = Date.now();
  let aborted: Aborted = null;
  let lastError: string | null = null;
  let turns = 0;
  let prods = 0;
  let finalText = "";
  let refusal: string | null = null;
  // read once per quiet point, crash and timeout, until one shows
  const scanRefusal = (p: string): void => {
    if (refusal !== null || io.scrollback === undefined) return;
    refusal = sandboxRefusal(io.scrollback(sb, p) ?? "");
  };

  const start = async (name: string, prompt: string): Promise<string | null> => {
    const { pane, r } = await io.orchestrate(sb, ws, name, o);
    note({ orchestrate: name, pane, code: r.code, stderr: r.stderr.slice(0, 500) });
    if (pane === null) {
      lastError = `mu orchestrate ${name} failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`;
      return null;
    }
    // a harness that reports its session at launch is ready when it has; each trust dialog in
    // front of it (claude's folder trust; codex's folder trust, then its hook review) is answered
    // with the trusting choice (trustDialogKeys), at most 3, never twice on the same screen
    let answered = 0;
    let lastScreen = "";
    let lastAt = -1;
    for (let i = 0; i < 60; i++) {
      const v = io.view(sb, pane);
      if (v?.sessionId) break;
      const screen = i >= 4 && answered < 4 ? (io.capture(sb, pane) ?? "") : "";
      // the same dialog still up 10 ticks after an answer lost its keys: answer it again
      const fresh = screen !== lastScreen || (lastAt >= 0 && i - lastAt >= 10);
      const trustKeys = screen !== "" && fresh ? trustDialogKeys(screen) : null;
      if (trustKeys !== null) {
        for (const k of trustKeys) io.keys(sb, pane, k);
        answered++;
        lastScreen = screen;
        lastAt = i;
        note({ trustDialog: name, keys: trustKeys });
      }
      // codex and Muse report their session only with their first prompt: ready once no dialog is up
      if (
        STARTUP[o.harness] === "first-prompt" &&
        i >= 8 &&
        trustKeys === null &&
        trustDialogKeys(screen) === null
      )
        break;
      await io.sleep(TICK_MS);
    }
    await send(name, prompt);
    return pane;
  };

  const send = async (name: string, text: string): Promise<void> => {
    events.push({ t: Date.now(), kind: "prompt", text });
    let r = await io.mu(sb, ["agent", "send", name, "-w", ws, text, "--json"]);
    if (r.code !== 0) {
      await io.sleep(2000);
      r = await io.mu(sb, ["agent", "send", name, "-w", ws, text, "--force", "--json"]);
    }
    note({ send: name, code: r.code, out: r.stdout.slice(0, 300), err: r.stderr.slice(0, 300) });
  };

  const names = [...AUT_NAMES];
  let current = names.shift() ?? "aut";
  let pane = await start(current, scenario.prompt);
  let replaced = false;
  let lastSeen = "";
  let lastActivity = Date.now();
  let wasRunning = false;
  const activityFiles = ["mu-calls.log", "hooks.log", "runs.log"].map((f) => join(sb.workerDir, f));

  while (pane !== null) {
    await io.sleep(TICK_MS);
    const now = Date.now();
    if (now - started > timeoutMs) {
      scanRefusal(pane);
      aborted = "timeout";
      break;
    }
    const pid = io.pid(sb, pane);
    const crashNow =
      scenario.replacement !== undefined &&
      !replaced &&
      (pid === null ||
        (o.live === true &&
          scenario.replacement.crashWhen !== undefined &&
          (await scenario.replacement.crashWhen(sb))));
    if (crashNow && scenario.replacement !== undefined) {
      if (pid !== null) {
        scanRefusal(pane);
        // the pane's process group: a launcher and the binary it started die together
        for (const target of [-pid, pid]) {
          try {
            io.kill(target);
          } catch {
            // already gone, or not a group leader
          }
        }
      }
      note({ crash: current, pid });
      replaced = true;
      current = names.shift() ?? "aut-2";
      lastSeen = "";
      wasRunning = false;
      pane = await start(current, scenario.replacement.prompt);
      lastActivity = Date.now();
      continue;
    }
    if (pid === null) {
      aborted = "exit";
      break;
    }
    const v = io.view(sb, pane);
    const seen = JSON.stringify(v);
    if (seen !== lastSeen) {
      note({ pane: current, view: v });
      lastSeen = seen;
      lastActivity = now;
    }
    for (const f of activityFiles) lastActivity = Math.max(lastActivity, io.mtime(f));
    const running = v?.activity === "running";
    if (wasRunning && !running) {
      turns++;
      events.push({ t: now, kind: "agent_end" });
      if (v?.lastText) {
        finalText = v.lastText;
        events.push({ t: now, kind: "assistant_text", text: v.lastText });
      }
    }
    wasRunning = running;
    if (running || v?.state === "blocked" || now - lastActivity < quietMs) continue;
    scanRefusal(pane);
    const soFar = metrics();
    const verdict = await scenario.judge(sb, soFar);
    if (!verdict.completed && prods < maxProds) {
      prods++;
      await send(current, "carry on");
      lastActivity = Date.now();
      continue;
    }
    break;
  }
  if (pane === null && aborted === null) aborted = "exit";

  function metrics(): RunMetrics {
    const calls = muCalls(sb);
    return {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
      turns,
      toolCalls: [],
      muCalls: calls.length,
      muErrors: calls.filter((c) => c.exit !== 0).length,
      prods,
      wallMs: Date.now() - started,
      aborted,
      lastError: lastError ?? (refusal !== null ? envFailure(refusal) : null),
      finalText,
      events: [...events],
    };
  }
  note({ end: aborted, turns, prods, aut: current, script: o.auTScript ?? null });
  if (o.log && existsSync(sb.workerDir)) note({ muCalls: muCalls(sb).length });
  return metrics();
}

/**
 * The keys that answer a trust dialog with "trust", or null when the pane shows none. A dialog is
 * a selector (a line led by ❯ or ›) with a trusting option: Claude Code's "Yes, I trust this
 * folder" (its cursor starts on "No, exit" when the folder's settings pre-approve tools, as the
 * rig's do), codex's folder "Yes, continue" or "Trust and continue" and its hook review's "Trust all
 * and continue" (its
 * cursor starts on "Review hooks"). The keys move the cursor to that option, then Enter.
 */
export function trustDialogKeys(screen: string): string[] | null {
  if (!/trust/i.test(screen)) return null;
  const lines = screen.split("\n");
  const cursor = lines.findIndex((l) => /^\s*[❯›]\s/.test(l));
  const target = lines.findIndex((l) =>
    /yes, i trust|trust (all )?and continue|^\s*[❯›]?\s*(\d+\.\s*)?yes, (continue|allow)/i.test(l),
  );
  if (cursor < 0 || target < 0) return null;
  const move = target - cursor;
  return [...Array<string>(Math.abs(move)).fill(move > 0 ? "Down" : "Up"), "Enter"];
}
