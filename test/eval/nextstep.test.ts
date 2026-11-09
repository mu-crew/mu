// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The next-step probe's own rules (tools/eval/nextstep*.ts, spec §1.2-1.5): extraction, the
// transcript, "printed" (shown / shownLine), the answer-window adapter and the timed rule, the go
// gate and the orchestrator env, the lint, execGuess's shell, the evalfaux short-circuit and the
// report. A fake sandbox: a temp dir with the real mu shim in front of a stub CLI, no tmux, no git.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askModel, execGuess } from "../../tools/eval/cold-guess.ts";
import {
  armText,
  decideHit,
  extractCommands,
  HELP_BUDGET,
  helpArmProblem,
  helpBlock,
  helpPaths,
  type NextCase,
  type NextCtx,
  nextLint,
  nextLintVocab,
  type ProbeRow,
  systemPromptFor,
} from "../../tools/eval/nextstep.ts";
import {
  answerMetrics,
  idleAnswers,
  renderTranscript,
  runAnswer,
  runLeadIn,
  shown,
  shownLine,
  timedViolations,
  unionMs,
} from "../../tools/eval/nextstep-exec.ts";
import { nextReport } from "../../tools/eval/nextstep-report.ts";
import { idleCalls, muCalls, muIn, pollingCalls } from "../../tools/eval/observe.ts";
import { muShim } from "../../tools/eval/sandbox.ts";
import type { Sandbox, Surface } from "../../tools/eval/types.ts";

let dir = "";

/** A sandbox with the real mu shim in front of a stub CLI that prints its args and PI_SESSION_ID. */
function fakeSandbox(): Sandbox {
  const sb: Sandbox = {
    dir,
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      HOME: join(dir, "home"),
      EVAL_WORKER_DIR: join(dir, "workers"),
      MU_DB_PATH: join(dir, "none.db"),
    },
    binDir: join(dir, "bin"),
    repoDir: join(dir, "repo"),
    workerDir: join(dir, "workers"),
    tmuxSocket: "none",
    dbPath: join(dir, "none.db"),
    surface: { name: "stub", root: dir, cli: "", extension: "", skillDir: "" },
    close: async () => {},
  };
  for (const d of ["bin", "home", "workers/mu-out", "repo"])
    mkdirSync(join(dir, d), { recursive: true });
  const cli = join(dir, "cli.mjs");
  writeFileSync(
    cli,
    [
      "const a = process.argv.slice(2);",
      'console.log("mu " + a.join(" ") + " session=" + (process.env.PI_SESSION_ID ?? "-"));',
      'if (a[0] === "fail") { console.error("boom on stderr"); process.exit(3); }',
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "bin", "mu"), muShim(cli), { mode: 0o755 });
  return sb;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nextstep-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---- synthetic answers: the shim's log written by hand ----------------------------------------

type Call = { start: number; end: number; pid: string; argv: string; out: string };
type Cmd = { cmd: string; start: number; end: number; stdout: string; code?: number };

function synth(cmds: Cmd[], calls: Call[]): NextCtx {
  const sb = fakeSandbox();
  writeFileSync(
    join(sb.workerDir, "mu-calls.log"),
    calls.map((c) => `${c.start} ${c.end} 0 - ${c.pid} ${c.argv}\n`).join(""),
  );
  for (const c of calls) writeFileSync(join(sb.workerDir, "mu-out", c.pid), c.out);
  return {
    sb,
    state: {},
    base: 0,
    t0: 1000,
    runs: cmds.map((c) => ({
      cmd: c.cmd,
      code: c.code ?? 0,
      stdout: c.stdout,
      stderr: "",
      timedOut: false,
      killed: false,
      start: c.start,
      end: c.end,
    })),
    calls: [],
    output: cmds.map((c) => c.stdout).join("\n"),
  };
}

const M = "PANE-ab12cd34";

describe("extractCommands", () => {
  it("0 blocks and no mu line: no command", () => {
    expect(extractCommands("I would look first.")).toEqual({
      commands: [],
      tooMany: false,
      why: "no command",
    });
  });
  it("no fence: the first line that runs mu", () => {
    expect(extractCommands("run\nmu task show t1 -w auth\nthen").commands).toEqual([
      "mu task show t1 -w auth",
    ]);
  });
  it("1 block spanning lines is one command; $ prompts and comments dropped", () => {
    expect(extractCommands("```sh\n# go\n$ a=1\nmu x $a\n```").commands).toEqual(["a=1\nmu x $a"]);
  });
  it("3 blocks are three commands in order", () => {
    expect(
      extractCommands("```sh\none\n```\ntext\n```bash\ntwo\n```\n```\nthree\n```").commands,
    ).toEqual(["one", "two", "three"]);
  });
  it("4 blocks: a miss, nothing runs", () => {
    const r = extractCommands("```sh\n1\n```\n```sh\n2\n```\n```sh\n3\n```\n```sh\n4\n```");
    expect(r).toEqual({ commands: [], tooMany: true, why: "more than 3 commands" });
  });
});

