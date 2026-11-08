// rig-guard.ts: an AUT tool call (or a probe answer) that names the rig, its rows or another
// sandbox is a rig read; its own sandbox, the surface's product files and a sandbox `~` are not.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCKED,
  RIG_REPO,
  redactRig,
  rigCheckouts,
  rigGuard,
  rigInInput,
  rigReads,
  rigReadsInCommands,
  stageRig,
  TRANSCRIPTS_DIR,
} from "../../tools/eval/rig-guard.ts";
import type { ToolCall } from "../../tools/eval/types.ts";

const own = "/tmp/mu-eval-1-2-abc123";
const surfaceRoot = join(homedir(), ".cache", "mu", "eval", "surfaces", "hill2-base");
const sandboxHome = `${own}/home`;
const guard = rigGuard({ surfaceRoot, ownSandbox: own, home: sandboxHome });

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
      bash(`ls ${RIG_REPO}x`),
    ];
    expect(rigReads(calls, guard)).toEqual([]);
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
    for (const f of ["fake-harness.ts", "fake-payloads.ts", "faux-steps.ts"])
      expect(readFileSync(join(dir, ".rt", "lib", f), "utf8")).toBe(
        readFileSync(join(RIG_REPO, "tools", "eval", f), "utf8"),
      );
  });
});
