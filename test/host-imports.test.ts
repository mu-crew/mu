// The host provider seam holds (spec 2026-11-09-mu-plugins.md, D6, unit P3):
// outside the profile verbs, every host lookup goes through `resolveHost`
// (src/host-provider.ts). The guard reads import and re-export statements
// (multi-line, `type`, `as` aliases, `* as`, dynamic `import()`), so a renamed
// `getHost` fails here as surely as a direct call, and it scans SQL for a
// `host_profiles` read.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { all, bindingsFrom, callersOf, calls, localReExports, SRC } from "./_imports.js";

/** The profile store's lookups: taking one is looking a host up by hand. */
const LOOKUPS = new Set(["getHost", "listHosts"]);

/**
 * Who may take a lookup from src/hosts.ts: `resolveHost` itself, the profile verbs
 * (`mu host list`, `show`), and the SDK barrel (a re-export only; test/link-imports.test.ts
 * checks nothing in src imports the barrel).
 */
const LOOKUP_OK = new Set(["src/host-provider.ts", "src/cli/host.ts", "src/index.ts"]);

/** `file: name` for every lookup binding outside the allowed files, or the namespace import. */
function lookupTakers(files: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    if (file === "src/hosts.ts") continue;
    const b = bindingsFrom(file, text, "src/hosts.ts");
    if (b === "namespace") {
      out.push(`${file}: * from hosts`);
      continue;
    }
    const barrel = file === "src/index.ts";
    for (const { name, kind } of b) {
      if (!LOOKUPS.has(name)) continue;
      if (LOOKUP_OK.has(file) && barrel === (kind === "export")) continue;
      out.push(`${file}: ${kind === "export" ? "re-export " : ""}${name}`);
    }
    if (!barrel) {
      for (const name of localReExports(text)) {
        if (LOOKUPS.has(name)) out.push(`${file}: re-export ${name}`);
      }
    }
  }
  return out;
}

/** A SQL read of the profile table: `FROM` or `JOIN host_profiles`, any case, across lines. */
const PROFILE_READ = /\b(?:from|join)\s+host_profiles\b/gi;

/**
 * Where a `host_profiles` read may sit: the profile store, the seam's `hostIdentity` (a
 * recovery's pinned identity, one column), and the remote-recovery capture triggers (SQL:
 * they pin a removed agent's exec bytes; P6a's `_v3` triggers replace them).
 */
/** `PROFILE_READ` on one line, for `callersOf`. */
const PROFILE_READ_LINE = /\b(?:from|join)\s+host_profiles\b/i;

const READ_OK = new Set(["src/hosts.ts", "src/host-provider.ts", "src/db-recovery.ts"]);

function profileReaders(files: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    if (READ_OK.has(file)) continue;
    for (const m of text.matchAll(PROFILE_READ)) out.push(`${file}: ${m[0]}`);
  }
  return out;
}

const text = (file: string): string => readFileSync(join(SRC, file), "utf8");