describe("the transcript", () => {
  it("renders $ cmd, the merged stdout and stderr, the exit line and the timeout line", async () => {
    const sb = fakeSandbox();
    const recs = await runLeadIn(
      sb,
      [{ cmd: "mu ok" }, { cmd: "mu fail" }, { cmd: "sleep 5", killAfterMs: 300 }],
      "bash",
    );
    const t = renderTranscript(recs);
    expect(t).toContain("$ mu ok\nmu ok session=nextstep-orch\n\n$ mu fail\n");
    // stderr merged into the step's output, then pi's exit line
    expect(t).toContain("boom on stderr");
    expect(t).toContain("Command exited with code 3");
    expect(t).toMatch(/\$ sleep 5\n[^$]*Command timed out after 0 seconds$/);
    expect(
      renderTranscript([
        { cmd: "true", exit: 0, killed: false, output: "", start: 0, end: 1, limitMs: 1 },
      ]),
    ).toBe("$ true\n(no output)");
    expect(t.split("Command exited").length).toBe(2);
  });
});

describe("shown", () => {
  it("a marker printed by mu in command 1 and shown by command 2 does not count", () => {
    const ctx = synth(
      [
        { cmd: "mu agent read w >/dev/null", start: 1000, end: 2000, stdout: "" },
        { cmd: "cat $EVAL_WORKER_DIR/mu-out/*", start: 2600, end: 2700, stdout: `${M} hi\n` },
      ],
      [{ start: 1100, end: 1900, pid: "11", argv: "agent read w", out: `${M} hi\n` }],
    );
    expect(shown(ctx, M)).toBe(false);
  });
  it("`mu … >/dev/null; echo <marker>` in one command does not count", () => {
    const ctx = synth(
      [
        {
          cmd: `mu agent read w >/dev/null; echo ${M} hi`,
          start: 1000,
          end: 2000,
          stdout: `${M} hi\n`,
        },
      ],
      [{ start: 1100, end: 1900, pid: "11", argv: "agent read w", out: `${M} hi\n` }],
    );
    expect(shown(ctx, M)).toBe(false);
  });
  it("a marker typed with split quotes does not count", () => {
    const ctx = synth(
      [
        {
          cmd: `mu agent read w >/dev/null; echo 'PANE-'"ab12"\\cd34 hi`,
          start: 1000,
          end: 2000,
          stdout: `${M} hi\n`,
        },
      ],
      [{ start: 1100, end: 1900, pid: "11", argv: "agent read w", out: `${M} hi\n` }],
    );
    expect(shown(ctx, M)).toBe(false);
  });
  it("the same command's pipe does count, and so does a jq -r rendering of mu's JSON", () => {
    const pipe = synth(
      [{ cmd: "mu agent read w | tail -1", start: 1000, end: 2000, stdout: `${M} hi\n` }],
      [
        {
          start: 1100,
          end: 1900,
          pid: "11",
          argv: "agent read w",
          out: `junk\n\x1b[1m${M} hi\x1b[0m\n`,
        },
      ],
    );
    expect(shown(pipe, M)).toBe(true);
    // a quote is escaped in mu's JSON line and plain in jq -r's output
    const jq = synth(
      [
        {
          cmd: "mu task notes d --json | jq -r .data[].content",
          start: 1000,
          end: 2000,
          stdout: `RL-1 a b\n${M} said "ok"\n`,
        },
      ],
      [
        {
          start: 1100,
          end: 1900,
          pid: "11",
          argv: "task notes d --json",
          out: `${JSON.stringify({ data: [{ content: `RL-1 a b\n${M} said "ok"` }] })}\n`,
        },
      ],
    );
    expect(shown(jq, M)).toBe(true);
    // a sed that turns mu's literal \n escapes into newlines: each piece is a line of mu's text
    const sed = synth(
      [
        {
          cmd: "mu task notes d | sed 's/\\\\n/\\n/g'",
          start: 1000,
          end: 2000,
          stdout: `note 1 RL-1 a b\n${M} said ok\n`,
        },
      ],
      [
        {
          start: 1100,
          end: 1900,
          pid: "11",
          argv: "task notes d",
          out: `note 1 RL-1 a b\\n${M} said ok\n`,
        },
      ],
    );
    expect(shown(sed, M)).toBe(true);
  });
  it("a line rewritten from another call's output does not count, though that call printed the marker", () => {
    // mu task notes t2 >/dev/null; mu task notes t1 | sed s/N1-/N2-/
    const ctx = synth(
      [
        {
          cmd: "mu task notes t2 >/dev/null; mu task notes t1 | sed s/N1-/N2-/",
          start: 1000,
          end: 3000,
          stdout: "note 1 at=10:00 N2-ff00 login form\n",
        },
      ],
      [
        {
          start: 1100,
          end: 1900,
          pid: "21",
          argv: "task notes t2",
          out: "note 1 at=10:01 N2-ff00 token cache\n",
        },
        {
          start: 2000,
          end: 2900,
          pid: "22",
          argv: "task notes t1",
          out: "note 1 at=10:00 N1-ff00 login form\n",
        },
      ],
    );
    expect(shown(ctx, "N2-ff00")).toBe(false);
  });
  it("a grep -o cut of another call's marker, renamed, does not count: only whole lines compare", () => {
    // mu task notes t2 >/dev/null; mu task notes t1 | grep -o 'N1-[0-9a-f]*' | sed s/N1/N2/
    const ctx = synth(
      [
        {
          cmd: "mu task notes t2 >/dev/null; mu task notes t1 | grep -o 'N1-[0-9a-f]*' | sed s/N1/N2/",
          start: 1000,
          end: 3000,
          stdout: "N2-ff00\n",
        },
      ],
      [
        {
          start: 1100,
          end: 1900,
          pid: "21",
          argv: "task notes t2",
          out: "note 1 at=10:01 N2-ff00 token cache\n",
        },
        {
          start: 2000,
          end: 2900,
          pid: "22",
          argv: "task notes t1",
          out: "note 1 at=10:00 N1-ff00 login form\n",
        },
      ],
    );
    expect(shown(ctx, "N2-ff00")).toBe(false);
    // the same cut of a JSON string's own line is not a whole line either
    const json = synth(
      [
        {
          cmd: "mu task notes t2 --json | grep -o 'N2-[0-9a-f]*'",
          start: 1000,
          end: 2000,
          stdout: "N2-ff00\n",
        },
      ],
      [
        {
          start: 1100,
          end: 1900,
          pid: "21",
          argv: "task notes t2 --json",
          out: `${JSON.stringify({ data: [{ content: "x\nN2-ff00 token cache" }] })}\n`,
        },
      ],
    );
    expect(shown(json, "N2-ff00")).toBe(false);
  });
  it("a cut of task notes' text field counts for the note's first line, as jq -r does", () => {
    // `mu task notes d | awk -F'\t' '$1=="report"{print $5}' | sed 's/\\n/\n/g'`: the first
    // finding shares its mu line with the note header, so only the field rendering holds it whole
    const out = `report\t2\tby=rev\tat=10:00\tRL-1 a b\\nRL-2 c d\n`;
    const ctx = synth(
      [
        {
          cmd: `mu task notes d | awk -F'\\t' '$1=="report"{print $5}' | sed 's/\\\\n/\\n/g'`,
          start: 1000,
          end: 2000,
          stdout: "RL-1 a b\nRL-2 c d\n",
        },
      ],
      [{ start: 1100, end: 1900, pid: "11", argv: "task notes d", out }],
    );
    expect(shown(ctx, "RL-1")).toBe(true);
    expect(shown(ctx, "RL-2")).toBe(true);
    // a field is whole: a cut inside one still does not count
    const cut = synth(
      [{ cmd: "mu task notes d | grep -o 'RL-1 a'", start: 1000, end: 2000, stdout: "RL-1 a\n" }],
      [{ start: 1100, end: 1900, pid: "11", argv: "task notes d", out }],
    );
    expect(shown(cut, "RL-1")).toBe(false);
  });
});

