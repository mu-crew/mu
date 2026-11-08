// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Tournament variants (spec docs/specs/2026-11-07-hill-r2-tournament.md §3.1, unit B3b): a variant is
// a patch on a copy of the built base surface. This file builds the copy, derives the variant's
// markers and behaviour signature from the patch, decides admission, and hashes the frozen judges
// (§3.2). Manifest and patch parsing live in tournament-patch.ts; packing, the designer launch and
// the isolation audit in tournament-design.ts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { scriptFile } from "./check-rules.ts";
import { withRowClaim } from "./claim.ts";
import { guessEffect } from "./cold-guess.ts";
import { runHelp, subcommands } from "./cold-help.ts";
import { type ColdIntent, INTENTS } from "./cold-intents.ts";
import { EVAL_MODEL_FAUX, loadScenario, runOne } from "./commands.ts";
import { type ExposureSpec, flatText } from "./exposure.ts";
import { scenarioDir } from "./fixtures.ts";
import { fence, type NextCase, playCase, variantsOf } from "./nextstep.ts";
import { muCalls, muOut } from "./observe.ts";
import { HOLDOUTS } from "./rig-fingerprint.ts";
import { FAUX_EXT } from "./sandbox.ts";
import { surfaceDir } from "./surface.ts";
import {
  type ChangedString,
  changedStrings,
  type FilePatch,
  type Manifest,
  parsePatch,
  pathsOutside,
  type RemovedString,
  words,
} from "./tournament-patch.ts";
import type { Sandbox, Surface } from "./types.ts";

// ---- markers ------------------------------------------------------------------------------------

/** The text a surface ships to a model: its built `dist/` (no source maps, no typings) and `skills/`. */
export interface CorpusFile {
  file: string;
  text: string;
}

function walkFiles(dir: string, keep: (p: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkFiles(p, keep) : keep(p) ? [p] : [];
  });
}

export function readCorpus(root: string): CorpusFile[] {
  const files = [
    ...walkFiles(join(root, "dist"), (p) => p.endsWith(".js")),
    ...walkFiles(join(root, "skills"), (p) => p.endsWith(".md")),
  ];
  return files.map((p) => ({ file: relative(root, p), text: flatText(readFileSync(p, "utf8")) }));
}

/** Places (file, offset) where `s` occurs, whitespace collapsed. */
export function places(corpus: readonly CorpusFile[], s: string): number {
  const needle = flatText(s);
  if (needle === "") return 0;
  let n = 0;
  for (const f of corpus)
    for (let i = f.text.indexOf(needle); i >= 0; i = f.text.indexOf(needle, i + 1)) n++;
  return n;
}

export const MIN_MARKER = 12;

export interface DerivedMarkers {
  markers: string[];
  contextMarkers: string[];
  /** Context-marker candidates refused, with why (a string that occurs more than once in base). */
  rejected: { text: string; why: string }[];
}

/**
 * §3.1 steps 2-3. Markers: changed parts of ≥ 12 characters that the variant ships and base ships
 * nowhere. Context markers: removed or rewritten base parts of ≥ 12 characters that occur in
 * exactly one place in base's corpus.
 */
export function deriveMarkers(
  diff: { changed: readonly ChangedString[]; removed: readonly RemovedString[] },
  variant: readonly CorpusFile[],
  base: readonly CorpusFile[],
): DerivedMarkers {
  const long = (s: string): boolean => flatText(s).length >= MIN_MARKER;
  const uniq = (xs: string[]): string[] => [...new Set(xs.map(flatText))];
  const markers = uniq(diff.changed.flatMap((c) => c.parts).filter(long)).filter(
    (m) => places(variant, m) > 0 && places(base, m) === 0,
  );
  const contextMarkers: string[] = [];
  const rejected: DerivedMarkers["rejected"] = [];
  for (const c of uniq(diff.removed.flatMap((r) => r.parts).filter(long))) {
    const n = places(base, c);
    if (n === 1) contextMarkers.push(c);
    else rejected.push({ text: c, why: n === 0 ? "not in base's corpus" : `${n} places in base` });
  }
  return { markers, contextMarkers, rejected };
}

// ---- behaviour signature ------------------------------------------------------------------------

