// Import-aware source scans for the seam guards (test/link-imports.test.ts,
// test/host-imports.test.ts): who takes which binding from a module, by import
// or re-export statement (multi-line, `type`, `as` aliases, `* as`, dynamic
// `import()`), so a renamed import fails as surely as a direct call.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

export const rel = (path: string): string => relative(ROOT, path).split(sep).join("/");

/** `[repo-relative path, text]` of every `.ts` file under src/. */
export const all = (): Array<readonly [string, string]> =>
  sources(SRC).map((p) => [rel(p), readFileSync(p, "utf8")] as const);

export interface Binding {
  /** The module's own name for it (before any `as`). */
  name: string;
  /** "import" or "export" (a re-export). */
  kind: "import" | "export";
}

/** What `file` (repo-relative) takes from the module at repo-relative `target`, by statement. */
export function bindingsFrom(file: string, text: string, target: string): Binding[] | "namespace" {
  const out: Binding[] = [];
  const re =
    /\b(import|export)\s+(?:type\s+)?(?:(\*)\s+as\s+\w+|(\*)|\{([^}]*)\})\s*from\s*["']([^"']+)["']/g;
  const dyn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const hits = (spec: string): boolean =>
    spec.startsWith(".") &&
    rel(resolve(join(ROOT, dirname(file)), spec)).replace(/\.js$/, ".ts") === target;
  for (const m of text.matchAll(dyn)) if (hits(m[1] ?? "")) return "namespace";
  for (const m of text.matchAll(re)) {
    if (!hits(m[5] ?? "")) continue;
    if (m[2] !== undefined || m[3] !== undefined) return "namespace";
    for (const part of (m[4] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) out.push({ name, kind: m[1] === "export" ? "export" : "import" });
    }
  }
  return out;
}

/** The local names a file re-exports without `from` (`export { getHost };`, `export { a as b }`). */
export function localReExports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name =
        part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim() ?? "";
      if (name !== "") out.push(name);
    }
  }
  return out;
}

/** The text of every call of `fn(` in `text`, up to its closing paren. */
export function calls(text: string, fn: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${fn}\\(`, "g");
  for (const m of text.matchAll(re)) {
    let depth = 0;
    let i = m.index + fn.length;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

/** The top-level arguments of one call's text (`fn(a, {b, c}, "d")` → three). */
export function args(call: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of call.slice(call.indexOf("(") + 1, -1)) {
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/**
 * For every line of `text` matching `re` (and not `decl`, the callee's own declaration),
 * the top-level `function` (exported or not) it sits in: the last one declared above it.
 */
export function callersOf(text: string, re: RegExp, decl: RegExp): string[] {
  const callers: string[] = [];
  let fn = "";
  for (const line of text.split("\n")) {
    const d = /^(?:export )?(?:async )?function (\w+)/.exec(line);
    if (d?.[1] !== undefined) fn = d[1];
    if (re.test(line) && !decl.test(line)) callers.push(fn);
  }
  return callers;
}
