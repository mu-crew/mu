// Tournament variants (spec docs/specs/2026-11-07-hill-r2-tournament.md §3.1, unit B3b): a variant is
// a patch on a copy of the built base surface. This file reads the manifest, builds the copy, derives
// the variant's markers and behaviour signature from the patch, decides admission, and hashes the
// frozen judges (§3.2). Packing, the designer launch and the isolation audit live in
// tournament-design.ts.
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
import { guessEffect } from "./cold-guess.ts";
import { runHelp, subcommands } from "./cold-help.ts";
import { type ColdIntent, INTENTS } from "./cold-intents.ts";
import { EVAL_MODEL_FAUX, loadScenario, runOne } from "./commands.ts";
import { type ExposureSpec, flatText } from "./exposure.ts";
import { scenarioDir } from "./fixtures.ts";
import { fence, type Group, type NextCase, playCase, variantsOf } from "./nextstep.ts";
import { muCalls, muOut } from "./observe.ts";
import { FAUX_EXT } from "./sandbox.ts";
import { surfaceDir } from "./surface.ts";
import type { Sandbox, Surface } from "./types.ts";

// ---- manifest -----------------------------------------------------------------------------------

export type VariantKind = "output" | "verb" | "error" | "skill" | "recipe";
const KINDS: readonly VariantKind[] = ["output", "verb", "error", "skill", "recipe"];

/** `<v>.json` next to `<v>.patch` (§3.1). It carries no markers: the driver derives them. */
export interface Manifest {
  id: string;
  group: Group;
  kind: VariantKind[];
  summary: string;
}

/** A manifest as read, or the reason it is refused. */
export function parseManifest(text: string, group: Group): Manifest {
  const m = JSON.parse(text) as Partial<Manifest> & Record<string, unknown>;
  const bad = (why: string): never => {
    throw new Error(`manifest refused: ${why}`);
  };
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(m.id)) bad(`id ${String(m.id)}`);
  if (m.group !== group) bad(`group ${String(m.group)} is not ${group}`);
  if (!Array.isArray(m.kind) || m.kind.length === 0 || !m.kind.every((k) => KINDS.includes(k)))
    bad(`kind ${JSON.stringify(m.kind)}`);
  if (typeof m.summary !== "string" || m.summary.trim() === "" || m.summary.includes("\n"))
    bad("summary must be one line");
  for (const k of Object.keys(m))
    if (!["id", "group", "kind", "summary"].includes(k)) bad(`unknown field ${k}`);
  return m as Manifest;
}

// ---- unified diff -------------------------------------------------------------------------------

export interface HunkLine {
  op: " " | "+" | "-";
  text: string;
}
export interface FilePatch {
  /** The path after the patch (the old path for a deletion), without `a/` or `b/`. */
  path: string;
  oldPath: string | null;
  binary: boolean;
  hunks: HunkLine[][];
}