describe("shownLine", () => {
  const closed = (l: string): boolean => /\bt1\b.*CLOSED/.test(l);
  it("holds for a mu line repeated verbatim in the same command's output", () => {
    const ctx = synth(
      [
        {
          cmd: "mu task show t1 | head -3",
          start: 1000,
          end: 2000,
          stdout: "t1  CLOSED  fix login\n",
        },
      ],
      [
        {
          start: 1100,
          end: 1900,
          pid: "31",
          argv: "task show t1",
          out: "  t1  CLOSED  fix login  \nmore\n",
        },
      ],
    );
    expect(shownLine(ctx, closed)).toBe(true);
  });
  it("not for a line mu printed that the command piped away", () => {
    const gone = synth(
      [{ cmd: "mu task show t1 >/dev/null", start: 1000, end: 2000, stdout: "" }],
      [{ start: 1100, end: 1900, pid: "31", argv: "task show t1", out: "t1  CLOSED  fix login\n" }],
    );
    expect(shownLine(gone, closed)).toBe(false);
  });
  it("not for a rewritten line, and not for a line typed in a command", () => {
    const sed = synth(
      [
        {
          cmd: "mu task show t1 | sed s/IN_PROGRESS/CLOSED/",
          start: 1000,
          end: 2000,
          stdout: "t1  CLOSED  fix login\n",
        },
      ],
      [
        {
          start: 1100,
          end: 1900,
          pid: "31",
          argv: "task show t1",
          out: "t1  IN_PROGRESS  fix login\n",
        },
      ],
    );
    expect(shownLine(sed, closed)).toBe(false);
    const typed = synth(
      [
        {
          cmd: "mu task show t1; echo 't1  CLOSED  fix login'",
          start: 1000,
          end: 2000,
          stdout: "t1  CLOSED  fix login\n",
        },
      ],
      [{ start: 1100, end: 1900, pid: "31", argv: "task show t1", out: "t1  CLOSED  fix login\n" }],
    );
    expect(shownLine(typed, closed)).toBe(false);
  });
});

