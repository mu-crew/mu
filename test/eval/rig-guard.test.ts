// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// rig-guard.ts: an AUT tool call (or a probe answer) that names the rig, its rows or another
// sandbox is a rig read; its own sandbox, the surface's product files and a sandbox `~` are not.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCKED,
  canaryInOutputs,
  RIG_REPO,
  redactRig,
  rigCheckouts,
  rigGuard,
  rigInInput,
  rigReads,
  rigReadsInCommands,
  stageRig,
  TRANSCRIPTS_DIR,
  WITHHELD,
} from "../../tools/eval/rig-guard.ts";
import { RIG_CANARY, stripCanary } from "../../tools/eval/rig-private.ts";
import type { ToolCall } from "../../tools/eval/types.ts";

const own = "/tmp/mu-eval-1-2-abc123";
const surfaceRoot = join(homedir(), ".cache", "mu", "eval", "surfaces", "hill2-base");
const sandboxHome = `${own}/home`;
const guard = rigGuard({ surfaceRoot, ownSandbox: own, home: sandboxHome });
/** Without the private stores: the checkout's parent is a store here (crew worktrees), not under /tmp. */
const noStores = { ...guard, stores: [] };

const call = (name: string, args: Record<string, unknown>, output = ""): ToolCall => ({
  id: "x",
  name,
  args,
  isError: false,
  output,
  exitCode: 0,
  durationMs: 1,
});
const bash = (command: string, output = ""): ToolCall => call("bash", { command }, output);

describe("rigReads", () => {
  it("flags a cat of a scenario source, a find and a grep over the checkout", () => {
    const calls = [
      bash(`cat ${RIG_REPO}/tools/eval/scenarios/teardown.ts`),
      bash(`find ${RIG_REPO} -name '*.golden.next.json'`),
      bash(`grep -rn closeEarnedWrong "${RIG_REPO}/tools/eval/" 2>/dev/null`),
      call("read", { path: `${RIG_REPO}/tools/eval/faux.ts`, offset: 1 }),
      call("grep", { pattern: "judge", path: RIG_REPO }),
    ];
    const r = rigReads(calls, guard);
    expect(r).toHaveLength(5);
    expect(r[0]).toBe(`#0 bash: ${RIG_REPO}`);
  });

  it("flags every worktree of the rig's repo, the transcripts and the surface's rig dirs", () => {
    const others = rigCheckouts().filter((c) => c !== RIG_REPO);
    const calls = [
      ...others.map((c) => bash(`ls ${c}/tools/eval/`)),
      bash(`ls ${TRANSCRIPTS_DIR}/hill-r2/b5`),
      bash(`grep -rn x ${surfaceRoot}/tools/eval`),
      bash(`ls ${surfaceRoot}/test/eval`),
    ];
    expect(rigReads(calls, guard)).toHaveLength(calls.length);
  });

  it("flags a copy of the rig outside every known checkout by its segments", () => {
    const gone = "/Users/x/.local/state/mu-next/worktrees/crew/w-removed";
    expect(
      rigReads(
        [
          bash(`sed -n 1,40p ${gone}/tools/eval/scenarios/fanout_gates.ts`),
          bash("grep -rn closeEarnedWrong /opt 2>/dev/null", `${gone}/tools/eval/x.ts:45: y`),
        ],
        guard,
      ),
    ).toEqual(["#0 bash: tools/eval", "#1 bash: rig file in output"]);
  });

  it("flags another run's sandbox and a rig grep line in an output", () => {
    const r = rigReads(
      [
        bash("cat /private/tmp/mu-eval-9-9-ffeedd/.rt/pi"),
        bash("grep -rn closeEarnedWrong / 2>/dev/null", `${RIG_REPO}/tools/eval/x.ts:45: y`),
      ],
      guard,
    );
    expect(r).toEqual(["#0 bash: other sandbox mu-eval-9-9-ffeedd", "#1 bash: rig file in output"]);
  });

  it("expands ~ and $HOME as the AUT's shell does: the user's home only in a live run", () => {
    const rel = TRANSCRIPTS_DIR.slice(homedir().length);
    const calls = [bash(`ls ~${rel}`), bash(`cat "$HOME${rel}/r4.jsonl"`)];
    expect(rigReads(calls, guard)).toEqual([]);
    const live = rigGuard({ surfaceRoot, ownSandbox: own, home: homedir() });
    expect(rigReads(calls, live)).toHaveLength(2);
  });

  it("leaves the run's own sandbox, the surface's product files and ps alone", () => {
    const calls = [
      bash(`cat ${own}/.rt/pi; ls ${own}/state`),
      call("read", { path: `${surfaceRoot}/skills/mu/SKILL.md` }),
      bash(`node ${surfaceRoot}/dist/cli.js --help`),
      bash("ps aux | grep eval", `u 1 node ${RIG_REPO}/tools/eval/main.ts r4 --surface x`),
    ];
    expect(rigReads(calls, guard)).toEqual([]);
    expect(rigReads([bash(`ls ${RIG_REPO}x`)], noStores)).toEqual([]);
  });

  it("drops a root that holds the run's own sandbox (a log root of /tmp)", () => {
    const g = rigGuard({ ownSandbox: own, home: sandboxHome, extra: ["/tmp"] });
    expect(rigReads([bash(`ls ${own}`)], g)).toEqual([]);
  });
});

