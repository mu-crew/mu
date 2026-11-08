// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The fingerprint backstop: the rig's distinctive tokens (scenario, case and row ids, the holdout
// ids, the names the rig's code and tests declare), minus every token the AUT may legitimately see
// (the surface's own text: mu's verbs, flags, messages, help, skill, dist; the rig files staged into
// a sandbox). A tool result that prints a middle range of a rig file (`sed -n 5,15p`, `grep -h`,
// `cd $(…) && grep -rn`) carries no canary and may match no path rule, but it carries the file's
// names: FINGERPRINT_K distinct tokens (1) make the run a rig read; a holdout id is named apart.
//
// Judge-side only: nothing here is staged into a sandbox (rig-guard.ts stageRig follows imports,
// so rig-guard.ts and aut-guard.ts never import this file), and the token set is never written
// where an AUT could read it.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RIG_REPO, RIG_SUBDIRS } from "./rig-guard.ts";
import { stripCanary } from "./rig-private.ts";
import type { ToolCall } from "./types.ts";

/** Never tuned, never mined, never run mid-round (spec §0); tournament-build.ts re-exports it. */
export const HOLDOUTS: readonly string[] = [
  "worker_dies",
  "wait_receipt_race",
  "wrong_id",
  "single_channel_host",
];

/**
 * Distinct tokens one tool result must carry to be a rig read. The false-positive scan of the kept
 * B5 rows (docs/eval/hill-r2/baseline.md, "Fingerprint") found no legitimate output with even one
 * (7918 R4 tool results, 10033 probe and 600 cold-guess texts, every non-holdout scenario's seeded
 * sandbox), so 1: a grep for one judge helper prints mostly that name. A coincidence (a model that
 * invents a rig helper's exact name and sees it echoed) makes an invalid row, never a hit.
 */
export const FINGERPRINT_K = 1;

/** The rig modules stageRig copies into a sandbox (with their imports): the AUT may read them. */
export const STAGED_ENTRIES: readonly string[] = [
  "aut-guard.ts",
  "faux.ts",
  "ssh-shim.ts",
  "fake-harness.ts",
];

export interface Fingerprint {
  /** Distinctive rig tokens no legitimate output carries. */
  tokens: ReadonlySet<string>;
  /** The holdout scenario ids: one alone in an output is a rig read. */
  holdouts: readonly string[];
  k: number;
}

/** A token is distinctive: 6+ chars with a `_`, a `-` or a camelCase hump between letters. */
export const distinctive = (t: string): boolean =>
  t.length >= 6 && /[A-Za-z0-9][_-][A-Za-z0-9]|[a-z0-9][A-Z]/.test(t) && !/^\d/.test(t);

/** The words of a text, hyphenated ids whole and in their parts. */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*(?:-[\w$]+)*/g)) {
    out.add(m[0]);
    if (m[0].includes("-")) for (const p of m[0].split("-")) out.add(p);
  }
  return out;
}

/** The names a TypeScript source declares (functions, bindings, types, methods). */
export function declaredNames(src: string): string[] {
  const out: string[] = [];
  const re =
    /\b(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/gm;
  for (const m of src.matchAll(re)) {
    const n = m[1] ?? m[2];
    if (n !== undefined) out.push(n);
  }
  // destructured bindings: `const { a, b: c } =`
  for (const m of src.matchAll(/\b(?:const|let)\s+\{([^}]*)\}\s*=/g))
    for (const part of (m[1] ?? "").split(","))
      out.push(...[...part.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]));
  return out;
}

