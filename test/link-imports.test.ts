// The link seam holds (spec 2026-11-09-mu-plugins.md, D7, unit P2): every
// remote template runs through the host link (src/host-link.ts), the lease
// kind (`runStop`, src/carrier-stop.ts) or `checkHost`. The guard reads import
// and re-export statements (multi-line, `type`, `as` aliases), so a renamed
// import of the template runner fails here as surely as a direct call.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { all, args, bindingsFrom, calls, localReExports, SRC } from "./_imports.js";

/** The template runner's entry points: running one is running a template. */
const RUNNER = new Set(["runLeasedTemplate", "runHostTemplate"]);

/**
 * Who may take the runner from src/hosts.ts: the link, the lease kind's stop, and the SDK
 * barrel (a re-export; nothing in src imports the barrel, checked below).
 */
const RUNNER_OK = new Set(["src/host-link.ts", "src/carrier-stop.ts", "src/index.ts"]);

/** `file: name` for every runner binding outside the allowed files, or the namespace import. */
function runnerTakers(files: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    if (file === "src/hosts.ts") continue;
    const b = bindingsFrom(file, text, "src/hosts.ts");
    if (b === "namespace") {
      out.push(`${file}: * from hosts`);
      continue;
    }
    // The barrel only re-exports; the link and the stop only import (a re-export there
    // would hand the runner on to anyone importing them).
    const barrel = file === "src/index.ts";
    for (const { name, kind } of b) {
      if (!RUNNER.has(name)) continue;
      if (RUNNER_OK.has(file) && barrel === (kind === "export")) continue;
      out.push(`${file}: ${kind === "export" ? "re-export " : ""}${name}`);
    }
    // Nor a local re-export of the imported binding (`export { runLeasedTemplate };`).
    if (!barrel) {
      for (const name of localReExports(text)) {
        if (RUNNER.has(name)) out.push(`${file}: re-export ${name}`);
      }
    }
  }
  return out;
}

/**
 * Outside the runner and the link, an expansion may only fill a pane command or show one
 * (the lease kind's check expands `stop`, never running it): the template is a `.shell`,
 * `.stop` or `.attach` field, and a scope, when given, is a literal
 * other than exec or fetch. Anything else (an identifier holding the exec bytes, no
 * scope, a computed scope) may be the exec or fetch template run by hand.
 */
