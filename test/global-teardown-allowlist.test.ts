// Unit tests for the allowlist policy in test/_global-teardown.ts
// (round-4: DB-rooted allowlist). The policy itself is a pure helper —
// `sessionsToKill(allMuSessions, allowlist)` — so we exercise it
// directly without touching real tmux, real DBs, or vitest hooks.
//
// What we verify:
//
//   1. User-DB workstreams are protected by `mu-<name>` mapping —
//      `tui-impl` workstream protects the `mu-tui-impl` session.
//
//   2. Anything else starting with `mu-` is killed (the leak from
//      bug_test_flake_round_3: bare-name test sessions that bypassed
//      the private socket). Round-4: this now includes ad-hoc sessions
//      with no DB row — by design, see
//      bug_test_flake_round_4_self_heal. The pre-existing-snapshot
//      escape hatch was a self-locking trap (test residue at
//      module-load got grandfathered in as protected forever).
//
//   3. Non-`mu-` sessions are never considered (the helper takes
//      pre-filtered `mu-*` sessions; this just documents the contract).
//
//   4. The allowlist reads the user's DB from every path src/db.ts
//      could resolve (MU_STATE_DIR included), and fails OPEN (null:
//      no sweep) when no DB exists or one cannot be read.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAllowlist,
  readUserWorkstreams,
  sessionsToKill,
  userDbPaths,
} from "./_global-teardown.js";

describe("global-teardown allowlist sweep policy", () => {
  it("kills nothing when every session is in the allowlist", () => {
    const allowlist = new Set(["mu-tui-impl", "mu-feedback", "mu-someother"]);
    const sessions = ["mu-tui-impl", "mu-feedback", "mu-someother"];
    expect(sessionsToKill(sessions, allowlist)).toEqual([]);
  });

  it("protects ad-hoc sessions only when they have a DB row in the allowlist", () => {
    // The user ran `mu workstream init alpha` (DB row exists) and
    // then `tmux new-session -t mu-alpha`. The DB row puts `mu-alpha`
    // in the allowlist; the sweep must not touch it.
    //
    // Contrast with round-3, which ALSO protected an ad-hoc
    // `mu-alpha` session purely because it was visible at
    // module-load time (the "preexisting snapshot" escape hatch).
    // That hatch was removed in round-4 because leftover test
    // residue at module-load got grandfathered in as protected
    // forever. See bug_test_flake_round_4_self_heal.
    const allowlist = new Set(["mu-alpha", "mu-tui-impl"]);
    const sessions = ["mu-alpha", "mu-tui-impl"];
    expect(sessionsToKill(sessions, allowlist)).toEqual([]);
  });

  it("kills ad-hoc sessions with no DB row (round-4 self-heal contract)", () => {
    // Inverse of the previous case: the user did `tmux new-session
    // -t mu-experiment` WITHOUT a `mu workstream init experiment`
    // first. Round-3 would have grandfathered it in (visible at
    // module-load → added to PROTECTED_PREEXISTING_SESSIONS).
    // Round-4 kills it: the DB is the only source of truth for
    // "this is a real workstream the user cares about". Cost is
    // documented in the helper's docstring; workaround is `mu
    // workstream init experiment`.
    const allowlist = new Set(["mu-tui-impl"]); // DB has tui-impl only
    const sessions = ["mu-experiment", "mu-tui-impl"];
    expect(sessionsToKill(sessions, allowlist)).toEqual(["mu-experiment"]);
  });

  it("kills bare-name test residue not in the allowlist", () => {
    // The exact failure mode of bug_test_flake_round_3: `mu-alpha`,
    // `mu-demo`, `mu-ws`, etc. created by tests that hardcode short
    // workstream names. None are in the allowlist; all should die.
    const allowlist = new Set(["mu-tui-impl"]);
    const sessions = [
      "mu-alpha",
      "mu-beta",
      "mu-demo",
      "mu-gamma",
      "mu-scratch",
      "mu-ws",
      "mu-ws2",
      "mu-tui-impl",
    ];
    expect(sessionsToKill(sessions, allowlist)).toEqual([
      "mu-alpha",
      "mu-beta",
      "mu-demo",
      "mu-gamma",
      "mu-scratch",
      "mu-ws",
      "mu-ws2",
    ]);
  });

  it("kills regex-prefixed test sessions when not allowlisted", () => {
    // The regression target the original sweep was designed for:
    // `mu-acc-...` from a crashed test/acceptance.integration.test.ts run.
    const allowlist = new Set(["mu-tui-impl"]);
    const sessions = ["mu-acc-h7g8x4", "mu-claim-jh3z9p", "mu-tui-impl"];
    expect(sessionsToKill(sessions, allowlist)).toEqual(["mu-acc-h7g8x4", "mu-claim-jh3z9p"]);
  });

  it("treats the empty allowlist as kill-all-mu-sessions (defensive — should never fire in production)", () => {
    // A readable user DB with no workstreams and no `$MU_SESSION`:
    // the suite is the only thing producing mu-* sessions and they're
    // all leaked-by-definition. (A missing or unreadable DB yields no
    // allowlist at all; see the next describe block.)
    const allowlist = new Set<string>();
    const sessions = ["mu-foo", "mu-bar"];
    expect(sessionsToKill(sessions, allowlist)).toEqual(["mu-foo", "mu-bar"]);
  });

  it("returns the input order (deterministic for the warning message)", () => {
    // The teardown warning lists killed sessions in some order; the
    // tests around it (and humans reading CI logs) appreciate a
    // stable left-to-right list rather than a Set-iteration order.
    const allowlist = new Set(["mu-keep"]);
    const sessions = ["mu-zzz", "mu-keep", "mu-aaa", "mu-mmm"];
    expect(sessionsToKill(sessions, allowlist)).toEqual(["mu-zzz", "mu-aaa", "mu-mmm"]);
  });
});