const stripAB = (p: string): string | null =>
  p === "/dev/null" ? null : (p.replace(/^[ab]\//, "").split("\t")[0] ?? p);

/** A `git diff` patch split into files and hunks. */
export function parsePatch(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let hunk: HunkLine[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
      cur = { path: m?.[2] ?? "", oldPath: m?.[1] ?? null, binary: false, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (cur === null) continue;
    if (hunk === null || line.startsWith("@@")) {
      if (line.startsWith("--- ")) cur.oldPath = stripAB(line.slice(4));
      else if (line.startsWith("+++ ")) cur.path = stripAB(line.slice(4)) ?? cur.oldPath ?? "";
      else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch"))
        cur.binary = true;
      if (line.startsWith("@@")) {
        hunk = [];
        cur.hunks.push(hunk);
      }
      continue;
    }
    const op = line[0];
    if (op === " " || op === "+" || op === "-") hunk.push({ op, text: line.slice(1) });
    else if (line === "") hunk.push({ op: " ", text: "" });
  }
  return files.filter((f) => f.path !== "");
}

/** Patch paths outside `src/`, `extension/` and `skills/` (admission refuses them). */
export function pathsOutside(files: readonly FilePatch[]): string[] {
  const ok = (p: string | null): boolean => p === null || /^(src|extension|skills)\//.test(p);
  return files.flatMap((f) => [f.path, f.oldPath]).filter((p): p is string => !ok(p));
}

// ---- changed strings ----------------------------------------------------------------------------

/** One string the patch changed (§3.1 step 1). */
export interface ChangedString {
  file: string;
  /** The new string: a literal's content, or a skill paragraph or list item. */
  text: string;
  /** Its changed parts: a literal's segments (split at `${…}`), or a paragraph's added word runs. */
  parts: string[];
  /** The base string it replaced, by position in the hunk; null when it replaced none. */
  base: string | null;
}

/** A string the patch removed or rewrote: its parts are context-marker candidates (step 3). */
export interface RemovedString {
  file: string;
  text: string;
  parts: string[];
}

interface Literal {
  text: string;
  parts: string[];
}

/**
 * The string literals of one source line: quotes, double quotes and backticks; a template splits
 * at `${…}` into its literal segments. A line comment ends the scan; a comment line is skipped.
 * An unterminated literal (a template that spans lines) runs to the end of the line.
 */
export function stringLiterals(line: string): Literal[] {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return [];
  const out: Literal[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      i++;
      continue;
    }
    const parts: string[] = [];
    let seg = "";
    let text = "";
    i++;
    while (i < line.length && line[i] !== ch) {
      const c = line[i] ?? "";
      if (c === "\\") {
        seg += c + (line[i + 1] ?? "");
        text += c + (line[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === "`" && c === "$" && line[i + 1] === "{") {
        parts.push(seg);
        seg = "";
        let depth = 0;
        const from = i;
        for (; i < line.length; i++) {
          if (line[i] === "{") depth++;
          else if (line[i] === "}" && --depth === 0) break;
        }
        text += line.slice(from, i + 1);
        i++;
        continue;
      }
      seg += c;
      text += c;
      i++;
    }
    i++;
    parts.push(seg);
    out.push({ text, parts: parts.filter((p) => p.trim() !== "") });
  }
  return out;
}

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");

/** Paragraphs and list items of markdown lines: a blank line, a list item or a heading starts one. */
export function mdBlocks(lines: readonly string[]): string[] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  const flush = (): void => {
    if (cur.length > 0) blocks.push(cur);
    cur = [];
  };
  for (const l of lines) {
    if (l.trim() === "") {
      flush();
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s|^#{1,6}\s/.test(l)) flush();
    cur.push(l.trim());
  }
  flush();
  return blocks.map((b) => words(b.join(" ")).join(" "));
}

/** Word diff by LCS: the runs `b` added to `a`, and the runs it dropped from `a`. */
export function wordDiff(a: string, b: string): { added: string[]; removed: string[] } {
  const x = words(a);
  const y = words(b);
  const L: number[][] = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0),
  );
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      (L[i] as number[])[j] =
        x[i] === y[j]
          ? (L[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(L[i + 1]?.[j] ?? 0, L[i]?.[j + 1] ?? 0);
  const added: string[] = [];
  const removed: string[] = [];
  let ra: string[] = [];
  let rr: string[] = [];
  const flush = (): void => {
    if (ra.length > 0) added.push(ra.join(" "));
    if (rr.length > 0) removed.push(rr.join(" "));
    ra = [];
    rr = [];
  };
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      flush();
      i++;
      j++;
    } else if (j < y.length && (i >= x.length || (L[i]?.[j + 1] ?? 0) >= (L[i + 1]?.[j] ?? 0))) {
      ra.push(y[j] ?? "");
      j++;
    } else {
      rr.push(x[i] ?? "");
      i++;
    }
  }
  flush();
  return { added, removed };
}

/** §3.1 step 1: the changed and the removed strings of every hunk. */
export function changedStrings(files: readonly FilePatch[]): {
  changed: ChangedString[];
  removed: RemovedString[];
} {
  const changed: ChangedString[] = [];
  const removed: RemovedString[] = [];
  for (const f of files) {
    const skill = f.path.startsWith("skills/");
    for (const h of f.hunks) {
      if (skill) {
        const oldB = mdBlocks(h.filter((l) => l.op !== "+").map((l) => l.text));
        const newB = mdBlocks(h.filter((l) => l.op !== "-").map((l) => l.text));
        const gone = oldB.filter((b) => !newB.includes(b));
        const added = newB.filter((b) => !oldB.includes(b));
        added.forEach((text, k) => {
          const base = gone[k] ?? null;
          const d = base === null ? { added: [text], removed: [] } : wordDiff(base, text);
          changed.push({ file: f.path, text, parts: d.added, base });
          if (base !== null) removed.push({ file: f.path, text: base, parts: d.removed });
        });
        for (const base of gone.slice(added.length))
          removed.push({ file: f.path, text: base, parts: [base] });
        continue;
      }
      const lits = (op: "+" | "-"): Literal[] =>
        h.filter((l) => l.op === op).flatMap((l) => stringLiterals(l.text));
      const plus = lits("+");
      const minus = lits("-");
      const minusText = new Set(minus.map((l) => l.text));
      const plusText = new Set(plus.map((l) => l.text));
      const gone = minus.filter((l) => !plusText.has(l.text));
      const added = plus.filter((l) => !minusText.has(l.text));
      added.forEach((l, k) => {
        changed.push({ file: f.path, text: l.text, parts: l.parts, base: gone[k]?.text ?? null });
      });
      // a rewritten literal's removed parts are the segments its replacement dropped
      gone.forEach((l, k) => {
        const now = added[k]?.parts ?? [];
        removed.push({
          file: f.path,
          text: l.text,
          parts: l.parts.filter((p) => !now.includes(p)),
        });
      });
    }
  }
  return { changed, removed };
}

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

/** Never tuned, never mined, never run mid-round (§0). */
export const HOLDOUTS = ["worker_dies", "wait_receipt_race", "wrong_id", "single_channel_host"];

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
        const row = await playCase(wrapped, {
          surface,
          surfaceLabel: "golden",
          arm: "none",
          paraphrase,
          promptDir,
          reply: async (st) => ({ text: fence(c.golden(st, v)), tokens: 0 }),
        });
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
      const r = await guessEffect(wrapped, { ...surface, family }, intent.golden[family]);
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
      const r = await runOne({
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
      });
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
