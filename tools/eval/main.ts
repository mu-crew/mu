// Eval harness CLI. Subcommands: prepare | selftest | run | matrix | report | check (see usage below).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRows, runCold, runColdCheck } from "./cold-guess.ts";
import { toColdMarkdown } from "./cold-report.ts";
import {
  appendResult,
  loadScenario,
  logPath,
  reportCommand,
  resolveSurface,
  runCheck,
  runMatrix,
  runOne,
  scenarioIds,
  summary,
  timestamp,
} from "./commands.ts";
import type { FauxStep } from "./faux.ts";
import { runAut } from "./runner.ts";
import { createSandbox, FAUX_EXT, mu, sh, tmuxSocketPath } from "./sandbox.ts";
import { parseFamily, prepareSurface, surfaceFromDir, surfaceId } from "./surface.ts";
import type { Family, Sandbox, Scenario, Surface } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_PROVIDER_EXT = join(homedir(), ".pi", "agent", "extensions", "modelbridge.ts");
const USAGE = `usage: node tools/eval/main.ts <command>
  prepare <name> <ref>
  selftest [--surface <dir>]
  run <scenario> --surface <spec> --model <m> [--family 3x|next] [--scenario-root <dir>] [--provider-ext p] [--keep] [--out f]
  matrix --surface <spec>... --model <m>... [--family 3x|next] [--scenario-root <dir>] [--scenarios a,b] [--reps 1] [--concurrency 4] [--budget-tokens N] --out <results.jsonl>
  report <results.jsonl> [--out file.md]
  check [--surface <spec>] [--scenarios a,b] [--family 3x|next] [--scenario-root <dir>] [--include-underscore] [--no-preflight] [--verbose]
  cold-guess run --surface [label=]<spec>... --model <m>... [--reps 3] [--intents a,b] [--concurrency 4] [--provider-ext p] --out <cold-guess.jsonl>
  cold-guess check [--surface <spec>] [--intents a,b] [--concurrency 4]
  cold-guess report <cold-guess.jsonl> [--out file.md]
<spec> = <dir|name>[:<3x|next>[:<scenario-root>]]. A name is a surface under ~/.cache/mu/eval/surfaces. Family and scenario root are per
surface; --family/--scenario-root only fill specs that leave them out (defaults: 3x, tools/eval/scenarios). A scenario root holds
<id>.<golden|bad|bad-x>.<family>.json and optional <id>.ts overrides, and must be outside ~/.cache/mu/eval/surfaces.`;

/** The --family / --scenario-root flags: defaults for every --surface spec that leaves them out. */
function surfaceDefaults(args: string[]): { family?: Family; scenarioRoot?: string } {
  const family = flag(args, "--family");
  return {
    family: family === undefined ? undefined : parseFamily(family),
    scenarioRoot: flag(args, "--scenario-root"),
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Every value of a repeatable flag (--model a --model b), each also split on commas. */
function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const v = args[i + 1];
    if (a === name && v !== undefined) out.push(...v.split(",").filter((x) => x !== ""));
  });
  return out;
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

