// The job seam holds (spec 2026-11-09-mu-plugins.md, D8, unit P1): every
// "does this pane exist / run / exit" probe outside src/mux, of one pane or a
// listed batch, goes through src/jobs, and the lease job's effects (stop,
// handshake, attach) are reached only through the lease kind. A new direct
// probe, list or call fails here.

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

describe("the job seam", () => {
  it("pane probes run only in src/mux and src/jobs", () => {
    const probe = /\.pane(Alive|Occupied)\s*\(|\.paneResult\b/;
    const inSeam = (f: string): boolean => f.startsWith("src/mux/") || f.startsWith("src/jobs/");
    expect(hits(probe, inSeam)).toEqual([]);
  });

  it("pane lists run only in src/mux and src/jobs, and reconcile's by the spec", () => {
    // A listed pane set is view presence too: a batched "is it alive". Only
    // reconcile keeps its own `listPanes` (plugins spec D8: "reconcile's
    // listPanes stays as it is"), which also feeds its orphan scan.
    const list = /["']list-panes["']|\.listPanes\s*\(/;
    const allowed = (f: string): boolean =>
      f.startsWith("src/mux/") || f.startsWith("src/jobs/") || f === "src/reconcile.ts";
    expect(hits(list, allowed)).toEqual([]);
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