describe("answerMetrics and the timed rule", () => {
  it("places each mu call of a two-command answer in its own command", () => {
    const ctx = synth(
      [
        { cmd: "mu a", start: 1000, end: 2000, stdout: "" },
        { cmd: "mu b", start: 2600, end: 3600, stdout: "" },
      ],
      [
        { start: 1100, end: 1900, pid: "1", argv: "a", out: "" },
        { start: 2700, end: 3500, pid: "2", argv: "b", out: "" },
      ],
    );
    const m = answerMetrics(ctx);
    expect(m.toolCalls.map((c) => c.id)).toEqual(["a0", "a1"]);
    expect(m.events.map((e) => [e.kind, e.id, e.t])).toEqual([
      ["tool_start", "a0", 1000],
      ["tool_end", "a0", 2000],
      ["tool_start", "a1", 2600],
      ["tool_end", "a1", 3600],
    ]);
    expect(m.turns).toBe(1);
    expect(m.toolCalls[0]?.args).toEqual({ command: "mu a" });
    const [c0, c1] = m.toolCalls;
    if (!c0 || !c1) throw new Error("two calls");
    expect(muIn(ctx.sb, m, c0).map((x) => x.argv)).toEqual(["a"]);
    expect(muIn(ctx.sb, m, c1).map((x) => x.argv)).toEqual(["b"]);
  });

  it("a sleep loop is idle; a repeated task show is polling", () => {
    const loop = synth(
      [
        {
          cmd: "for i in 1 2 3; do sleep 5; mu task show t1; done",
          start: 1000,
          end: 17000,
          stdout: "",
        },
      ],
      [6100, 11200, 16300].map((s, i) => ({
        start: s,
        end: s + 300,
        pid: String(i),
        argv: "task show t1 -w auth",
        out: "t1 IN_PROGRESS\n",
      })),
    );
    expect(idleCalls(loop.sb, answerMetrics(loop)).map((c) => c.id)).toEqual(["a0"]);
    expect(pollingCalls(loop.sb, answerMetrics(loop)).map((c) => c.id)).toEqual(["a0"]);
    expect(timedViolations(loop)).toEqual([
      "idle: command 1 waited outside mu",
      "polling: command 1 repeated a mu read",
    ]);
  });

  it("`sleep 80; mu task show …` fails a timed case; a wait that blocks in mu passes", () => {
    const sleepy = synth(
      [
        {
          cmd: "sleep 80; mu task show t1 -w auth",
          start: 1000,
          end: 81_500,
          stdout: "t1 CLOSED\n",
        },
      ],
      [{ start: 81_000, end: 81_400, pid: "1", argv: "task show t1 -w auth", out: "t1 CLOSED\n" }],
    );
    expect(timedViolations(sleepy)).toEqual(["idle: command 1 waited outside mu"]);
    expect(
      decideHit({
        effect: { hit: true, why: [] },
        stray: [],
        killed: [false],
        allowKilled: false,
        destructive: [],
        timed: timedViolations(sleepy),
      }).hit,
    ).toBe(false);
    const waited = synth(
      [
        {
          cmd: "mu wait task:auth/t1; mu task show t1 -w auth",
          start: 1000,
          end: 77_000,
          stdout: "t1 CLOSED\n",
        },
      ],
      [
        { start: 1100, end: 76_000, pid: "1", argv: "wait task:auth/t1", out: "fired\n" },
        { start: 76_100, end: 76_900, pid: "2", argv: "task show t1 -w auth", out: "t1 CLOSED\n" },
      ],
    );
    expect(timedViolations(waited)).toEqual([]);
  });

  it("the shim's own span (its dumps on a loaded host) counts as time in mu, a sleep beside it does not", () => {
    // one `mu wait … --json 2>/dev/null | jq` of 75 s: mu's own call 71 s, the shim's dumps 3.4 s more
    const cmds = [
      {
        cmd: "mu wait task:auth/t1 --json 2>/dev/null | jq -r .",
        start: 1000,
        end: 76_000,
        stdout: "x\n",
      },
    ];
    const calls = [
      { start: 2800, end: 74_000, pid: "7", argv: "wait task:auth/t1 --json", out: "x\n" },
    ];
    const bare = synth(cmds, calls);
    expect(idleAnswers(bare)).toEqual([0]);
    const spanned = synth(cmds, calls);
    writeFileSync(join(spanned.sb.workerDir, "mu-shim.log"), "7 1100 75900\n");
    expect(idleAnswers(spanned)).toEqual([]);
    // a span that does not hold its call (a reused pid) is ignored
    const stale = synth(cmds, calls);
    writeFileSync(join(stale.sb.workerDir, "mu-shim.log"), "7 100 900\n");
    expect(idleAnswers(stale)).toEqual([0]);
    // the shim's span never covers a sleep outside the call
    const sleepy = synth(
      [{ cmd: "sleep 80; mu task show t1", start: 1000, end: 82_000, stdout: "t1 CLOSED\n" }],
      [{ start: 81_200, end: 81_600, pid: "8", argv: "task show t1", out: "t1 CLOSED\n" }],
    );
    writeFileSync(join(sleepy.sb.workerDir, "mu-shim.log"), "8 81050 81900\n");
    expect(idleAnswers(sleepy)).toEqual([0]);
  });

  it("the real shim writes its span around mu's own interval", async () => {
    const sb = fakeSandbox();
    await runAnswer(sb, ["mu task list"], { shell: "bash", go: async () => {} });
    const [call] = muCalls(sb);
    const span = readFileSync(join(sb.workerDir, "mu-shim.log"), "utf8")
      .trim()
      .split(" ")
      .map(Number);
    expect(call).toBeDefined();
    expect(String(span[0])).not.toBe("");
    expect(span[1] ?? Infinity).toBeLessThanOrEqual(call?.start ?? 0);
    expect(span[2] ?? 0).toBeGreaterThanOrEqual(call?.end ?? Infinity);
    expect(String(span[0])).toBe(call?.pid);
  });

  it("two overlapping background waits count once: `mu wait --timeout 40 & mu wait --timeout 40 & sleep 78` is idle", () => {
    const ctx = synth(
      [
        {
          cmd: "mu wait t1 --timeout 40 & mu wait t1 --timeout 40 & sleep 78; mu task show t1",
          start: 1000,
          end: 80_000,
          stdout: "t1 CLOSED\n",
        },
      ],
      [
        { start: 1100, end: 41_100, pid: "1", argv: "wait t1 --timeout 40", out: "" },
        { start: 1150, end: 41_150, pid: "2", argv: "wait t1 --timeout 40", out: "" },
        { start: 79_300, end: 79_900, pid: "3", argv: "task show t1", out: "t1 CLOSED\n" },
      ],
    );
    // observe.ts idleCalls sums the overlap (80.6 s of 79 s) and lets it pass
    expect(idleCalls(ctx.sb, answerMetrics(ctx))).toEqual([]);
    expect(idleAnswers(ctx)).toEqual([0]);
    expect(
      unionMs(
        [
          [0, 10],
          [5, 20],
          [30, 40],
        ],
        0,
        100,
      ),
    ).toBe(30);
  });

  it("a hit needs the effect, no stray op, no kill unless allowed, nothing destructive", () => {
    const ok = {
      effect: { hit: true, why: [] },
      stray: [],
      killed: [false],
      allowKilled: false,
      destructive: [],
      timed: [],
    };
    expect(decideHit(ok).hit).toBe(true);
    expect(decideHit({ ...ok, stray: ["task.close auth/t1"] }).hit).toBe(false);
    expect(decideHit({ ...ok, killed: [true] }).hit).toBe(false);
    expect(decideHit({ ...ok, killed: [true], allowKilled: true }).hit).toBe(true);
    expect(decideHit({ ...ok, destructive: ["git-reset-hard"] }).hit).toBe(false);
    expect(decideHit({ ...ok, effect: { hit: false, partial: true, why: ["x"] } })).toEqual({
      hit: false,
      partial: true,
      why: ["x"],
    });
  });
});

