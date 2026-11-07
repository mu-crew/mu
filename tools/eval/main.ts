// Eval harness CLI. Subcommands: prepare | selftest | run | matrix | report | check (see usage below).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRows, runCold, runColdCheck } from "./cold-guess.ts";
import { toColdMarkdown } from "./cold-report.ts";
import {
  appendResult,
  checkHarnesses,
  isLiveRun,
  loadScenario,
  logPath,
  reportCommand,
  resolveSurface,
  runCheck,
  runLabel,
  runMatrix,
  runOne,
  scenarioIds,
  summary,
  timestamp,
} from "./commands.ts";
import type { FauxStep } from "./faux.ts";
import { parseAutHarness } from "./harness.ts";
import { parseWorkers } from "./mix.ts";
import {
  type Arm,
  defaultMaxLoad,
  type NextJob,
  nextLint,
  nextSelftest,
  runNext,
  runNextCheck,
} from "./nextstep.ts";
import { NEXT_CASES } from "./nextstep-cases.ts";
import { nextReport } from "./nextstep-report.ts";
import { runAut } from "./runner.ts";
import { createSandbox, FAUX_EXT, mu, sh, tmuxSocketPath } from "./sandbox.ts";
import { parseFamily, prepareSurface, surfaceFromDir, surfaceId } from "./surface.ts";
import { tournamentCli } from "./tournament-cli.ts";
import type { Family, Sandbox, Scenario, Surface } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const USAGE = `usage: node tools/eval/main.ts <command>
  prepare <name> <ref>
  selftest [--surface <dir>]
  run <scenario> --surface <spec> --model <m> [--harness pi|claude|codex|cursor-agent|muse] [--workers h1,h2] [--fake-workers] [--family 3x|next] [--scenario-root <dir>] [--provider-ext p] [--keep] [--out f]
  matrix --surface <spec>... --model <m>... [--harness h]... [--workers h1,h2] [--fake-workers] [--family 3x|next] [--scenario-root <dir>] [--scenarios a,b] [--reps 1] [--concurrency 4] [--budget-tokens N] --out <results.jsonl>
  report <results.jsonl> [--out file.md]
  check [--surface <spec>] [--scenarios a,b | --plan] [--harness h]... [--workers h1,h2] [--family 3x|next] [--scenario-root <dir>] [--include-underscore] [--no-preflight] [--verbose]
  cold-guess run --surface [label=]<spec>... --model <m>... [--reps 3] [--intents a,b] [--concurrency 4] [--provider-ext p] --out <cold-guess.jsonl>
  cold-guess check [--surface <spec>] [--intents a,b] [--concurrency 4]
  cold-guess report <cold-guess.jsonl> [--out file.md]
  nextstep run --surface [label=]<spec>... --model <m>... --out <probe.jsonl> [--cases a,b] [--arms none,skill] [--reps 1] [--round b5] [--seed s] [--prompt-dir d] [--concurrency 6] [--model-concurrency 8] [--max-load n] [--provider-ext p]
  nextstep check [--surface <spec>] [--cases a,b] [--concurrency 4]
  nextstep lint [--surface [label=]<spec>...] [--cases a,b]
  nextstep selftest [--surface <spec>] [--cases a,b]
  nextstep report <probe.jsonl> [--round r] [--surface s] [--model m] [--out file.md]
  tournament <sub> ...   (the tournament driver, tools/eval/tournament-cli.ts)
<spec> = <dir|name>[:<3x|next>[:<scenario-root>]]. A name is a surface under ~/.cache/mu/eval/surfaces. Family and scenario root are per
surface; --family/--scenario-root only fill specs that leave them out (defaults: 3x, tools/eval/scenarios). A scenario root holds
<id>.<golden|bad|bad-x>.<family>.json and optional <id>.ts overrides, and must be outside ~/.cache/mu/eval/surfaces.
--harness: the AUT's agent CLI (default pi, over rpc; claude, codex, cursor-agent and muse run in a pane). A hook-harness scenario
(e1_* .. e7_*) needs EVAL_MURMUR=<murmur checkout> (EVAL_MUZZLE=<muzzle checkout> adds muzzle's hooks); its run is live: the user's HOME,
auth and harness binaries (see docs/eval/every-harness.md). --fake-workers keeps fake worker binaries in a live run. --workers picks the
worker harnesses of e1, e3 (implementer,reviewer), e4 and e6 (claude, codex, cursor-agent, muse). check --plan proves the sampled live
plan's rows (tools/eval/mix.ts; --harness narrows it to those AUTs).`;

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

