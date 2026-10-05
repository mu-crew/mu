// Unit coverage for src/cli.ts:classifyError().
//
// classifyError maps a typed error class to the (label, exit-code)
// pair the CLI's emitError() uses. The mapping is the canonical source
// of truth for the exit codes in docs/guide/sql.md § Script with --json:
//   0 = success          1 = generic            2 = usage
//   3 = not found        4 = conflict           5 = substrate
//   6 = reaper           7 = stall
//
// The cases below intentionally follow the same order as
// src/cli/handle.ts:classifyError(). When a new class is added to that
// switch, the missing adjacent row should be obvious in review.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  PaneNotInSessionError,
  WorkspacePreservedError,
} from "../src/agents.js";
import { classifyError, NameAmbiguousError, UsageError } from "../src/cli.js";
import { SchemaTooOldError, WorkstreamNotFoundError } from "../src/db.js";
import { HazardFailError } from "../src/fleet-hazards.js";
import { MuxError, NoMultiplexerError } from "../src/mux.js";
import {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  InvalidSubstateError,
  ReaperDetectedDuringWaitError,
  StallDetectedDuringWaitError,
  SubstateReasonRequiredError,
  TaskAlreadyOwnedError,
  TaskClaimStaleWorkspaceError,
  TaskExistsError,
  TaskIdInvalidError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
  TaskParkedError,
  TaskParkStateError,
  TaskTitleSlugEmptyError,
} from "../src/tasks.js";
import { PaneNotFoundError, TmuxError } from "../src/tmux.js";
import {
  WorkspaceConflictError,
  WorkspaceDirtyError,
  WorkspaceVcsRequiredError,
} from "../src/vcs.js";
import {
  HomeDirAsProjectRootError,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
} from "../src/workspace.js";
import { WorkstreamExistsError, WorkstreamNameInvalidError } from "../src/workstream.js";

describe("classifyError exit-code map", () => {
  // (instance, expected exit code, expected label)
  const cases: Array<[Error, number, string]> = [
    // switch branch 1: usage / invalid operator input
    [new UsageError("bad flag"), 2, "error"],
    [new WorkstreamNameInvalidError("Bad-Name"), 2, "error"],
    [new TaskIdInvalidError("Bad ID"), 2, "error"],
    [new TaskTitleSlugEmptyError("!!!"), 2, "error"],

    // switch branch 2: resolve-time misses
    [new AgentNotFoundError("alice"), 3, "not found"],
    [new TaskNotFoundError("foo"), 3, "not found"],
    // schema_v5_cli_boundary — the resolve-time miss for the SDK
    // boundary's first leg (operator-name → workstreams.id).
    [new WorkstreamNotFoundError("ghost"), 3, "not found"],
    [new WorkspaceNotFoundError("alice"), 3, "not found"],

    // switch branch 3: conflicts / state mismatches
    [new NameAmbiguousError("dupe", ["ws-a", "ws-b"], "task"), 4, "conflict"],
    [new AgentExistsError("alice"), 4, "conflict"],
    [new TaskExistsError("foo"), 4, "conflict"],
    [new TaskAlreadyOwnedError("foo", "alice"), 4, "conflict"],
    [
      new TaskClaimStaleWorkspaceError({
        agentName: "alice",
        workstreamName: "stale-ws",
        commitsBehindMain: 12,
        isStale: true,
      }),
      4,
      "conflict",
    ],
    [new TaskNotInWorkstreamError("foo", "wsA", "wsB"), 4, "conflict"],
    [new AgentNotInWorkstreamError("alice", "wsA", "wsB"), 4, "conflict"],
    [new PaneNotInSessionError("%15", "auth", "mu-auth"), 4, "conflict"],
    [new CycleError("a", "b"), 4, "conflict"],
    [new CrossWorkstreamEdgeError("blocker", "wsA", "dep", "wsB"), 4, "conflict"],
    [new WorkspaceExistsError("alice"), 4, "conflict"],
    [new WorkspacePathNotEmptyError("alice", "ws", "/tmp/ws/alice"), 4, "conflict"],
    [new WorkspacePreservedError("alice", "/tmp/ws/alice"), 4, "conflict"],
    [new HomeDirAsProjectRootError("alice", "ws", "/Users/alice"), 4, "conflict"],
    [new WorkspaceVcsRequiredError("refresh", "/tmp/ws/alice"), 4, "conflict"],
    [new WorkspaceDirtyError("/tmp/ws/alice", ["src/file.ts"]), 4, "conflict"],
    [new ClaimerNotRegisteredError("pi-mu", "%6441"), 4, "conflict"],
    [new SchemaTooOldError(4, 5), 4, "conflict"],
    [new WorkstreamExistsError("existing-ws"), 4, "conflict"],
    [new SubstateReasonRequiredError("close", "wontfix", "foo"), 4, "conflict"],
    [new TaskParkStateError("foo", "IN_PROGRESS", "ws"), 4, "conflict"],
    [new TaskParkedError("foo", "ws"), 4, "conflict"],
    [new InvalidSubstateError("CLOSED", "parked"), 4, "conflict"],

    // switch branches 12-14: spawn failures
    [
      new AgentSpawnCliNotFoundError("pi-meta", "pi-meta", "MU_PI_META_COMMAND"),
      1,
      "spawn cli not found",
    ],
    [new AgentDiedOnSpawnError("alice", "%15", "panic: died"), 1, "spawn failed"],
    [
      new AgentSpawnStartupError(
        "alice",
        "%15",
        "Error: No API key found for amazon-bedrock",
        "Error: No API key found for amazon-bedrock\n> ",
      ),
      1,
      "spawn startup error",
    ],

    // switch branch 7: mux substrate. TmuxError extends MuxError, so the
    // one branch covers every backend's error family.
    [new TmuxError(["list-panes"], "no server", "", 1), 5, "mux"],
    [new MuxError("no server"), 5, "mux"],
    [new PaneNotFoundError("%999"), 5, "mux"],
    [new NoMultiplexerError(["tmux"]), 5, "no multiplexer"],

    // f_arch_exit5_dblocked: a lock held past busy_timeout is exit 5,
    // as docs/architecture/sdk.md says, not generic 1.
    [new Database.SqliteError("database is locked", "SQLITE_BUSY"), 5, "db locked"],
    [new Database.SqliteError("database table is locked", "SQLITE_LOCKED"), 5, "db locked"],
    [new Database.SqliteError("UNIQUE constraint failed", "SQLITE_CONSTRAINT_UNIQUE"), 1, "error"],
    // f_doctor_fail_row_exit0: a doctor FAIL row shares drift's lane.
    [new HazardFailError(["db-vs-sync"]), 5, "doctor"],

    // switch branch 8: VCS conflict during workspace refresh
    [
      new WorkspaceConflictError("/tmp/ws/alice", "origin/main", ["src/file.ts"]),
      5,
      "workspace conflict",
    ],

    // switch branches 9-10: wait-specific process states
    [new ReaperDetectedDuringWaitError("wait_task", "worker-1", "ws"), 6, "reaper"],
    [new StallDetectedDuringWaitError("wait_task", "worker-1", "ws", 300), 7, "stall"],

    // final fallthrough: generic catch-all (non-typed errors)
    [new Error("some other thing"), 1, "error"],
  ];

  for (const [err, exit, label] of cases) {
    it(`${err.name || "Error"} → exit ${exit} (${label})`, () => {
      const result = classifyError(err);
      expect(result.exitCode).toBe(exit);
      expect(result.label).toBe(label);
    });
  }
});