describe("the host provider seam", () => {
  it("only resolveHost, the profile verbs and the SDK barrel take getHost or listHosts", () => {
    expect(lookupTakers(all())).toEqual([]);
  });

  it("inside hosts.ts getHost is called only by addHost, admission and checkHost", () => {
    expect(callersOf(text("hosts.ts"), /\bgetHost\(/, /function getHost\(/)).toEqual([
      "addHost",
      "admit",
      "admit",
      "checkHost",
    ]);
  });

  it("host-provider.ts looks a host up only in resolveHost and hostIdentity", () => {
    const t = text("host-provider.ts");
    expect(callersOf(t, /\bgetHost\(/, /^$/)).toEqual(["resolveHost"]);
    expect(callersOf(t, PROFILE_READ_LINE, /^$/)).toEqual(["hostIdentity"]);
  });

  it("host_profiles is read only by the profile store and the recovery triggers", () => {
    expect(profileReaders(all())).toEqual([]);
    // The triggers' reads are their exec subquery, nothing else.
    const triggers = [...text("db-recovery.ts").matchAll(PROFILE_READ)].length;
    const subqueries = text("db-recovery.ts").match(
      /\(SELECT exec FROM host_profiles WHERE name = (?:OLD|a)\.host\)/g,
    );
    expect(subqueries?.length).toBe(triggers);
    expect(triggers).toBe(2);
  });

  it("a view from a profile already read is built only from an admitted snapshot", () => {
    const out: string[] = [];
    for (const [file, t] of all()) {
      if (file === "src/host-provider.ts") continue;
      for (const c of calls(t, "admittedView")) out.push(`${file}: ${c}`);
      if (/\bhostView\b/.test(t)) out.push(`${file}: hostView`);
    }
    // check's, prepare's admitted profile, and close's `withHostChannel` callback.
    expect(out).toEqual([
      "src/hosts.ts: admittedView(db, profile)",
      "src/remote-worktree.ts: admittedView(db, profile)",
      "src/remote-worktree.ts: admittedView(db, profile)",
    ]);
    expect(callersOf(text("hosts.ts"), /\badmittedView\(/, /^$/)).toEqual(["checkHost"]);
    expect(callersOf(text("remote-worktree.ts"), /\badmittedView\(/, /^$/)).toEqual([
      "prepareRemote",
      "closeRemoteWorktree",
    ]);
    // resolveHost views the profile it just read.
    expect(
      callersOf(text("host-provider.ts"), /\badmittedView\(/, /function admittedView\(/),
    ).toEqual(["resolveHost"]);
  });

  it("each form is caught, one planted file per form", () => {
    expect(
      lookupTakers([
        ["src/agents/a.ts", 'import { getHost } from "../hosts.js";'],
        ["src/b.ts", 'import {\n  type HostProfile,\n  listHosts as all,\n} from "./hosts.js";'],
        ["src/c.ts", 'export { getHost } from "./hosts.js";'],
        ["src/d.ts", 'import * as hosts from "./hosts.js";'],
        ["src/e.ts", 'const h = await import("./hosts.js");'],
        ["src/index.ts", 'import { getHost } from "./hosts.js";'],
        // resolveHost's module handing the lookup on: by `from`, or by a local re-export.
        ["src/host-provider.ts", 'export { getHost } from "./hosts.js";'],
        [
          "src/cli/host.ts",
          'import { listHosts } from "../hosts.js";\nexport { listHosts as list };',
        ],
      ]),
    ).toEqual([
      "src/agents/a.ts: getHost",
      "src/b.ts: listHosts",
      "src/c.ts: re-export getHost",
      "src/d.ts: * from hosts",
      "src/e.ts: * from hosts",
      "src/index.ts: getHost",
      "src/host-provider.ts: re-export getHost",
      "src/cli/host.ts: re-export listHosts",
    ]);
    // Not takers: other names, another module of the same basename, the allowed files.
    expect(
      lookupTakers([
        ["src/f.ts", 'import { HostNotFoundError, type HostProfile } from "./hosts.js";'],
        ["src/jobs/g.ts", 'import { getHost } from "./hosts.js";'],
        ["src/host-provider.ts", 'import { getHost } from "./hosts.js";'],
        ["src/cli/host.ts", 'import { getHost, listHosts } from "../hosts.js";'],
        ["src/index.ts", 'export { getHost, listHosts } from "./hosts.js";'],
      ]),
    ).toEqual([]);
    expect(
      profileReaders([
        ["src/a.ts", 'db.prepare("SELECT * FROM host_profiles WHERE name = ?")'],
        ["src/b.ts", "`SELECT a.name FROM agents a\n  JOIN\n  host_profiles p ON p.name = a.host`"],
        ["src/c.ts", "db.prepare('select exec from Host_Profiles')"],
        ["src/hosts.ts", 'db.prepare("SELECT * FROM host_profiles")'],
        ["src/d.ts", 'db.prepare("UPDATE host_profiles SET capabilities = ?")'],
      ]),
    ).toEqual([
      "src/a.ts: FROM host_profiles",
      "src/b.ts: JOIN\n  host_profiles",
      "src/c.ts: from Host_Profiles",
    ]);
  });
});