/** §3.1 behaviour step 1: flag and command names on `+` lines of `src/` that base's parser lacks. */
export function newNames(files: readonly FilePatch[], baseVocab: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (!f.path.startsWith("src/")) continue;
    for (const h of f.hunks)
      for (const l of h) {
        if (l.op !== "+") continue;
        for (const m of l.text.matchAll(/\.(?:option|requiredOption)\(\s*["'`]([^"'`]+)["'`]/g))
          for (const flag of (m[1] ?? "").matchAll(/(--?[A-Za-z][\w-]*)/g)) {
            const f1 = flag[1] ?? "";
            const name = f1.replace(/^--?/, "");
            if (f1.startsWith("--") && !baseVocab.has(name)) out.add(f1);
            if (!f1.startsWith("--") && !baseVocab.has(f1)) out.add(f1);
          }
        for (const m of l.text.matchAll(/\.command\(\s*["'`]([A-Za-z][\w-]*)/g)) {
          const name = m[1] ?? "";
          if (!baseVocab.has(name)) out.add(name);
        }
      }
  }
  return [...out].sort();
}

/** One golden run's mu calls in order, each with its own stdout (`mu-out`). */
export interface GoldenTrace {
  /** `nextstep:<case>/<v>`, `cold:<intent>`, `r4:<scenario>`. */
  id: string;
  /** Did the golden hit (nextstep, cold-guess) or come out clean (R4) on this surface? */
  ok: boolean;
  calls: { argv: string; exit: number; out: string }[];
}

/** Nonces, shas, ids, times and counts: what differs between two runs of one golden by chance. */
export function normalise(s: string): string {
  return s
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "<ts>")
    .replace(/\b[0-9a-f]{7,64}\b/g, "<hex>")
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8}\b/g, "<nonce>")
    .replace(/\/[^\s"']*\/(mu-eval|mu-nextstep|mu-cold)[^\s"']*/g, "<path>")
    .replace(/\d+(\.\d+)?/g, "<n>");
}

/** The key-and-type tree of a JSON text (null when it is not JSON). */
export function jsonShape(text: string): string | null {
  const shape = (v: unknown): unknown =>
    Array.isArray(v)
      ? [v.length > 0 ? shape(v[0]) : "empty"]
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, shape((v as Record<string, unknown>)[k])]),
          )
        : v === null
          ? "null"
          : typeof v;
  try {
    return JSON.stringify(shape(JSON.parse(text.trim())));
  } catch {
    return null;
  }
}

/**
 * §3.1 behaviour steps 2-3: pair the mu calls of each golden on base and on the variant by
 * position and (normalised) argv, and return the call keys of every pair whose exit status,
 * `--json` key-and-type tree or normalised output differs. A call with no partner (the runs
 * diverged) is changed too. `baseAgain` is a second base run of the same goldens: a call whose
 * output already differs between the two base runs (a per-row random phrase, a wall-clock count)
 * is compared on exit and JSON shape only, so chance never reads as behaviour.
 */
export function behaviourDiff(
  base: readonly GoldenTrace[],
  variant: readonly GoldenTrace[],
  key: (argv: string) => string,
  baseAgain: readonly GoldenTrace[] = [],
): string[] {
  const out = new Set<string>();
  const vById = new Map(variant.map((t) => [t.id, t]));
  const again = new Map(baseAgain.map((t) => [t.id, t]));
  for (const b of base) {
    const b2 = again.get(b.id);
    const v = vById.get(b.id);
    if (!v) continue;
    const n = Math.max(b.calls.length, v.calls.length);
    for (let i = 0; i < n; i++) {
      const x = b.calls[i];
      const y = v.calls[i];
      if (!x || !y || normalise(x.argv) !== normalise(y.argv)) {
        if (x) out.add(key(x.argv));
        if (y) out.add(key(y.argv));
        continue;
      }
      const x2 = b2?.calls[i];
      const noisy =
        x2 !== undefined &&
        normalise(x2.argv) === normalise(x.argv) &&
        normalise(x2.out) !== normalise(x.out);
      const differs =
        x.exit !== y.exit ||
        jsonShape(x.out) !== jsonShape(y.out) ||
        (!noisy && normalise(x.out) !== normalise(y.out));
      if (differs) out.add(key(x.argv));
    }
  }
  return [...out].sort();
}