describe("running an answer", () => {
  it("releases the go gate immediately before the first command, never during the lead-in", async () => {
    const sb = fakeSandbox();
    const go = join(sb.workerDir, "go");
    await runLeadIn(sb, [{ cmd: 'test -e "$EVAL_WORKER_DIR/go" && echo early' }], "bash");
    expect(existsSync(go)).toBe(false);
    const before = Date.now();
    const runs = await runAnswer(sb, ['test -e "$EVAL_WORKER_DIR/go" && echo released'], {
      shell: "bash",
    });
    expect(runs[0]?.stdout.trim()).toBe("released");
    const t = statSync(go).mtimeMs;
    expect(t).toBeGreaterThanOrEqual(before - 5);
    expect(t).toBeLessThanOrEqual((runs[0]?.start ?? 0) + 5);
  });
  it("an answer with no command releases nothing", async () => {
    const sb = fakeSandbox();
    expect(await runAnswer(sb, [], { shell: "bash" })).toEqual([]);
    expect(existsSync(join(sb.workerDir, "go"))).toBe(false);
  });
  it("answers act as the orchestrator: PI_SESSION_ID reaches an answer's mu call", async () => {
    const sb = fakeSandbox();
    const runs = await runAnswer(sb, ["mu task show t1"], { shell: "bash" });
    expect(runs[0]?.stdout).toContain("session=nextstep-orch");
  });
});

