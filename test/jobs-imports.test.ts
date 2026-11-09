// The job seam holds (spec 2026-11-09-mu-plugins.md, D8, unit P1): every
// multiplexer pane probe outside src/mux (a MuxBackend pane read, a raw tmux,
// herdr or Rex query, of one pane or a listed batch) goes through src/jobs,
// and the lease job's effects (stop, handshake, attach) are reached only
// through the lease kind. A new direct probe or call fails here. A channel's
// own reading (ctl's socket status, murmur's inbox) is not a mux probe; that it
// never decides liveness alone is test/channel-names.test.ts (P4). The line
// scan is backed by an import-aware one (the TypeScript AST): a probe method
// destructured off a backend, and a probe imported (named, aliased or as a
// namespace) from a backend module.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

const rel = (path: string): string => relative(ROOT, path).split(sep).join("/");

/** `file:line` of every line matching `re` outside the allowed files. */
function hits(re: RegExp, allowed: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const path of sources(SRC)) {
    const file = rel(path);
    if (allowed(file)) continue;
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line)) out.push(`${file}:${i + 1}`);
      });
  }
  return out;
}

/**
 * Every form of a multiplexer pane probe (the P1 ruling): a `MuxBackend` pane
 * read (the `opts.paneAlive` callback that admission takes is not one: it is
 * handed `viewRunning`), a raw backend executor, a backend binary run by hand,
 * a tmux pane-query word or pane format, and herdr's pane get/list.
 */