/** The surface's command paths (`agent close`, `wait`, …), for call keys. */
export function commandPaths(surface: Surface): string[] {
  const out: string[] = [];
  const walk = (path: string[]): void => {
    const subs = subcommands(runHelp(surface, path));
    for (const s of subs) {
      out.push([...path, s].join(" "));
      if (path.length < 2) walk([...path, s]);
    }
  };
  walk([]);
  return out;
}

export { HOLDOUTS };

const traceOf = (sb: Sandbox): GoldenTrace["calls"] =>
  muCalls(sb, "all").map((m) => ({ argv: m.argv, exit: m.exit, out: muOut(sb, m) }));

/**
 * Run every golden (nextstep cases per lead-in variant, cold-guess intents of the surface's family,
 * R4 goldens of the given scenarios; never a holdout) and record each run's mu calls with their
 * output. The judges are wrapped, not changed: each reads the sandbox before it closes.
 */
export async function collectGoldenTraces(
  surface: Surface,
  o: { cases: readonly NextCase[]; intents?: readonly ColdIntent[]; scenarios?: readonly string[] },
): Promise<GoldenTrace[]> {
  const traces: GoldenTrace[] = [];
  const promptDir = mkdtempSync(join(tmpdir(), "mu-golden-"));
  try {
    for (const c of o.cases)
      for (const { v, paraphrase } of variantsOf(c)) {
        let calls: GoldenTrace["calls"] = [];
        const wrapped: NextCase = {
          ...c,
          judge: async (ctx) => {
            calls = traceOf(ctx.sb);
            return c.judge(ctx);
          },
        };
        const row = await withRowClaim("probe", () =>
          playCase(wrapped, {
            surface,
            surfaceLabel: "golden",
            arm: "none",
            paraphrase,
            promptDir,
            reply: async (st) => ({ text: fence(c.golden(st, v)), tokens: 0 }),
          }),
        );
        traces.push({ id: `nextstep:${c.id}/${v}`, ok: row.hit && !row.invalid, calls });
      }
    const family = surface.family ?? "next";
    for (const intent of o.intents ?? INTENTS) {
      if (!intent.families.includes(family)) continue;
      let calls: GoldenTrace["calls"] = [];
      const wrapped: ColdIntent = {
        ...intent,
        judge: async (ctx) => {
          calls = traceOf(ctx.sb);
          return intent.judge(ctx);
        },
      };
      const r = await withRowClaim("guess", () =>
        guessEffect(wrapped, { ...surface, family }, intent.golden[family]),
      );
      traces.push({
        id: `cold:${intent.id}`,
        ok: r.effect.hit && r.stray.length === 0 && !r.run.timedOut,
        calls,
      });
    }
    for (const id of o.scenarios ?? []) {
      if (HOLDOUTS.includes(id)) throw new Error(`holdout ${id} never runs mid-round`);
      const scenario = await loadScenario(id, surface.scenarioRoot);
      let calls: GoldenTrace["calls"] = [];
      const r = await withRowClaim("aut", () =>
        runOne({
          surface: { ...surface, family },
          scenario: {
            ...scenario,
            judge: async (sb, m) => {
              calls = traceOf(sb);
              return scenario.judge(sb, m);
            },
          },
          model: EVAL_MODEL_FAUX,
          providerExt: FAUX_EXT,
          rep: 1,
          auTScript: join(surface.scenarioRoot ?? scenarioDir(), scriptFile(id, "golden", family)),
          quietMs: scenario.check?.quietMs ?? 2000,
          maxProds: scenario.check?.maxProds ?? 0,
        }),
      );
      traces.push({
        id: `r4:${id}`,
        ok: r.verdict.completed && r.verdict.wrong.length === 0,
        calls,
      });
    }
  } finally {
    rmSync(promptDir, { recursive: true, force: true });
  }
  return traces;
}

// ---- admission ----------------------------------------------------------------------------------

/** §3.1 length cap: max(⌈1.25·base⌉, base + 40), never above base + 120; no counterpart: 120. */
export function lengthCap(base: number | null): number {
  if (base === null) return 120;
  return Math.min(Math.max(Math.ceil(1.25 * base), base + 40), base + 120);
}

export function lengthViolations(changed: readonly ChangedString[]): string[] {
  return changed.flatMap((c) => {
    const len = flatText(c.text).length;
    const cap = lengthCap(c.base === null ? null : flatText(c.base).length);
    return len > cap
      ? [`${c.file}: changed string of ${len} chars over its cap ${cap}: ${c.text.slice(0, 60)}`]
      : [];
  });
}