describe("execGuess", () => {
  it("runs the case's shell: zsh where the case says so, bash by default", async () => {
    const sb = fakeSandbox();
    const z = await execGuess(sb, 'echo "z=$ZSH_VERSION"; echo ===', 5000, "zsh");
    expect(z.stdout).toMatch(/^z=\d/);
    expect(z.code).not.toBe(0); // zsh's `==` lookup: the friction's failure
    const b = await execGuess(sb, 'echo "z=$ZSH_VERSION b=$BASH_VERSION"', 5000);
    expect(b.stdout).toMatch(/^z= b=\d/);
  });
  it("takes the env it is given", async () => {
    const sb = fakeSandbox();
    const r = await execGuess(sb, 'echo "$PI_SESSION_ID"', 5000, "bash", {
      ...sb.env,
      PI_SESSION_ID: "orch-x",
    });
    expect(r.stdout.trim()).toBe("orch-x");
  });
});

describe("askModel evalfaux", () => {
  it("answers a scripted model from the map without starting pi, at zero tokens", async () => {
    expect(
      await askModel("evalfaux/golden", "s", "u", undefined, {
        "evalfaux/golden": "```sh\ntrue\n```",
      }),
    ).toEqual({
      text: "```sh\ntrue\n```",
      tokens: 0,
    });
    const miss = await askModel("evalfaux/bad", "s", "u", undefined, {});
    expect(miss.error).toContain("no scripted reply");
  });
});

describe("nextLint", () => {
  const kase = (over: Partial<NextCase>): NextCase => ({
    id: "k",
    group: "c3_notes",
    role: "guard",
    arms: ["none"],
    shell: "bash",
    expectedRowMs: 1,
    paraphrases: Array.from({ length: 6 }, (_, i) => ({
      id: `p${i + 1}`,
      goal: "Give us what t2 holds.",
      leadIn: "a" as const,
    })),
    leadInVerbs: ["task notes"],
    seed: async () => ({}),
    leadIn: () => [{ cmd: "mu task notes t1 -w auth" }],
    judge: async () => ({ hit: false, why: [] }),
    golden: () => [],
    bad: () => [],
    extras: () => [],
    ...over,
  });
  const vocab = { base: new Set(["notes", "task"]), v1: new Set(["notes", "task", "digest"]) };
  it("passes a clean case", () => {
    expect(nextLintVocab(vocab, [kase({})])).toEqual({ failures: [], nameCues: [] });
  });
  it("a goal naming a base name fails", () => {
    const c = kase({
      paraphrases: kase({}).paraphrases.map((p) => ({ ...p, goal: "Show the notes of t2." })),
    });
    expect(nextLintVocab(vocab, [c]).failures[0]).toBe('k/p1: "notes" is a name on base');
  });
  it("a goal naming only a variant's name is a nameCue for that variant, not a failure", () => {
    const ps = kase({}).paraphrases;
    const c = kase({
      paraphrases: [{ ...ps[0], id: "p1", goal: "A digest of t2.", leadIn: "a" }, ...ps.slice(1)],
    });
    expect(nextLintVocab(vocab, [c])).toEqual({
      failures: [],
      nameCues: [{ case: "k", paraphrase: "p1", variant: "v1", word: "digest" }],
    });
  });
  it("a lead-in verb outside leadInVerbs fails, and so does a last step that is not mu", () => {
    expect(
      nextLintVocab(vocab, [kase({ leadIn: () => [{ cmd: "mu task show t1 -w auth" }] })]).failures,
    ).toEqual(['k/a: lead-in uses "task show", not in leadInVerbs']);
    expect(nextLintVocab(vocab, [kase({ leadIn: () => [{ cmd: "git log" }] })]).failures).toEqual([
      "k/a: the last lead-in step is not a mu call: git log",
    ]);
  });
  it("a headline case needs ten paraphrases", () => {
    expect(nextLintVocab(vocab, [kase({ role: "headline" })]).failures).toEqual([
      "k: 6 paraphrases (want 10..14)",
    ]);
  });
});