const PROBES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "MuxBackend pane read",
    /(?<!opts)\.(paneAlive|paneResult|paneOccupied|paneStatus|panePid|listPanes)\b/,
  ],
  ["raw backend executor", /\b(tmux|herdr|rex)\(/],
  [
    "backend binary run by hand",
    /\b(execFileCapture|execGroupCapture|execa|execaSync|execFile|execFileSync|spawn|spawnSync)\(\s*["'](tmux|herdr|rex)["']/,
  ],
  ["tmux pane query", /["'](list-panes|has-session|display-message)["']/],
  ["tmux pane format", /#\{pane_[a-z_]+\}/],
  ["herdr pane read", /["']pane["']\s*,\s*["'](get|list)["']/],
];

/** The probe forms `line` holds. */
const probesIn = (line: string): string[] =>
  PROBES.filter(([, re]) => re.test(line)).map(([name]) => name);

/**
 * Where a probe may run: src/mux/ and src/jobs/, and reconcile's own
 * `listPanes` (plugins spec D8: "reconcile's listPanes stays as it is"; the
 * same list feeds its orphan scan, src/reconcile.ts:146-155).
 */
const allowed = (file: string, line: string): boolean =>
  file.startsWith("src/mux/") ||
  file.startsWith("src/jobs/") ||
  (file === "src/reconcile.ts" && /\bmux\.listPanes\(sessionName\)/.test(line));

/** The MuxBackend pane reads, as method names. */
const PROBE_METHODS = new Set([
  "paneAlive",
  "paneResult",
  "paneOccupied",
  "paneStatus",
  "panePid",
  "listPanes",
]);
/** The probes a backend module exports: the pane reads and the raw executors. */
const PROBE_EXPORTS = new Set([...PROBE_METHODS, "tmux", "herdr", "rex"]);
/** The backend modules (and the barrels that re-export them), as `src/`-relative paths. */
const BACKEND_MODULES = new Set([
  "src/tmux.ts",
  "src/mux.ts",
  "src/mux/index.ts",
  "src/mux/tmux.ts",
  "src/mux/herdr.ts",
  "src/mux/rex.ts",
]);

/** The repo-relative `.ts` path an import specifier in `file` names; undefined for a package. */
function resolveSpecifier(file: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  return posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, ".ts");
}

/** A destructured key's name: `paneAlive`, `"paneAlive"`, or a computed `["paneAlive"]`. */
function bindingKey(key: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return key.text;
  if (ts.isComputedPropertyName(key)) {
    const e = key.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}

/** The probes `text` reaches by import or destructuring, as `line form` strings. */
function importedProbes(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = resolveSpecifier(file, node.moduleSpecifier.text);
      const clause = node.importClause;
      if (from !== undefined && BACKEND_MODULES.has(from) && clause && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          out.push(`${at(node)} namespace import of ${from}`);
        } else if (bindings !== undefined) {
          for (const el of bindings.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && PROBE_EXPORTS.has(name)) {
              out.push(`${at(el)} import ${name} from ${from}`);
            }
          }
        }
      }
    }
    if (ts.isObjectBindingPattern(node)) {
      for (const el of node.elements) {
        const key = bindingKey(el.propertyName ?? el.name);
        if (key !== undefined && PROBE_METHODS.has(key)) {
          out.push(`${at(el)} destructured ${key}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("the job seam", () => {
  it("no probe is imported or destructured outside src/mux and src/jobs (import-aware)", () => {
    const out: string[] = [];
    for (const path of sources(SRC)) {
      const file = rel(path);
      if (file.startsWith("src/mux/") || file.startsWith("src/jobs/")) continue;
      for (const hit of importedProbes(file, readFileSync(path, "utf8"))) {
        out.push(`${file}:${hit}`);
      }
    }
    expect(out).toEqual([]);
  });

  it("each import-aware form is caught, one planted source per form", () => {
    const planted: ReadonlyArray<readonly [string, string, string]> = [
      ["destructured off activeMux", "src/a.ts", "const { paneAlive } = await activeMux();"],
      ["destructured, renamed", "src/a.ts", "const { paneResult: r } = mux;"],
      ["destructured in a parameter", "src/a.ts", "function f({ listPanes }) {}"],
      [
        "computed-key destructuring",
        "src/a.ts",
        'const { ["paneAlive"]: up } = await activeMux(); return up("%1");',
      ],
      ["string-key destructuring", "src/a.ts", 'const { "paneStatus": s } = mux;'],
      ["named import", "src/a.ts", 'import { tmux } from "./tmux.js";'],
      ["aliased import", "src/agents/a.ts", 'import { paneAlive as up } from "../mux/tmux.js";'],
      ["herdr executor", "src/a.ts", 'import { herdr } from "./mux/herdr.js";'],
      ["rex probe", "src/cli/a.ts", 'import { panePid } from "../mux/rex.js";'],
      ["namespace import", "src/a.ts", 'import * as t from "./tmux.js";'],
    ];
    for (const [form, file, text] of planted) {
      expect(importedProbes(file, text), form).not.toEqual([]);
    }
    // Not probes: sleep from the tmux module, a type, another module's same-named export.
    for (const [file, text] of [
      ["src/a.ts", 'import { sleep } from "./tmux.js";'],
      ["src/a.ts", 'import type { MuxPane } from "./mux.js";'],
      ["src/a.ts", 'import { type PaneResult, activeMux } from "./mux.js";'],
      ["src/a.ts", 'import { paneUp } from "./jobs/pane.js";'],
      ["src/a.ts", "const { name, paneId } = agent;"],
    ] as const) {
      expect(importedProbes(file, text), text).toEqual([]);
    }
  });

  it("every multiplexer pane probe runs in src/mux or src/jobs", () => {
    const out: string[] = [];
    for (const path of sources(SRC)) {
      const file = rel(path);
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (allowed(file, line)) return;
          for (const form of probesIn(line)) out.push(`${file}:${i + 1} ${form}`);
        });
    }
    expect(out).toEqual([]);
  });

  it("each probe form is caught, one planted line per form", () => {
    const planted: ReadonlyArray<readonly [string, string]> = [
      ["paneAlive", "if (await mux.paneAlive(agent.paneId)) return;"],
      ["paneStatus", "const s = await mux.paneStatus?.(agent.paneId);"],
      ["paneResult", "const r = await mux.paneResult(paneId);"],
      ["paneOccupied", "return mux.paneOccupied(paneId);"],
      ["panePid", "const pid = await mux.panePid?.(id);"],
      ["listPanes", "const panes = await (await activeMux()).listPanes(session);"],
      ["list-panes argv", 'const out = await tmux(["list-panes", "-a", "-F", "x"]);'],
      ["list-panes by hand", 'await execFileCapture("tmux", ["list-panes", "-a"]);'],
      ["display-message pane_dead", '["display-message", "-p", "-t", id, "#{pane_dead}"],'],
      ["display-message pane_id", '  "#{pane_id}",'],
      ["has-session", 'await run(["has-session", "-t", "=mu-a"]);'],
      ["herdr pane get", 'await herdr(["pane", "get", paneId]);'],
      ["herdr by hand", 'await execa("herdr", ["pane", "list", "--workspace", ws]);'],
      ["rex", 'await rex(["capture", "-s", s, "-b", paneId]);'],
    ];
    for (const [name, line] of planted) {
      expect(allowed("src/planted.ts", line), name).toBe(false);
      expect(probesIn(line), name).not.toEqual([]);
    }
    // Not probes: the admission callback, the reconcile exception, a pane id column.
    expect(probesIn("opts.paneAlive === undefined ? {} : { paneAlive: opts.paneAlive },")).toEqual(
      [],
    );
    expect(
      allowed("src/reconcile.ts", "  const muxPanes = await mux.listPanes(sessionName);"),
    ).toBe(true);
    expect(allowed("src/reconcile.ts", "await mux.paneAlive(id);")).toBe(false);
    expect(probesIn("WHERE a.id = ? AND a.pane_id = ?")).toEqual([]);
  });

  it("the lease stop, handshake and attach are called only by the lease kind", () => {
    expect(
      hits(/\brunStop\(/, (f) => f === "src/carrier-stop.ts" || f === "src/jobs/lease.ts"),
    ).toEqual([]);
    expect(
      hits(/\battachCommand\b/, (f) => f === "src/remote-agent.ts" || f === "src/jobs/lease.ts"),
    ).toEqual([]);
    expect(hits(/function awaitLeaseJob\b/, (f) => f === "src/jobs/lease.ts")).toEqual([]);
  });

  it("the row rule and teardown use view presence, never liveness", () => {
    for (const f of ["src/agents/close.ts", "src/workstream.ts"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect(text, f).toContain("viewPresent(");
      expect(text, f).not.toMatch(/\bjob(Liveness|Running)\(/);
    }
  });
});