const wc = (p: string): number => (existsSync(p) ? words(readFileSync(p, "utf8")).length : 0);

/** SKILL.md and recipe word counts (`wc -w`). */
export function skillWords(root: string): { skill: number; recipes: number } {
  const dir = join(root, "skills", "mu");
  const rdir = join(dir, "recipes");
  const recipes = existsSync(rdir)
    ? readdirSync(rdir)
        .filter((f) => f.endsWith(".md"))
        .reduce((t, f) => t + wc(join(rdir, f)), 0)
    : 0;
  return { skill: wc(join(dir, "SKILL.md")), recipes };
}

export const SKILL_CAP = 600;
export const RECIPES_CAP = 4000;

/** The driver's text delta (§3.1): SKILL.md and recipe word delta, plus changed literal characters. */
export function textDelta(
  changed: readonly ChangedString[],
  base: { skill: number; recipes: number },
  variant: { skill: number; recipes: number },
): number {
  const chars = changed
    .filter((c) => !c.file.startsWith("skills/"))
    .reduce((t, c) => t + flatText(c.text).length - flatText(c.base ?? "").length, 0);
  return variant.skill - base.skill + (variant.recipes - base.recipes) + chars;
}

export interface Admission {
  ok: boolean;
  failures: string[];
}

/** §3.1 admission: each failure blocks, and all of them go into the `variant` row. */
export function admit(o: {
  files: readonly FilePatch[];
  built: { ok: boolean; why?: string };
  helpExit: number;
  words: { skill: number; recipes: number };
  changed: readonly ChangedString[];
  spec: ExposureSpec;
}): Admission {
  const failures: string[] = [];
  for (const p of pathsOutside(o.files))
    failures.push(`touches ${p} (only src/, extension/, skills/)`);
  if (o.files.some((f) => f.binary)) failures.push("binary patch");
  if (!o.built.ok) failures.push(`build failed: ${o.built.why ?? ""}`.trim());
  else if (o.helpExit !== 0) failures.push(`node dist/cli.js --help exited ${o.helpExit}`);
  if (o.words.skill > SKILL_CAP) failures.push(`SKILL.md ${o.words.skill} words > ${SKILL_CAP}`);
  if (o.words.recipes > RECIPES_CAP)
    failures.push(`recipes ${o.words.recipes} words > ${RECIPES_CAP}`);
  failures.push(...lengthViolations(o.changed));
  const s = o.spec;
  if (s.markers.length === 0 && s.newNames.length === 0 && s.changedCalls.length === 0)
    failures.push("inert: no derived marker, no new name and no changed call");
  return { ok: failures.length === 0, failures };
}

// ---- building a variant -------------------------------------------------------------------------

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Copy a dir: an APFS clone where the platform has one (node_modules is large), else a copy. */
export function cloneDir(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  try {
    execFileSync(
      "cp",
      process.platform === "darwin" ? ["-c", "-R", from, to] : ["-a", "--reflink=auto", from, to],
      {
        stdio: "ignore",
      },
    );
  } catch {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
}

/**
 * §3.1 build: copy the base surface dir (with `node_modules`) to `hill2-<v>`, `git apply --check`
 * then `git apply`, `npm run build`, stamp `.ref = <base sha>+<sha256(patch)[:12]>`. Reuses a
 * built copy with the same stamp. Never throws on a bad patch or build: admission reports it.
 */
export function buildVariant(
  baseRoot: string,
  baseSha: string,
  variantId: string,
  patchFile: string,
  dir: string = surfaceDir(`hill2-${variantId}`),
): { dir: string; ref: string; built: { ok: boolean; why?: string }; helpExit: number } {
  const patch = readFileSync(patchFile);
  const ref = `${baseSha}+${sha256(patch).slice(0, 12)}`;
  const stamp = join(dir, ".ref");
  const help = (): number => {
    try {
      execFileSync("node", [join(dir, "dist", "cli.js"), "--help"], {
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), MU_SYNC_DIR: "" },
      });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? 1;
    }
  };
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === ref)
    return { dir, ref, built: { ok: true }, helpExit: help() };
  cloneDir(baseRoot, dir);
  rmSync(stamp, { force: true });
  const step = (cmd: string, args: string[]): string | null => {
    try {
      execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      return null;
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string };
      return `${cmd} ${args.join(" ")}: ${(err.stderr || err.stdout || String(e)).trim().slice(-400)}`;
    }
  };
  const why =
    step("git", ["apply", "--check", patchFile]) ??
    step("git", ["apply", patchFile]) ??
    step("npm", ["run", "build"]);
  if (why !== null) return { dir, ref, built: { ok: false, why }, helpExit: -1 };
  writeFileSync(stamp, `${ref}\n`);
  return { dir, ref, built: { ok: true }, helpExit: help() };
}

