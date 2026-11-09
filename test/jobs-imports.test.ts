// The job seam holds (spec 2026-11-09-mu-plugins.md, D8, unit P1): every
// multiplexer pane probe outside src/mux (a MuxBackend pane read, a raw tmux,
// herdr or Rex query, of one pane or a listed batch) goes through src/jobs,
// and the lease job's effects (stop, handshake, attach) are reached only
// through the lease kind. A new direct probe or call fails here. A channel's
// own reading (ctl's socket status, murmur's inbox) is not a mux probe: P4.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("the job seam", () => {
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