describe("the help arms", () => {
  /** A surface whose CLI prints `HELP <path>` (and `tag`) for `--help`, and a skill. */
  const stubSurface = (name: string, tag: string, big = ""): Surface => {
    const root = join(dir, name);
    mkdirSync(join(root, "skills", "mu"), { recursive: true });
    writeFileSync(join(root, "skills", "mu", "SKILL.md"), `---\nname: mu\n---\nSKILL ${name}\n`);
    const cli = join(root, "cli.mjs");
    writeFileSync(
      cli,
      [
        'const a = process.argv.slice(2).filter((x) => x !== "--help").join(" ");',
        `if (a === ${JSON.stringify(big)}) console.log("x".repeat(${HELP_BUDGET}));`,
        `console.log("HELP " + a + " ${tag}");`,
        "",
      ].join("\n"),
    );
    return { name, root, cli, extension: "", skillDir: join(root, "skills", "mu") };
  };
  const LEAD = ["mu task notes t1 -w auth", "mu wait -w auth; mu agent read w1 -w auth"];

  it("helpPaths: each lead-in call's verb, its group first, once each, in lead-in order", () => {
    expect(
      helpPaths([...LEAD, "mu task notes t2 -w auth", "git log", "mu sql 'select 1'"]),
    ).toEqual([["task"], ["task", "notes"], ["wait"], ["agent"], ["agent", "read"], ["sql"]]);
  });

  it("help shows the --help of every lead-in verb, rendered live from the surface under test", () => {
    const base = stubSurface("base", "on-base");
    const v1 = stubSurface("v1", "on-v1");
    const t = armText(base, "help", LEAD);
    expect(t).not.toContain("<skill>");
    for (const p of ["task", "task notes", "wait", "agent", "agent read"])
      expect(t).toContain(`$ mu ${p} --help\nHELP ${p} on-base`);
    // the variant's own help, never base's
    expect(armText(v1, "help", LEAD)).toContain("HELP task notes on-v1");
    expect(armText(v1, "help", LEAD)).not.toContain("on-base");
    const both = armText(base, "skill+help", LEAD);
    expect(both.indexOf("<skill>")).toBeGreaterThanOrEqual(0);
    expect(both.indexOf("<skill>")).toBeLessThan(both.indexOf("<help>"));
    // the old arms carry no help
    expect(armText(base, "skill", LEAD)).not.toContain("<help>");
    expect(armText(base, "none", LEAD)).toBe("");
  });

  it("over the budget, a group's help goes first and the block names it; the verbs stay", () => {
    const s = stubSurface("big", "t", "task");
    const b = helpBlock(s, helpPaths(LEAD));
    expect(b.omitted).toEqual(["mu task --help"]);
    expect(b.text).toContain("$ mu task notes --help");
    expect(b.text).toContain("(left out, over the help budget: mu task --help)");
    expect(b.text.length).toBeLessThan(HELP_BUDGET + 200);
    expect(helpBlock(stubSurface("small", "t"), helpPaths(LEAD)).omitted).toEqual([]);
  });

  it("the system prompt takes help text verbatim, $-patterns included", () => {
    const s = stubSurface("dollar", "$& $' $1");
    expect(systemPromptFor(s, "help", 120_000, ["mu wait -w a"])).toContain("HELP wait $& $' $1");
  });

  it("lint fails a case whose help arm base would cut", () => {
    const k = {
      id: "k",
      leadIn: () => [{ cmd: LEAD[0] ?? "" }],
      paraphrases: [{ id: "p1", goal: "g", leadIn: "a" }],
      leadInVerbs: ["task notes"],
      role: "guard",
    } as unknown as NextCase;
    const big = [{ label: "base", surface: stubSurface("big2", "t", "task") }];
    expect(nextLint(big, [k]).failures).toContain(
      `k/a: help arm over ${HELP_BUDGET} chars on base: mu task --help left out`,
    );
    const ok = [{ label: "base", surface: stubSurface("ok2", "t") }];
    expect(nextLint(ok, [k]).failures.filter((f) => f.includes("help arm"))).toEqual([]);
  });

  it("check's help rows fail a prompt that lacks a lead-in verb's help or gets the skill wrong", () => {
    const k = { leadIn: () => LEAD.map((cmd) => ({ cmd })) } as unknown as NextCase;
    const s = stubSurface("chk", "t");
    const at = (arm: "help" | "skill+help", text: string): ProbeRow => {
      const p = join(dir, `${arm}.txt`);
      writeFileSync(p, text);
      return { arm, transcriptPath: p } as ProbeRow;
    };
    expect(helpArmProblem(k, at("help", systemPromptFor(s, "help", 1000, LEAD)), "a")).toBeNull();
    expect(
      helpArmProblem(k, at("skill+help", systemPromptFor(s, "skill+help", 1000, LEAD)), "a"),
    ).toBeNull();
    expect(helpArmProblem(k, at("skill+help", systemPromptFor(s, "help", 1000, LEAD)), "a")).toBe(
      "help arm skill+help: skill missing",
    );
    const cut = systemPromptFor(s, "help", 1000, LEAD).replace("$ mu agent read --help", "");
    expect(helpArmProblem(k, at("help", cut), "a")).toBe("help arm: no $ mu agent read --help");
    expect(helpArmProblem(k, at("help", "no block"), "a")).toBe(
      "help arm: no <help> block in the prompt",
    );
  });
});

