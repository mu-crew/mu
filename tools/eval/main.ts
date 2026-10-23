// Eval harness CLI. Subcommands: prepare <name> <ref> | selftest [--surface <dir>].
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FauxStep } from "./faux.ts";
import { runAut } from "./runner.ts";
import { createSandbox, FAUX_EXT, mu, sh } from "./sandbox.ts";
import { prepareSurface, surfaceFromDir } from "./surface.ts";
import type { Sandbox, Scenario, Surface } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `: ${detail}` : ""}`);
}

const SELFTEST_SCRIPT: FauxStep[] = [
  { calls: [{ bash: "mu workstream init eval-smoke" }] },
  {
    calls: [
      { bash: "mu task add t1 -w eval-smoke -t one -i 10 -e 0.1" },
      { bash: "mu task close nope -w eval-smoke --evidence x" },
    ],
  },
  { text: "done" },
];

const selftestScenario: Scenario = {
  id: "selftest",
  title: "faux AUT creates a task and trips one error",
  prompt: "selftest",
  quietMs: 500,
  async setup() {},
  async judge(sb) {
    const r = await mu(sb, ["task", "list", "-w", "eval-smoke", "--json"]);
    const ok = r.code === 0 && r.stdout.includes('"t1"');
    return { completed: ok, wrong: [], destructive: [], notes: [] };
  },
};

function tmuxServerGone(socket: string): boolean {
  try {
    execFileSync("tmux", ["-L", socket, "ls"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function leftoverDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(`mu-eval-${process.pid}-`));
}

async function workerChecks(sb: Sandbox): Promise<void> {
  const w = (extra: string) => `MU_AGENT_NAME=w1 ${extra} pi -p go`;
  writeFileSync(
    join(sb.workerDir, "default.json"),
    JSON.stringify([
      {
        calls: [
          { bash: 'echo "$MU_AGENT_NAME-ok"; printenv MU_NUDGE > "$EVAL_WORKER_DIR/nudge.out"' },
        ],
      },
      { text: "w-done" },
    ]),
  );
  const ok = await sh(sb, w(""), { allowFail: true });
  check(
    "worker: pi -p prints w-done",
    ok.code === 0 && ok.stdout.includes("w-done"),
    ok.stderr || ok.stdout,
  );
  const nudge = join(sb.workerDir, "nudge.out");
  check(
    "worker: MU_NUDGE=0 and EVAL_WORKER_DIR in env",
    existsSync(nudge) && readFileSync(nudge, "utf8").trim() === "0",
  );
  check("worker: attempts counter written", existsSync(join(sb.workerDir, "w1.attempts")));
  check("worker: last-prompt written", existsSync(join(sb.workerDir, "last-prompt.w1")));

  writeFileSync(join(sb.workerDir, "error-next.w1"), "");
  const err = await sh(sb, w(""), { allowFail: true });
  check(
    "worker: error-next fails the first run",
    (err.code !== 0 || !err.stdout.includes("w-done")) && !err.stdout.includes("w1-ok"),
    `code=${err.code} out=${err.stdout}`,
  );
  check("worker: error-next consumed", !existsSync(join(sb.workerDir, "error-next.w1")));
  const again = await sh(sb, w(""), { allowFail: true });
  check(
    "worker: second run prints w-done",
    again.code === 0 && again.stdout.includes("w-done"),
    again.stderr || again.stdout,
  );

  writeFileSync(join(sb.workerDir, "die-next.w1"), "");
  const die = await sh(sb, w(""), { allowFail: true });
  check("worker: die-next exits 137", die.code === 137, `code=${die.code}`);
  check("worker: die-next consumed", !existsSync(join(sb.workerDir, "die-next.w1")));
}

// A hung tool must hit the timeout, and the kill must take the tool's process group with it.
async function hardStopCheck(sb: Sandbox, scriptDir: string): Promise<void> {
  const script = join(scriptDir, "hang.json");
  const marker = `eval-hang-${process.pid}`;
  writeFileSync(script, JSON.stringify([{ calls: [{ bash: `exec -a ${marker} sleep 600` }] }]));
  const hang: Scenario = {
    ...selftestScenario,
    id: "hang",
    judge: async () => ({ completed: false, wrong: [], destructive: [], notes: [] }),
  };
  const m = await runAut(sb, hang, {
    model: "evalfaux/aut",
    providerExt: FAUX_EXT,
    auTScript: script,
    timeoutMs: 3000,
  });
  check("hard stop: timeout aborts the run", m.aborted === "timeout", String(m.aborted));
  const left = await sh(sb, `pgrep -f ${marker}`, { allowFail: true });
  check("hard stop: tool process group killed", left.code !== 0, left.stdout);
}

async function selftest(surface: Surface): Promise<number> {
  const scriptDir = mkdtempSync(join(tmpdir(), "mu-eval-script-"));
  const scriptPath = join(scriptDir, "aut.json");
  writeFileSync(scriptPath, JSON.stringify(SELFTEST_SCRIPT));
  const sb = await createSandbox(surface);
  const sockets = [sb.tmuxSocket];
  const dir = sb.dir;
  try {
    check("sandbox: private tmux server is up", !tmuxServerGone(sb.tmuxSocket));
    await selftestScenario.setup(sb);
    const m = await runAut(sb, selftestScenario, {
      model: "evalfaux/aut",
      providerExt: FAUX_EXT,
      auTScript: scriptPath,
      timeoutMs: 120_000,
      log: join(sb.dir, "aut.rpc.jsonl"),
    });
    const verdict = await selftestScenario.judge(sb, m);
    check("aut: completed", verdict.completed);
    check("aut: muCalls == 3", m.muCalls === 3, String(m.muCalls));
    check("aut: muErrors == 1", m.muErrors === 1, String(m.muErrors));
    check("aut: toolCalls.length == 3", m.toolCalls.length === 3, String(m.toolCalls.length));
    check("aut: turns == 3", m.turns === 3, String(m.turns));
    check("aut: usage.total > 0", m.usage.total > 0, String(m.usage.total));
    check("aut: usage.cost == 0", m.usage.cost === 0, String(m.usage.cost));
    check("aut: aborted == null", m.aborted === null, String(m.aborted));
    check("aut: finalText is done", m.finalText === "done", m.finalText);
    await workerChecks(sb);
    await hardStopCheck(sb, scriptDir);
  } finally {
    await sb.close();
    rmSync(scriptDir, { recursive: true, force: true });
  }
  check("isolation: sandbox tmux server gone", sockets.every(tmuxServerGone));
  check(
    "isolation: sandbox dir removed",
    !existsSync(dir) && leftoverDirs().length === 0,
    leftoverDirs().join(","),
  );
  return failures === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "prepare": {
      const [name, ref] = rest;
      if (!name || !ref) throw new Error("usage: main.ts prepare <name> <ref>");
      const s = await prepareSurface(name, ref, REPO_ROOT);
      console.log(`${s.name}: ${s.root}`);
      return 0;
    }
    case "selftest": {
      const root = flag(rest, "--surface") ?? REPO_ROOT;
      return selftest(surfaceFromDir("checkout", root));
    }
    default:
      console.error(
        "usage: node tools/eval/main.ts <prepare <name> <ref> | selftest [--surface <dir>]>",
      );
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