function expandsExecOrFetch(call: string): boolean {
  const [template, , scope, ...rest] = args(call);
  if (rest.length > 0 || template === undefined) return true;
  if (!/^[\w.?]+\.(shell|stop|attach)$/.test(template)) return true;
  if (scope === undefined) return false;
  const lit = /^["']([\w-]+)["']$/.exec(scope)?.[1];
  return lit === undefined || lit === "exec" || lit === "fetch";
}

describe("the link seam", () => {
  it("only the link, the lease kind's stop and the SDK barrel take the template runner", () => {
    expect(runnerTakers(all())).toEqual([]);
  });

  it("nothing in src imports the SDK barrel (a way around the import guard)", () => {
    const out: string[] = [];
    for (const [file, text] of all()) {
      if (file === "src/index.ts") continue;
      const b = bindingsFrom(file, text, "src/index.ts");
      if (b === "namespace" || b.length > 0) out.push(file);
    }
    expect(out).toEqual([]);
  });

  it("inside hosts.ts the runner is called only by runHostTemplate (checkHost runs through the link)", () => {
    const lines = readFileSync(join(SRC, "hosts.ts"), "utf8").split("\n");
    const callers: string[] = [];
    let fn = "";
    for (const line of lines) {
      const d = /^export (?:async )?function (\w+)/.exec(line);
      if (d?.[1] !== undefined) fn = d[1];
      if (/\brunLeasedTemplate\(/.test(line) && !/function runLeasedTemplate/.test(line)) {
        callers.push(fn);
      }
    }
    expect(callers).toEqual(["runHostTemplate"]);
  });

  it("an exec or fetch template is expanded only in hosts.ts and the link", () => {
    const out: string[] = [];
    for (const [file, text] of all()) {
      if (file === "src/hosts.ts" || file === "src/host-link.ts") continue;
      for (const c of calls(text, "expandHostTemplate")) {
        if (expandsExecOrFetch(c)) out.push(`${file}: ${c.slice(0, 60)}`);
      }
    }
    expect(out).toEqual([]);
  });

  it("a template's /bin/sh runs only in the runner", () => {
    const out: string[] = [];
    for (const [file, text] of all()) {
      if (file === "src/hosts.ts" || file === "src/exec-file.ts") continue;
      for (const c of calls(text, "execGroupCapture")) {
        if (!/^execGroupCapture\(\s*"git"/.test(c)) out.push(`${file}: ${c.slice(0, 60)}`);
      }
    }
    expect(out).toEqual([]);
  });

  it("each form is caught, one planted file per form", () => {
    const planted: ReadonlyArray<readonly [string, string]> = [
      ["src/agents/a.ts", 'import { runHostTemplate } from "../hosts.js";'],
      [
        "src/b.ts",
        'import {\n  getHost,\n  type HostRun,\n  runLeasedTemplate as run,\n} from "./hosts.js";',
      ],
      ["src/c.ts", 'export { runHostTemplate } from "./hosts.js";'],
      ["src/d.ts", 'import * as hosts from "./hosts.js";'],
      ["src/e.ts", 'const h = await import("./hosts.js");'],
      ["src/index.ts", 'import { runHostTemplate } from "./hosts.js";'],
    ];
    // The link or the stop handing the runner on: by `from`, or by a local re-export.
    expect(
      runnerTakers([
        ["src/host-link.ts", 'export { runLeasedTemplate } from "./hosts.js";'],
        [
          "src/carrier-stop.ts",
          'import { runLeasedTemplate } from "./hosts.js";\nexport { runLeasedTemplate as run };',
        ],
      ]),
    ).toEqual([
      "src/host-link.ts: re-export runLeasedTemplate",
      "src/carrier-stop.ts: re-export runLeasedTemplate",
    ]);
    expect(runnerTakers(planted)).toEqual([
      "src/agents/a.ts: runHostTemplate",
      "src/b.ts: runLeasedTemplate",
      "src/c.ts: re-export runHostTemplate",
      "src/d.ts: * from hosts",
      "src/e.ts: * from hosts",
      "src/index.ts: runHostTemplate",
    ]);
    // Not takers: other names, another module of the same basename, the allowed files.
    expect(
      runnerTakers([
        ["src/f.ts", 'import { getHost, HOST_COMMAND_TIMEOUT_MS } from "./hosts.js";'],
        ["src/jobs/g.ts", 'import { runHostTemplate } from "./hosts.js";'],
        ["src/carrier-stop.ts", 'import { runLeasedTemplate } from "./hosts.js";'],
        ["src/index.ts", 'export { runHostTemplate } from "./hosts.js";'],
      ]),
    ).toEqual([]);
    expect(
      calls(
        "const x = expandHostTemplate(\n  profile.exec,\n  { cmd: f(a) },\n);",
        "expandHostTemplate",
      ).map(expandsExecOrFetch),
    ).toEqual([true]);
    expect(expandsExecOrFetch('expandHostTemplate(profile.shell, { cwd: "." })')).toBe(false);
    expect(
      expandsExecOrFetch('expandHostTemplate(profile.attach, { job: a.job, cwd: "." }, "attach")'),
    ).toBe(false);
    expect(expandsExecOrFetch('expandHostTemplate(t, v, "fetch")')).toBe(true);
    // The exec bytes through an identifier, with no scope or a computed one.
    expect(expandsExecOrFetch("expandHostTemplate(tpl, { cmd })")).toBe(true);
    expect(expandsExecOrFetch("expandHostTemplate(profile.shell, v, scope)")).toBe(true);
    expect(expandsExecOrFetch('expandHostTemplate(profile.shell, v, "exec")')).toBe(true);
  });
});