/** The ids a rig source spells as `id: "…"` (scenario, case and intent ids). */
export const declaredIds = (src: string): string[] =>
  [...src.matchAll(/\bid:\s*"([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));

/** The ids a rows file name carries: `<scenario>.<variant>.<kind>.json` (a golden or a bad). */
export function rowIds(file: string): string[] {
  const parts = basename(file).split(".");
  if (parts.length < 3 || parts.at(-1) !== "json") return [];
  return parts.slice(0, -2);
}

const git = (repo: string, args: string[]): string[] =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\n")
    .filter((f) => f !== "");

const isRig = (f: string): boolean => RIG_SUBDIRS.some((d) => f === d || f.startsWith(`${d}/`));

const readText = (f: string): string => {
  try {
    if (statSync(f).size > 8 * 1024 * 1024) return "";
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

/** Every file under `dir` except node_modules and the rig subdirs (a built surface). */
function surfaceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  let ents: string[];
  try {
    ents = readdirSync(join(dir, rel));
  } catch {
    return out;
  }
  for (const e of ents) {
    const r = rel === "" ? e : `${rel}/${e}`;
    if (e === "node_modules" || e === ".git" || isRig(r)) continue;
    const abs = join(dir, r);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...surfaceFiles(dir, r));
    else if (st.isFile()) out.push(abs);
  }
  return out;
}

/** The staged closure of STAGED_ENTRIES, as stageRig writes it (canary lines stripped). */
export function stagedSources(evalDir = join(RIG_REPO, "tools", "eval")): Map<string, string> {
  const out = new Map<string, string>();
  const todo = [...STAGED_ENTRIES];
  for (let f = todo.pop(); f !== undefined; f = todo.pop()) {
    if (out.has(f)) continue;
    const src = readText(join(evalDir, f));
    out.set(f, stripCanary(src));
    for (const m of src.matchAll(/(?:from|import)\s+"\.\/([\w.-]+)"/g)) if (m[1]) todo.push(m[1]);
  }
  return out;
}

/**
 * The candidates found as whole words under `dirs` (node_modules, pi's install): too large to read
 * here, so ripgrep reads them, the candidates on its stdin (never in a file an AUT could find).
 * Without ripgrep, none (the B5 scan sets K with that margin).
 */
function foundIn(cands: readonly string[], dirs: readonly string[]): Set<string> {
  const there = dirs.filter((d) => existsSync(d));
  if (there.length === 0 || cands.length === 0) return new Set();
  try {
    const out = execFileSync(
      "rg",
      ["-o", "-w", "-F", "-N", "--no-filename", "-uu", "-f", "-", "--", ...there],
      {
        input: `${cands.join("\n")}\n`,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    return new Set(out.split("\n").filter((w) => w !== ""));
  } catch (e) {
    // exit 1: no match
    const out = (e as { stdout?: unknown }).stdout;
    return new Set(typeof out === "string" ? out.split("\n").filter((w) => w !== "") : []);
  }
}

/** pi's install dir (its bundled packages print in a stack trace or a grep). */
function piDir(): string[] {
  try {
    const bin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    return bin === "" ? [] : [dirname(realpathSync(bin))];
  } catch {
    return [];
  }
}

const cache = new Map<string, Fingerprint>();

/**
 * The fingerprint of the rig in `repo` (default: this checkout), against the surface in
 * `surfaceRoot` (default: the checkout's own non-rig files and its dist/). Built once per process.
 */
export function rigFingerprint(o: { repo?: string; surfaceRoot?: string } = {}): Fingerprint {
  const repo = o.repo ?? RIG_REPO;
  const key = `${repo}\0${o.surfaceRoot ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const files = git(repo, ["ls-files"]);
  const rigTs = files.filter(
    (f) => (f.startsWith("tools/eval/") || f.startsWith("test/eval/")) && /\.tsx?$/.test(f),
  );
  const cand = new Set<string>(HOLDOUTS);
  for (const f of rigTs) {
    const src = readText(join(repo, f));
    for (const n of [...declaredNames(src), ...declaredIds(src)]) cand.add(n);
  }
  for (const f of files.filter((x) => x.startsWith("tools/eval/scenarios/"))) {
    if (f.endsWith(".ts")) cand.add(basename(f, ".ts"));
    for (const id of rowIds(f)) cand.add(id);
  }
  // what the AUT may see: the surface's text and the staged rig modules
  const legit = new Set<string>();
  const surface = [
    ...files.filter((f) => !isRig(f)).map((f) => join(repo, f)),
    ...(existsSync(join(repo, "dist")) ? surfaceFiles(join(repo, "dist")) : []),
    ...(o.surfaceRoot ? surfaceFiles(o.surfaceRoot) : []),
  ];
  for (const f of surface) for (const w of words(readText(f))) legit.add(w);
  for (const src of stagedSources(join(repo, "tools", "eval")).values())
    for (const w of words(src)) legit.add(w);
  const kept = [...cand].filter((t) => distinctive(t) && !legit.has(t));
  const libs = foundIn(kept, [
    join(repo, "node_modules"),
    ...(o.surfaceRoot ? [join(o.surfaceRoot, "node_modules")] : []),
    ...piDir(),
  ]);
  const tokens = new Set(kept.filter((t) => !libs.has(t)));
  const fp: Fingerprint = {
    tokens,
    holdouts: HOLDOUTS.filter((h) => !legit.has(h)),
    k: FINGERPRINT_K,
  };
  cache.set(key, fp);
  return fp;
}

/** What one run may legitimately print: its own scenario id, its own env (names and values). */
export interface FingerprintScope {
  own?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** The fingerprint tokens one text carries (distinct), less the run's own. */
export function fingerprintHits(
  text: string,
  fp: Fingerprint,
  scope: FingerprintScope = {},
): string[] {
  const env = scope.env ? words(Object.entries(scope.env).flat().join(" ")) : new Set<string>();
  return [...words(text)].filter((w) => fp.tokens.has(w) && w !== scope.own && !env.has(w));
}

/**
 * Why one output is a rig read by its fingerprint, or null: a holdout id (other than the run's
 * own scenario), or >= k distinct rig tokens. The reason names counts, never the tokens (a row
 * or a note must not carry holdout or judge names).
 */
export function fingerprintRead(
  text: string,
  fp: Fingerprint,
  scope: FingerprintScope = {},
): string | null {
  const hits = fingerprintHits(text, fp, scope);
  const held = hits.filter((h) => fp.holdouts.includes(h));
  if (held.length > 0) return `holdout id in output (${held.length})`;
  if (hits.length >= fp.k)
    return `rig fingerprint in output (${hits.length} token${hits.length === 1 ? "" : "s"})`;
  return null;
}

/** The fingerprint reads of a pi AUT's tool calls: `#<i> <tool>: <why>` (rigReads' shape). */
export function fingerprintReads(
  calls: readonly Pick<ToolCall, "name" | "output">[],
  fp: Fingerprint,
  scope: FingerprintScope = {},
): string[] {
  return calls.flatMap((c, i) => {
    const why = typeof c.output === "string" ? fingerprintRead(c.output, fp, scope) : null;
    return why === null ? [] : [`#${i} ${c.name}: ${why}`];
  });
}

/** The probe answer's commands whose output carries the fingerprint (nextstep.ts). */
export const fingerprintInOutputs = (
  outputs: readonly string[],
  fp: Fingerprint,
  scope: FingerprintScope = {},
): string[] =>
  outputs.flatMap((o, i) => {
    const why = fingerprintRead(o, fp, scope);
    return why === null ? [] : [`command ${i + 1}: ${why}`];
  });

/**
 * The fingerprint reads in a pane AUT's transcripts (the files its hooks named): one JSONL line is
 * one event, so a line is scanned as one tool result.
 */
export function fingerprintInTranscripts(
  paths: readonly string[],
  fp: Fingerprint,
  scope: FingerprintScope = {},
): string[] {
  return [...new Set(paths)].flatMap((p) => {
    for (const [i, l] of readText(p).split("\n").entries()) {
      const why = fingerprintRead(l, fp, scope);
      if (why !== null) return [`transcript ${basename(p)}:${i + 1}: ${why}`];
    }
    return [];
  });
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