describe("global-teardown allowlist source (user DB)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-teardown-allowlist-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  const makeDb = (path: string, names: string[]): void => {
    const db = new Database(path);
    db.exec("CREATE TABLE workstreams (name TEXT)");
    for (const n of names) db.prepare("INSERT INTO workstreams (name) VALUES (?)").run(n);
    db.close();
  };

  it("resolves MU_DB_PATH, MU_STATE_DIR and the XDG path, like src/db.ts", () => {
    expect(
      userDbPaths({ HOME: "/h", MU_DB_PATH: "/d/x.db", MU_STATE_DIR: "/s", XDG_STATE_HOME: "/x" }),
    ).toEqual(["/d/x.db", "/s/mu.db", "/x/mu/mu.db"]);
    expect(userDbPaths({ HOME: "/h" })).toEqual(["/h/.local/state/mu/mu.db"]);
  });

  it("protects workstreams from a DB under MU_STATE_DIR", () => {
    const stateDir = join(dir, "state");
    const paths = userDbPaths({ HOME: join(dir, "home"), MU_STATE_DIR: stateDir });
    mkdirSync(stateDir);
    makeDb(join(stateDir, "mu.db"), ["realws"]);
    expect(buildAllowlist(paths, undefined)).toEqual(new Set(["mu-realws"]));
  });

  it("unions every readable DB and $MU_SESSION", () => {
    const a = join(dir, "a.db");
    const b = join(dir, "b.db");
    makeDb(a, ["one"]);
    makeDb(b, ["two"]);
    expect(buildAllowlist([a, b, join(dir, "missing.db")], "orch")).toEqual(
      new Set(["mu-one", "mu-two", "mu-orch"]),
    );
  });

  it("fails open (no sweep) when no user DB exists, even with $MU_SESSION set", () => {
    expect(readUserWorkstreams([join(dir, "missing.db")])).toBeNull();
    expect(buildAllowlist([join(dir, "missing.db")], "orch")).toBeNull();
  });

  it("fails open (no sweep) when a user DB exists but cannot be read", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = join(dir, "good.db");
    const corrupt = join(dir, "corrupt.db");
    makeDb(good, ["realws"]);
    writeFileSync(corrupt, "not a sqlite db");
    expect(buildAllowlist([good, corrupt], "orch")).toBeNull();
  });
});