/** `[label=]<spec>` surfaces of a repeatable --surface (default: the checkout, labelled base). */
function labelledSurfaces(args: string[]): { label: string; surface: Surface }[] {
  const specs = flagAll(args, "--surface");
  if (specs.length === 0)
    return [{ label: "base", surface: resolveSurface(REPO_ROOT, { family: "next" }) }];
  return specs.map((s) => {
    const eq = s.indexOf("=");
    const surface = resolveSurface(eq > 0 ? s.slice(eq + 1) : s, {
      family: "next",
      ...surfaceDefaults(args),
    });
    return { label: eq > 0 ? s.slice(0, eq) : surface.name, surface };
  });
}

/** A seeded Fisher-Yates shuffle (mulberry32), so a run's interleaving is reproducible. */
function shuffle<T>(xs: T[], seed: string): T[] {
  let h = 1779033703;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
  const rnd = (): number => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

async function nextstep(rest: string[]): Promise<number> {
  const [sub, ...args] = rest;
  const only = flag(args, "--cases")?.split(",");
  const cases = only ? NEXT_CASES.filter((c) => only.includes(c.id)) : NEXT_CASES;
  if (only && cases.length !== only.length)
    throw new Error(`unknown case in --cases ${only.join(",")}`);
  const one = (): Surface => labelledSurfaces(args)[0]?.surface ?? resolveSurface(REPO_ROOT, {});
  switch (sub) {
    case "check": {
      const r = await runNextCheck(one(), {
        cases,
        concurrency: Number(flag(args, "--concurrency") ?? 4),
      });
      return r.failures === 0 ? 0 : 1;
    }
    case "selftest":
      return nextSelftest(one(), { cases });
    case "lint": {
      const r = nextLint(labelledSurfaces(args), cases);
      for (const f of r.failures) console.log(`FAIL ${f}`);
      for (const c of r.nameCues)
        console.log(`nameCue ${c.case}/${c.paraphrase} on ${c.variant}: "${c.word}"`);
      console.log(
        r.failures.length === 0
          ? "nextstep lint: ok"
          : `nextstep lint: ${r.failures.length} FAILED`,
      );
      return r.failures.length === 0 ? 0 : 1;
    }
    case "report": {
      const [file] = args;
      if (!file) throw new Error(USAGE);
      const r = nextReport(file, {
        round: flag(args, "--round"),
        surface: flag(args, "--surface"),
        model: flag(args, "--model"),
      });
      const o = flag(args, "--out");
      if (r.code !== 0) process.stderr.write(r.text);
      else if (o) writeFileSync(o, r.text);
      else process.stdout.write(r.text);
      return r.code;
    }
    case "run": {
      const surfaces = labelledSurfaces(args);
      const models = flagAll(args, "--model");
      const out = flag(args, "--out");
      if (flagAll(args, "--surface").length === 0 || models.length === 0 || !out)
        throw new Error(USAGE);
      const arms = flagAll(args, "--arms");
      const round = (flag(args, "--round") ?? "b5") as NextJob["round"];
      const reps = Number(flag(args, "--reps") ?? 1);
      const jobs: NextJob[] = [];
      for (const { label, surface } of surfaces)
        for (const c of cases)
          for (const arm of c.arms)
            if (arms.length === 0 || arms.includes(arm))
              for (const p of c.paraphrases)
                for (const model of models)
                  for (let rep = 1; rep <= reps; rep++)
                    jobs.push({
                      round,
                      group: c.group,
                      surfaceLabel: label,
                      surface,
                      model,
                      caseId: c.id,
                      arm: arm as Arm,
                      paraphrase: p.id,
                      rep,
                    });
      const seed = flag(args, "--seed") ?? "nextstep";
      console.log(`${jobs.length} rows planned (seed ${seed})`);
      const r = await runNext({
        jobs: shuffle(jobs, seed),
        out,
        promptDir: flag(args, "--prompt-dir") ?? join(dirname(out), "prompts"),
        concurrency: Number(flag(args, "--concurrency") ?? 6),
        modelConcurrency: Number(flag(args, "--model-concurrency") ?? 8),
        maxLoad: Number(flag(args, "--max-load") ?? defaultMaxLoad()),
        providerExt: flag(args, "--provider-ext"),
        cases,
        onRow: (row) =>
          console.log(
            `${row.hit ? "HIT " : row.partial ? "part" : "miss"} ${row.surface} ${row.model.split("/").pop()} ${row.case}/${row.paraphrase} ${row.arm} rep${row.rep}: ${row.commands[0]?.split("\n")[0]?.slice(0, 90) ?? row.why.join("; ")}`,
          ),
      });
      console.log(`nextstep run: ${r.written} written, ${r.skipped} already in ${out}`);
      return 0;
    }
    default:
      throw new Error(USAGE);
  }
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
      const harness = parseAutHarness(flag(rest, "--harness") ?? "pi");
      if (!checkHarnesses(scenario).includes(harness))
        throw new Error(`${id} does not run under --harness ${harness}`);
      const w = flag(rest, "--workers");
      const workers = w === undefined ? undefined : parseWorkers(w);
      const r = await runOne({
        surface,
        scenario,
        model,
        providerExt: flag(rest, "--provider-ext"),
        rep: 1,
        keep: rest.includes("--keep"),
        harness,
        ...(workers !== undefined ? { workers } : {}),
        live: isLiveRun(scenario, harness),
        fakeWorkers: rest.includes("--fake-workers"),
        log: logPath(REPO_ROOT, timestamp(), {
          scenario: id,
          surface: surfaceId(surface),
          model: runLabel(model, harness, workers),
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
      const harnesses = flagAll(rest, "--harness").map(parseAutHarness);
      const w = flag(rest, "--workers");
      await runMatrix({
        surfaces,
        models,
        ...(harnesses.length > 0 ? { harnesses } : {}),
        ...(w !== undefined ? { workers: parseWorkers(w) } : {}),
        fakeWorkers: rest.includes("--fake-workers"),
        scenarios: only
          ? only.split(",")
          : scenarioIds(false, ...surfaces.map((s) => s.scenarioRoot)),
        reps: Number(flag(rest, "--reps") ?? 1),
        concurrency: Number(flag(rest, "--concurrency") ?? 4),
        budgetTokens: Number(flag(rest, "--budget-tokens") ?? 42_000_000),
        providerExt: flag(rest, "--provider-ext"),
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
      const harnesses = flagAll(rest, "--harness").map(parseAutHarness);
      const w = flag(rest, "--workers");
      const plan = rest.includes("--plan");
      if (plan && (only !== undefined || w !== undefined))
        throw new Error(
          "check --plan names its own scenarios and mixes; drop --scenarios and --workers",
        );
      return runCheck({
        surface,
        scenarios: only ? only.split(",") : null,
        ...(harnesses.length > 0 ? { harnesses } : {}),
        ...(w !== undefined ? { workers: parseWorkers(w) } : {}),
        ...(plan ? { plan } : {}),
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
          providerExt: flag(args, "--provider-ext"),
        });
        return 0;
      }
      throw new Error(USAGE);
    }
    case "nextstep":
      return nextstep(rest);
    case "tournament":
      return tournamentCli(rest);
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