/** Every `<v>.json` + `<v>.patch` pair under `tools/eval/candidates/<group>/` (any depth). */
export function listCandidates(candDir: string): { manifest: string; patch: string }[] {
  return walkFiles(candDir, (p) => p.endsWith(".json") && !p.endsWith("brief.json"))
    .map((manifest) => ({ manifest, patch: manifest.replace(/\.json$/, ".patch") }))
    .filter((c) => existsSync(c.patch))
    .sort((a, b) => a.manifest.localeCompare(b.manifest));
}

/** The `variant` control row (§6). */
export interface VariantRow {
  kind: "variant";
  id: string;
  session: string;
  manifest: Manifest;
  patchSha: string;
  ref: string;
  dir: string;
  spec: ExposureSpec;
  rejectedContext: DerivedMarkers["rejected"];
  textDelta: number;
  admission: Admission;
  /** Goldens that hit on base and stop hitting on the variant: recorded, never blocking. */
  goldenCompat: { broken: string[] };
}

/** Everything about one candidate except the golden runs, which the caller supplies. */
export function assessVariant(o: {
  manifest: Manifest;
  session: string;
  patchText: string;
  build: ReturnType<typeof buildVariant>;
  baseRoot: string;
  baseVocab: ReadonlySet<string>;
  baseTraces: readonly GoldenTrace[];
  /** A second base run of the goldens: its noise is not behaviour. */
  baseAgain?: readonly GoldenTrace[];
  variantTraces: readonly GoldenTrace[];
  key: (argv: string) => string;
}): VariantRow {
  const files = parsePatch(o.patchText);
  const diff = changedStrings(files);
  const built = o.build.built.ok;
  const vCorpus = built ? readCorpus(o.build.dir) : [];
  const d = deriveMarkers(diff, vCorpus, readCorpus(o.baseRoot));
  const spec: ExposureSpec = {
    markers: d.markers,
    contextMarkers: d.contextMarkers,
    newNames: newNames(files, o.baseVocab),
    changedCalls: built ? behaviourDiff(o.baseTraces, o.variantTraces, o.key, o.baseAgain) : [],
  };
  const baseWords = skillWords(o.baseRoot);
  const vWords = built ? skillWords(o.build.dir) : baseWords;
  const vOk = new Map(o.variantTraces.map((t) => [t.id, t.ok]));
  return {
    kind: "variant",
    id: o.manifest.id,
    session: o.session,
    manifest: o.manifest,
    patchSha: sha256(o.patchText),
    ref: o.build.ref,
    dir: o.build.dir,
    spec,
    rejectedContext: d.rejected,
    textDelta: textDelta(diff.changed, baseWords, vWords),
    admission: admit({
      files,
      built: o.build.built,
      helpExit: o.build.helpExit,
      words: vWords,
      changed: diff.changed,
      spec,
    }),
    goldenCompat: {
      broken: o.baseTraces.filter((t) => t.ok && vOk.get(t.id) === false).map((t) => t.id),
    },
  };
}

// ---- frozen judges ------------------------------------------------------------------------------

/**
 * §3.2 judgesHash: the git tree hash of `tools/eval/` (without `candidates/`) plus
 * `test/eval/fixtures/` as they are in the working tree, through a throwaway index.
 */
export function judgesHash(repo: string): { hash: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "mu-judges-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
  try {
    git(["read-tree", "--empty"]);
    const paths = ["tools/eval", "test/eval/fixtures"].filter((p) => existsSync(join(repo, p)));
    git(["add", "-A", "--", ...paths]);
    git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "tools/eval/candidates"]);
    return { hash: git(["write-tree"]), files: git(["ls-files"]).split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