describe("aut-guard's checks", () => {
  it("rigInInput names a tool input that reaches the rig, not one inside the sandbox", () => {
    expect(rigInInput({ command: `cat ${RIG_REPO}/tools/eval/faux.ts` }, guard)).toEqual([
      RIG_REPO,
    ]);
    expect(rigInInput({ path: `${own}/state/mu.db` }, guard)).toEqual([]);
  });

  it("redactRig cuts the lines that name the rig and says so; a clean text is unchanged", () => {
    const ps = [
      "u 1 /tmp/mu-eval-1-2-abc123/.rt/real/pi --mode rpc",
      `u 2 node ${RIG_REPO}/tools/eval/main.ts r4`,
      "u 3 /private/tmp/mu-eval-9-9-ffeedd/.rt/real/pi",
    ].join("\n");
    expect(redactRig(ps, guard)).toEqual({
      text: "u 1 /tmp/mu-eval-1-2-abc123/.rt/real/pi --mode rpc\n[2 line(s) outside this sandbox cut]",
      cut: 2,
    });
    expect(redactRig("a\nb", guard)).toEqual({ text: "a\nb", cut: 0 });
  });

  it("rigReads skips a call aut-guard refused: it never ran", () => {
    const cmd = `cat ${RIG_REPO}/tools/eval/scenarios/teardown.ts`;
    const blocked = { ...bash(cmd, BLOCKED), isError: true };
    expect(rigReads([blocked], guard)).toEqual([]);
    expect(rigReads([{ ...blocked, isError: false }], guard)).toHaveLength(1);
  });
});

describe("rigReadsInCommands", () => {
  it("names the probe answer's offending commands", () => {
    expect(
      rigReadsInCommands(["mu task list -w auth", `cat ${RIG_REPO}/tools/eval/nextstep.ts`], guard),
    ).toEqual([`command 2: ${RIG_REPO}`]);
  });
});

describe("stageRig", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("copies a module and the relative imports it reaches into the sandbox's .rt/lib", () => {
    dir = mkdtempSync(join(tmpdir(), "rig-stage-"));
    const p = stageRig(dir, "fake-harness.ts");
    expect(p).toBe(join(dir, ".rt", "lib", "fake-harness.ts"));
    for (const f of ["fake-harness.ts", "fake-payloads.ts", "faux-steps.ts"]) {
      const copy = readFileSync(join(dir, ".rt", "lib", f), "utf8");
      // the sandbox's own copy carries no canary: reading it reads no rig file
      expect(copy).toBe(stripCanary(readFileSync(join(RIG_REPO, "tools", "eval", f), "utf8")));
      expect(copy).not.toContain(RIG_CANARY);
    }
  });
});