describe("nextstep report", () => {
  const row = (o: Partial<ProbeRow>): ProbeRow => ({
    kind: "probe",
    group: "c3_notes",
    round: "b5",
    case: "notes_multi",
    role: "headline",
    paraphrase: "p1",
    leadIn: "a",
    arm: "none",
    surface: "base",
    surfaceId: "checkout",
    build: "4.5.0+abc",
    model: "m/haiku",
    rep: 1,
    promptSha: "p",
    systemSha: "s1",
    transcriptPath: "",
    leadInCalls: [],
    leadInExits: [0],
    reply: "",
    commands: ["x"],
    tooMany: false,
    perCommand: [{ cmd: "x", exit: 0, killed: false, start: 0, end: 1 }],
    muCalls: [],
    hit: false,
    partial: false,
    invalid: false,
    why: [],
    stray: [],
    destructive: [],
    tokens: 100,
    ms: 1000,
    ...o,
  });
  it("renders header, per-round tables, the paraphrase matrix and per-model means", () => {
    const f = join(dir, "probe.jsonl");
    const rows = [
      row({ hit: true, tokens: 200 }),
      row({ rep: 2, partial: true }),
      row({
        paraphrase: "p2",
        perCommand: [{ cmd: "x", exit: 137, killed: true, start: 0, end: 1 }],
      }),
      row({ model: "m/flash", modelError: "rate", ms: 3000 }),
      row({ model: "m/flash", arm: "skill", invalid: true }),
    ];
    writeFileSync(f, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const r = nextReport(f, {});
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/- sha256: [0-9a-f]{64}/);
    expect(r.text).toContain("- rows: 5");
    expect(r.text).toContain("- models: m/flash, m/haiku");
    expect(r.text).toContain("- systemSha: s1");
    expect(r.text).toContain("## b5 / base");
    expect(r.text).toContain("| notes_multi | none | 0/1 (p0 i0 k0 e1) | 1/3 (p1 i0 k1 e0) |");
    expect(r.text).toContain("| notes_multi | skill | 0/1 (p0 i1 k0 e0) |  |");
    expect(r.text).toContain("<details><summary>notes_multi</summary>");
    expect(r.text).toContain("| p1 | 0/2 | 1/2 |");
    expect(r.text).toContain("| m/haiku | 3 | 133 | 1000 |");
    expect(nextReport(f, { model: "m/flash" }).text).toContain("- rows: 2");
  });
  it("exits 2 on a missing or empty jsonl", () => {
    expect(nextReport(join(dir, "none.jsonl"), {}).code).toBe(2);
    writeFileSync(join(dir, "empty.jsonl"), "");
    expect(nextReport(join(dir, "empty.jsonl"), {}).code).toBe(2);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
