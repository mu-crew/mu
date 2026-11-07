// Tournament patches (spec docs/specs/2026-11-07-hill-r2-tournament.md §3.1, unit B3b): the variant
// manifest, the unified-diff parser and the changed strings of a patch (literal segments and skill
// word runs) that markers and the length cap are derived from. Pure text; tournament-build.ts uses it.
import type { Group } from "./nextstep.ts";

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

export const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");

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