describe("the canary backstop", () => {
  const parent = dirname(RIG_REPO);
  const co = basename(RIG_REPO);
  const faux = readFileSync(join(RIG_REPO, "tools", "eval", "faux.ts"), "utf8");

  it("every rig file carries the canary on its first and last line", () => {
    const files = execFileSync(
      "git",
      ["-C", RIG_REPO, "ls-files", "tools/eval", "test/eval", "docs/eval", "docs/specs"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => f !== "");
    expect(files.length).toBeGreaterThan(100);
    const missing = files.filter((f) => {
      const lines = readFileSync(join(RIG_REPO, f), "utf8").trimEnd().split("\n");
      return (
        !(lines[0]?.includes(RIG_CANARY) || lines[1]?.includes(RIG_CANARY)) ||
        !(lines.at(-1)?.includes(RIG_CANARY) || lines.at(-2)?.includes(RIG_CANARY))
      );
    });
    expect(missing).toEqual([]);
  });

  it("an output that carries the canary is a rig read, however the path was spelled", () => {
    // the reviewer's four evasions of the path rules; each printed faux.ts whole
    const evasions = [
      `cd ${parent} && cd ${co} && cd tools && cd eval && cat faux.ts`,
      `cd ${parent} && git -C ${co} show HEAD:tools/eval/faux.ts`,
      `cat ${parent}/${co.slice(0, -1)}?/tool?/eva?/faux.ts`,
      `ln -s ${parent} y && cd y/${co}/tools && cat eval/faux.ts`,
    ];
    const r = rigReads(
      evasions.map((c) => bash(c, faux)),
      guard,
    );
    expect(r).toHaveLength(4);
    for (const line of r) expect(line).toContain("rig canary in output");
    // the glob names no rig path: only the canary sees it
    expect(rigReads([bash(evasions[2] ?? "", "")], noStores)).toEqual([]);
    expect(rigReads([bash(evasions[2] ?? "", faux)], noStores)).toEqual([
      "#0 bash: rig canary in output",
    ]);
  });

  it("a result aut-guard withheld for its canary still marks the run", () => {
    expect(rigReads([bash("cat x", WITHHELD)], guard)).toEqual(["#0 bash: rig canary in output"]);
  });

  it("a probe answer's output with the canary is a read", () => {
    expect(canaryInOutputs(["ok", `x\n${RIG_CANARY}\n`])).toEqual([
      "command 2: rig canary in output",
    ]);
  });
});

describe("the path rules", () => {
  const parent = dirname(RIG_REPO);
  const co = basename(RIG_REPO);

  it("match a relative tools/eval or test/eval token", () => {
    expect(rigInInput({ command: `git -C x show HEAD:tools/eval/faux.ts` }, guard)).toEqual([
      "tools/eval",
    ]);
    expect(rigInInput({ command: "cat tools/eval/scenarios/x.ts" }, guard)).toEqual(["tools/eval"]);
    expect(rigInInput({ command: "ls ./test/eval" }, guard)).toEqual(["test/eval"]);
    expect(rigInInput({ command: "ls mytools/evaluate" }, guard)).toEqual([]);
    expect(rigReads([bash("grep -rn x .", "./tools/eval/scenarios/x.ts:3: y")], guard)).toEqual([
      "#0 bash: rig file in output",
    ]);
  });

  it("follow a bash command's cd chain and its relative paths after a cd", () => {
    expect(
      rigInInput(
        { command: `cd ${parent} && cd ${co} && cd tools && cd eval && cat faux.ts` },
        guard,
      ),
    ).toEqual([RIG_REPO]);
    expect(rigInInput({ command: `cd ${parent}; cat ./${co}/package.json` }, guard)).toEqual([
      RIG_REPO,
    ]);
    expect(rigInInput({ command: `cd ${parent} && cat $PWD/${co}/x` }, guard)).toEqual([RIG_REPO]);
    expect(
      rigInInput(
        { command: `ln -s ${parent} y && cd y/${co}/tools && cat eval/faux.ts` },
        noStores,
      ),
    ).toEqual(["tools/eval"]);
    expect(rigReadsInCommands([`cd ${parent} && cd ${co} && ls`], guard)).toEqual([
      `command 1: ${RIG_REPO}`,
    ]);
    // inside the sandbox, a cd is fine
    expect(rigInInput({ command: `cd ${own}/repo && cd src && cat a.ts` }, guard)).toEqual([]);
  });

  it("cover the private stores shared with the designer deny list", () => {
    const live = rigGuard({ surfaceRoot, ownSandbox: own, home: homedir() });
    const stores = [
      ".pi/agent/sessions/x.jsonl",
      ".claude/projects/p/s.jsonl",
      ".codex/sessions/2026/s.jsonl",
      "museum/db",
      ".local/state/mu-next/mu.db",
    ];
    for (const p of stores) {
      expect(rigInInput({ command: `cat ${join(homedir(), p)}` }, guard)).toHaveLength(1);
      expect(rigInInput({ command: `cat ~/${p}` }, live)).toHaveLength(1);
      // a sandbox HOME's own ~/.pi is not the user's
      expect(rigInInput({ command: `cat ~/${p}` }, guard)).toEqual([]);
    }
    const line = `${join(homedir(), ".pi", "agent", "sessions", "s.jsonl")}:12: holdout text`;
    expect(rigReads([bash("grep -rn x / 2>/dev/null", line)], guard)).toEqual([
      "#0 bash: rig file in output",
    ]);
    expect(redactRig(line, guard).cut).toBe(1);
  });

  it("name a root once, by its realpath, however it is spelled (/tmp is /private/tmp)", () => {
    const d = mkdtempSync(join(tmpdir(), "rig-spell-"));
    try {
      const real = realpathSync(d);
      const g = rigGuard({ ownSandbox: own, home: sandboxHome, extra: [d] });
      const other = real.startsWith("/private/") ? real.slice("/private".length) : real;
      expect(rigInInput({ command: `cat ${real}/x ${other}/y ${d}/z` }, g)).toEqual([real]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