function tmuxServerGone(socketPath: string): boolean {
  try {
    execFileSync("tmux", ["-S", socketPath, "ls"], { stdio: "ignore" });
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
  const sockets = [tmuxSocketPath(sb.dir, sb.tmuxSocket)];
  const dir = sb.dir;
  try {
    check("sandbox: private tmux server is up", !tmuxServerGone(sockets[0] ?? ""));
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
    case "run": {
      const [id] = rest;
      const surfaceArg = flag(rest, "--surface");
      const model = flag(rest, "--model");
      if (!id || !surfaceArg || !model) throw new Error(USAGE);
      const surface = resolveSurface(surfaceArg, surfaceDefaults(rest));
      const scenario = await loadScenario(id, surface.scenarioRoot);
      const r = await runOne({
        surface,
        scenario,
        model,
        providerExt: flag(rest, "--provider-ext") ?? DEFAULT_PROVIDER_EXT,
        rep: 1,
        keep: rest.includes("--keep"),
        log: logPath(REPO_ROOT, timestamp(), {
          scenario: id,
          surface: surfaceId(surface),
          model,
          rep: 1,
        }),
      });
      console.log(summary(r));
      for (const w of r.verdict.wrong) console.log(`  wrong: ${w}`);
      for (const d of r.verdict.destructive) console.log(`  destructive: ${d}`);
      for (const n of r.verdict.notes) console.log(`  note: ${n}`);
      const out = flag(rest, "--out");
      if (out) appendResult(out, r);
      return 0;
    }
    case "matrix": {
      const defaults = surfaceDefaults(rest);
      const surfaces = flagAll(rest, "--surface").map((s) => resolveSurface(s, defaults));
      const models = flagAll(rest, "--model");
      const out = flag(rest, "--out");
      if (surfaces.length === 0 || models.length === 0 || !out) throw new Error(USAGE);
      const only = flag(rest, "--scenarios");
      await runMatrix({
        surfaces,
        models,
        scenarios: only
          ? only.split(",")
          : scenarioIds(false, ...surfaces.map((s) => s.scenarioRoot)),
        reps: Number(flag(rest, "--reps") ?? 1),
        concurrency: Number(flag(rest, "--concurrency") ?? 4),
        budgetTokens: Number(flag(rest, "--budget-tokens") ?? 42_000_000),
        providerExt: flag(rest, "--provider-ext") ?? DEFAULT_PROVIDER_EXT,
        out,
        root: REPO_ROOT,
      });
      return 0;
    }
    case "report": {
      const [file] = rest;
      if (!file) throw new Error(USAGE);
      reportCommand(file, flag(rest, "--out"));
      return 0;
    }
    case "check": {
      const only = flag(rest, "--scenarios");
      const surface = resolveSurface(flag(rest, "--surface") ?? REPO_ROOT, surfaceDefaults(rest));
      return runCheck({
        surface,
        scenarios: only ? only.split(",") : null,
        includeUnderscore: rest.includes("--include-underscore"),
        family: surface.family ?? "3x",
        preflight: !rest.includes("--no-preflight"),
        verbose: rest.includes("--verbose"),
        root: REPO_ROOT,
      });
    }
    case "cold-guess": {
      const [sub, ...args] = rest;
      const only = flag(args, "--intents");
      const intents = only ? only.split(",") : null;
      if (sub === "report") {
        const [file] = args;
        if (!file) throw new Error(USAGE);
        const md = toColdMarkdown(readRows(file));
        const o = flag(args, "--out");
        if (o) writeFileSync(o, md);
        else process.stdout.write(md);
        return 0;
      }
      if (sub === "check") {
        const surface = resolveSurface(flag(args, "--surface") ?? REPO_ROOT, {
          family: "next",
          ...surfaceDefaults(args),
        });
        return runColdCheck(surface, intents, Number(flag(args, "--concurrency") ?? 4));
      }
      if (sub === "run") {
        const models = flagAll(args, "--model");
        const out = flag(args, "--out");
        const specs = flagAll(args, "--surface").map((s) => {
          const eq = s.indexOf("=");
          const spec = eq > 0 ? s.slice(eq + 1) : s;
          const surface = resolveSurface(spec, surfaceDefaults(args));
          return { label: eq > 0 ? s.slice(0, eq) : surface.name, surface };
        });
        if (specs.length === 0 || models.length === 0 || !out) throw new Error(USAGE);
        await runCold({
          surfaces: specs,
          models,
          reps: Number(flag(args, "--reps") ?? 3),
          intents,
          concurrency: Number(flag(args, "--concurrency") ?? 4),
          out,
          providerExt: flag(args, "--provider-ext") ?? DEFAULT_PROVIDER_EXT,
        });
        return 0;
      }
      throw new Error(USAGE);
    }
    default:
      console.error(USAGE);
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
