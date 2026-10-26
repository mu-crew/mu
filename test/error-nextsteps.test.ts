// Verifies every exported typed error class with errorNextSteps()
// carries actionable, contextual recovery hints.
//
// One test per error class. Tests don't assert the exact text of the
// hints (those evolve); they assert that the error implements
// HasNextSteps, returns a non-empty array of well-formed NextStep
// records, and that at least one command contains the constructor
// context that makes the hint copy-pasteable rather than generic.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentAbortNeedsCtlError,
  AgentAbortTimeoutError,
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentDiedOnSpawnError,
  AgentEmptySendError,
  AgentExistsError,
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
  AgentLockBusyError,
  AgentNameExhaustedError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  AgentPaneDeadError,
  AgentPaneStillAliveError,
  AgentReplacedError,
  AgentRestartedError,
  AgentSendIndeterminateError,
  AgentSendUnsupportedError,
  AgentSlashCommandUnsupportedError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  SpawnAttemptBusyError,
  SpawnAttemptFailedError,
  SpawnAttemptGuardError,
  SpawnReceiptConflictError,
  SpawnTaskStateError,
  SpawnTrustDialogError,
} from "../src/agents.js";
import { NameAmbiguousError } from "../src/cli.js";
import {
  openDb,
  SchemaTooNewError,
  SchemaTooOldError,
  SqliteTooOldError,
  WorkstreamNotFoundError,
  WorkstreamTornDownError,
} from "../src/db.js";
import {
  HerdrCommandOverrideError,
  HerdrError,
  HerdrUnsupportedCliError,
  HerdrWorkspaceGroupCloseError,
} from "../src/mux/herdr.js";
import { MuxError, NoMultiplexerError, tmuxBackend } from "../src/mux.js";
import { hasNextSteps } from "../src/output.js";
import { TaskBriefMissingError } from "../src/task-brief.js";
import {
  ClaimerNotRegisteredError,
  CloseNeedsEvidenceError,
  CrossWorkstreamEdgeError,
  CycleError,
  HumanTaskError,
  InvalidSubstateError,
  SubstateReasonRequiredError,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskHasOpenBlockersError,
  TaskIdInvalidError,
  TaskInTriageError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
  TaskParkedError,
  TaskParkStateError,
  TaskTitleSlugEmptyError,
} from "../src/tasks.js";
import { PaneNotFoundError, TmuxError } from "../src/tmux.js";
import {
  WorkstreamExistsError,
  WorkstreamHasAgentsError,
  WorkstreamNameInvalidError,
  WorkstreamNameReservedError,
  WorkstreamPanesLiveError,
  WorkstreamRevisionMismatchError,
  WorkstreamSessionLiveError,
} from "../src/workstream.js";
import {
  WorktreeDirtyError,
  WorktreePathNotEmptyError,
  WorktreeVcsRequiredError,
} from "../src/worktree.js";

interface NextStepLike {
  intent: string;
  command: string;
}

interface NextStepsCase {
  error: Error;
  label: string;
  expectedTokens: string[];
}

const cases: NextStepsCase[] = [
  // src/tasks/errors.ts
  { error: new TaskNotFoundError("foo"), label: "TaskNotFoundError", expectedTokens: ["foo"] },
  {
    error: new TaskTitleSlugEmptyError("日本語"),
    label: "TaskTitleSlugEmptyError",
    expectedTokens: ["mu task add <id>"],
  },
  {
    error: new TaskIdInvalidError("Bad ID"),
    label: "TaskIdInvalidError",
    expectedTokens: ["bad_id"],
  },
  { error: new TaskExistsError("foo"), label: "TaskExistsError", expectedTokens: ["foo"] },
  {
    error: new TaskNotInWorkstreamError("foo", "expected", "actual"),
    label: "TaskNotInWorkstreamError",
    expectedTokens: ["foo", "actual"],
  },
  {
    error: new TaskAlreadyOwnedError("foo", "alice"),
    label: "TaskAlreadyOwnedError",
    expectedTokens: ["foo", "alice"],
  },
  {
    error: new CloseNeedsEvidenceError("foo", "ws"),
    label: "CloseNeedsEvidenceError",
    expectedTokens: ["mu task close foo -w ws", "--evidence"],
  },
  {
    error: new TaskHasOpenBlockersError("foo", "ws", ["a", "b"]),
    label: "TaskHasOpenBlockersError",
    expectedTokens: ["mu task tree foo -w ws"],
  },
  {
    error: new SubstateReasonRequiredError("park", "parked", "foo"),
    label: "SubstateReasonRequiredError",
    expectedTokens: ["mu task park foo", "--why"],
  },
  {
    error: new TaskParkStateError("foo", "IN_PROGRESS", "ws"),
    label: "TaskParkStateError (IN_PROGRESS)",
    expectedTokens: ["mu task release foo -w ws"],
  },
  {
    error: new TaskParkStateError("foo", "CLOSED", "ws"),
    label: "TaskParkStateError (CLOSED)",
    expectedTokens: ["mu task open foo -w ws"],
  },
  {
    error: new HumanTaskError("foo", "ws", "claim"),
    label: "HumanTaskError",
    expectedTokens: ["mu task close foo -w ws"],
  },
  {
    error: new TaskParkedError("foo", "ws"),
    label: "TaskParkedError",
    expectedTokens: ["mu task unpark foo -w ws", "--force"],
  },
  {
    error: new TaskInTriageError("foo", "ws"),
    label: "TaskInTriageError",
    expectedTokens: ["mu task accept foo -w ws", "--as rejected", "--force"],
  },
  {
    error: new InvalidSubstateError("CLOSED", "parked"),
    label: "InvalidSubstateError",
    expectedTokens: ["--as wontfix"],
  },
  {
    error: new ClaimerNotRegisteredError("pi-mu", "%6441"),
    label: "ClaimerNotRegisteredError (with pane)",
    expectedTokens: ["--self", "--for"],
  },
  {
    // No-pane variant has no entity to interpolate, but it still must
    // produce the anonymous / --for recovery options.
    error: new ClaimerNotRegisteredError("pi-mu", null),
    label: "ClaimerNotRegisteredError (no pane)",
    expectedTokens: ["--self", "--for"],
  },
  { error: new CycleError("a", "b"), label: "CycleError", expectedTokens: ["a", "b"] },
  {
    // CrossWorkstreamEdgeError's recovery is to move or duplicate the
    // BLOCKER, so the dependent id legitimately doesn't appear in all
    // commands. Pin the blocker + destination workstream context.
    error: new CrossWorkstreamEdgeError("blocker", "wsA", "dep", "wsB"),
    label: "CrossWorkstreamEdgeError",
    expectedTokens: ["blocker", "wsB"],
  },

  // src/agents/errors.ts
  {
    error: new AgentSpawnCliNotFoundError("pi-meta", "pi-meta", "MU_PI_META_COMMAND"),
    label: "AgentSpawnCliNotFoundError",
    expectedTokens: ["MU_PI_META_COMMAND", "pi-meta"],
  },
  { error: new AgentExistsError("alice"), label: "AgentExistsError", expectedTokens: ["alice"] },
  {
    error: new AgentNameExhaustedError("alice", "taken"),
    label: "AgentNameExhaustedError",
    expectedTokens: ["--next-free"],
  },
  {
    error: new AgentNotFoundError("alice"),
    label: "AgentNotFoundError",
    expectedTokens: ["alice"],
  },
  {
    error: new AgentNotInWorkstreamError("alice", "expected", "actual"),
    label: "AgentNotInWorkstreamError",
    expectedTokens: ["alice", "actual"],
  },
  {
    error: new AgentSendUnsupportedError("alice", "auth", "claude"),
    label: "AgentSendUnsupportedError",
    expectedTokens: ["mu agent close alice", "-w auth"],
  },
  {
    error: new AgentDiedOnSpawnError("scout-perf-1", "%42", "panic: died"),
    label: "AgentDiedOnSpawnError",
    expectedTokens: ["scout-perf-1"],
  },
  {
    error: new AgentSpawnStartupError(
      "alice",
      "%15",
      "Error: No API key found for amazon-bedrock",
      "Error: No API key found for amazon-bedrock\n> ",
    ),
    label: "AgentSpawnStartupError",
    expectedTokens: ["alice"],
  },
  {
    error: new AgentCtlUnreachableError("alice", "auth", "/s/sock/auth/alice.sock", "missing"),
    label: "AgentCtlUnreachableError",
    expectedTokens: ["pi install npm:@mu-crew/mu"],
  },
  {
    error: new AgentCtlUnreachableError(
      "alice",
      "auth",
      "/s/sock/auth/alice.sock",
      "refused",
      "dev",
    ),
    label: "AgentCtlUnreachableError (remote)",
    expectedTokens: ["mu host check dev --agent alice -w auth"],
  },
  {
    error: new AgentSendIndeterminateError("alice", "auth", "send", "timeout"),
    label: "AgentSendIndeterminateError",
    expectedTokens: ["mu agent read alice -w auth -n 20"],
  },
  {
    error: new AgentPaneDeadError("alice", "auth", "%3"),
    label: "AgentPaneDeadError",
    expectedTokens: ["mu agent spawn alice -w auth"],
  },
  {
    error: new AgentAbortNeedsCtlError("alice", "auth", "claude"),
    label: "AgentAbortNeedsCtlError",
    expectedTokens: ["mu agent close alice"],
  },
  {
    error: new AgentAbortTimeoutError("alice", "auth", 30000),
    label: "AgentAbortTimeoutError",
    expectedTokens: ["mu agent close alice"],
  },
  {
    error: new AgentFreshNeedsCtlError("alice", "auth", "claude"),
    label: "AgentFreshNeedsCtlError",
    expectedTokens: ["mu agent send alice '/new'"],
  },
  {
    error: new AgentBusyError("alice", "auth"),
    label: "AgentBusyError",
    expectedTokens: ["mu agent abort alice", "--fresh --force"],
  },
  {
    error: new AgentSlashCommandUnsupportedError("alice", "auth", "/tree", ["/new"]),
    label: "AgentSlashCommandUnsupportedError",
    expectedTokens: ["mu agent read alice"],
  },
  {
    error: new AgentEmptySendError("alice", "auth"),
    label: "AgentEmptySendError",
    expectedTokens: ["mu agent read alice"],
  },
  {
    error: new AgentExtensionOutdatedError("alice", "auth", "fresh", "3.0.0", undefined, {
      respawn: "mu agent spawn alice -w auth --cli pi",
    }),
    label: "AgentExtensionOutdatedError",
    expectedTokens: ["mu agent close alice", "mu agent spawn alice"],
  },
  {
    error: new AgentRestartedError("alice", "auth", "inc-1", "inc-2"),
    label: "AgentRestartedError",
    expectedTokens: ["send alice --fresh"],
  },

  // src/mux/types.ts
  {
    error: new MuxError("mux is unhappy"),
    label: "MuxError",
    expectedTokens: ["doctor"],
  },
  {
    error: new NoMultiplexerError(["tmux"]),
    label: "NoMultiplexerError",
    expectedTokens: ["tmux"],
  },

  // src/mux/tmux.ts
  {
    error: new TmuxError(["list-panes"], "no server", "", 1),
    label: "TmuxError",
    expectedTokens: ["doctor", "list-panes"],
  },
  {
    // Backend-aware: the pane-probe steps come FROM the backend, so the
    // no-backend form below legitimately carries only mu's own verbs.
    error: new PaneNotFoundError("%999", tmuxBackend),
    label: "PaneNotFoundError",
    expectedTokens: ["%999"],
  },

  // src/mux/herdr.ts
  {
    error: new HerdrError(["pane", "list"], "", "", 1),
    label: "HerdrError",
    expectedTokens: ["doctor", "pane list"],
  },
  {
    // Refusals, not outages: the steps must offer a supported kind AND
    // the tmux escape hatch, since tmux runs any command.
    error: new HerdrUnsupportedCliError("notacli", "unsupported interactive agent kind"),
    label: "HerdrUnsupportedCliError",
    expectedTokens: ["notacli", "MU_MUX=tmux"],
  },
  {
    error: new HerdrCommandOverrideError("pi", "pi-alt", "MU_PI_COMMAND"),
    label: "HerdrCommandOverrideError",
    // Names the variable to unset — the whole point of refusing loudly.
    expectedTokens: ["MU_PI_COMMAND", "MU_MUX=tmux"],
  },
  {
    // mu will not close worktree workspaces it did not create, so the
    // steps must hand the operator BOTH the inspect verb and the
    // explicit group close, addressed to the actual workspace id.
    error: new HerdrWorkspaceGroupCloseError("mu-alpha", "w1", "linked worktree workspaces"),
    label: "HerdrWorkspaceGroupCloseError",
    expectedTokens: ["workspace list", "w1 --group"],
  },

  // src/worktree.ts
  {
    error: new WorktreeDirtyError("alice", "auth", "/path/to/ws", ["a.txt"]),
    label: "WorktreeDirtyError",
    expectedTokens: ["status --short", "/path/to/ws", "mu agent close alice -w auth --discard"],
  },
  {
    error: new WorktreePathNotEmptyError("alice", "auth", "/path/to/ws", "uncommitted work"),
    label: "WorktreePathNotEmptyError",
    expectedTokens: ["mu agent close alice -w auth", "--discard", "--next-free"],
  },
  {
    error: new WorktreeVcsRequiredError("/path/to/dir"),
    label: "WorktreeVcsRequiredError",
    expectedTokens: ["--root", "git-repo"],
  },

  // src/workstream.ts / src/db.ts
  {
    error: new WorkstreamNameInvalidError("mu-foo"),
    label: "WorkstreamNameInvalidError",
    expectedTokens: ["foo"],
  },
  {
    error: new WorkstreamNotFoundError("ghost"),
    label: "WorkstreamNotFoundError",
    expectedTokens: ["ghost"],
  },
  {
    error: new WorkstreamTornDownError("old-ws", "2026-01-01T00:00:00.000Z"),
    label: "WorkstreamTornDownError",
    expectedTokens: ["init old-ws"],
  },
  {
    error: new WorkstreamRevisionMismatchError("ws", 1, 2),
    label: "WorkstreamRevisionMismatchError",
    expectedTokens: ["teardown ws"],
  },
  {
    error: new WorkstreamHasAgentsError("ws", ["w1", "w2"]),
    label: "WorkstreamHasAgentsError",
    expectedTokens: ["agent close w1 -w ws"],
  },
  {
    error: new AgentReplacedError("alice", "auth"),
    label: "AgentReplacedError",
    expectedTokens: ["mu agent close alice", "-w auth"],
  },
  {
    error: new AgentReplacedError("alice", "auth", "sent to"),
    label: "AgentReplacedError (send)",
    expectedTokens: ["mu agent list", "-w auth"],
  },
  {
    error: new SpawnTaskStateError("t1", "was closed"),
    label: "SpawnTaskStateError",
    expectedTokens: ["mu task show t1"],
  },
  {
    error: new SpawnAttemptFailedError("t1", "auto:1", "it failed"),
    label: "SpawnAttemptFailedError",
    expectedTokens: ["task show t1"],
  },
  {
    error: new SpawnAttemptGuardError("t1", "auto:1", "no longer authorised"),
    label: "SpawnAttemptGuardError",
    expectedTokens: ["task show t1"],
  },
  {
    error: new TaskBriefMissingError("t1", "ws", "it has no brief note"),
    label: "TaskBriefMissingError",
    expectedTokens: ["task note t1", "-w ws"],
  },
  {
    error: new SpawnAttemptBusyError("t1", "manual:t1"),
    label: "SpawnAttemptBusyError",
    expectedTokens: ["mu task show t1"],
  },
  {
    error: new SpawnReceiptConflictError("t1", "manual:t1", "worker-1"),
    label: "SpawnReceiptConflictError",
    expectedTokens: ["--task t1", "--attempt"],
  },
  {
    error: new SpawnTrustDialogError("worker-1"),
    label: "SpawnTrustDialogError",
    expectedTokens: ["claude"],
  },
  {
    error: new AgentLockBusyError("alice", "auth"),
    label: "AgentLockBusyError",
    expectedTokens: ["mu agent close alice", "-w auth"],
  },
  {
    error: new AgentPaneStillAliveError("alice", "auth", "%3", true),
    label: "AgentPaneStillAliveError",
    expectedTokens: ["agent close alice -w auth"],
  },
  {
    error: new WorkstreamPanesLiveError("ws", ["w1"]),
    label: "WorkstreamPanesLiveError",
    expectedTokens: ["agent close w1 -w ws"],
  },
  {
    error: new WorkstreamSessionLiveError("ws", "mu-ws"),
    label: "WorkstreamSessionLiveError",
    expectedTokens: ["teardown ws"],
  },
  {
    error: new WorkstreamExistsError("existing-ws"),
    label: "WorkstreamExistsError",
    expectedTokens: ["existing-ws"],
  },
  {
    error: new WorkstreamNameReservedError("scratch"),
    label: "WorkstreamNameReservedError",
    expectedTokens: ["scratch"],
  },
  {
    error: new SchemaTooOldError(10, 11),
    label: "SchemaTooOldError",
    expectedTokens: ["sqlite3", ".old"],
  },
  {
    error: new SchemaTooNewError(12, 11),
    label: "SchemaTooNewError",
    expectedTokens: ["mu --version"],
  },
  {
    error: new SqliteTooOldError("3.41.2"),
    label: "SqliteTooOldError",
    expectedTokens: ["sqlite_version"],
  },

  // src/cli/handle.ts
  {
    error: new NameAmbiguousError("dupe", ["ws-a", "ws-b"], "task"),
    label: "NameAmbiguousError",
    expectedTokens: ["ws-a/dupe", "ws-b/dupe"],
  },
];

function assertWellFormedSteps(err: Error): NextStepLike[] {
  expect(hasNextSteps(err)).toBe(true);
  const steps = (err as unknown as { errorNextSteps: () => unknown[] }).errorNextSteps();
  expect(Array.isArray(steps)).toBe(true);
  expect(steps.length).toBeGreaterThan(0);
  for (const s of steps as Array<{ intent?: unknown; command?: unknown }>) {
    expect(typeof s.intent).toBe("string");
    expect(typeof s.command).toBe("string");
    expect((s.intent as string).trim().length).toBeGreaterThan(0);
    expect((s.command as string).trim().length).toBeGreaterThan(0);
  }
  return steps as NextStepLike[];
}

function commandContainsEveryToken(steps: NextStepLike[], tokens: string[]): void {
  const commands = steps.map((s) => s.command);
  for (const token of tokens) {
    expect(
      commands.some((c) => c.includes(token)),
      `expected at least one step's command to mention '${token}'; got: ${JSON.stringify(commands)}`,
    ).toBe(true);
  }
}

describe("typed errors all carry actionable errorNextSteps()", () => {
  for (const { error, label, expectedTokens } of cases) {
    it(`${label}: implements HasNextSteps with non-empty, well-formed, contextual steps`, () => {
      const steps = assertWellFormedSteps(error);
      commandContainsEveryToken(steps, expectedTokens);
    });
  }

  it("inventory matches exported error classes", async () => {
    const modules = await Promise.all([
      import("../src/agents.js"),
      import("../src/tasks.js"),
      import("../src/task-brief.js"),
      import("../src/worktree.js"),
      import("../src/db.js"),
      import("../src/workstream.js"),
      import("../src/mux.js"),
      import("../src/tmux.js"),
      import("../src/cli.js"),
    ]);

    const exportedNames = new Set<string>();
    for (const moduleExports of modules) {
      for (const exported of Object.values(moduleExports)) {
        if (isErrorConstructorWithNextSteps(exported)) {
          exportedNames.add(exported.name);
        }
      }
    }

    const coveredNames = new Set(cases.map((c) => c.error.name));
    const missing = [...exportedNames].filter((name) => !coveredNames.has(name)).sort();
    expect(missing).toEqual([]);
    expect(coveredNames.size).toBe(exportedNames.size);
    expect(cases.length).toBeGreaterThanOrEqual(exportedNames.size);
  });
});

function isErrorConstructorWithNextSteps(
  value: unknown,
): value is { name: string; prototype: Error & { errorNextSteps: () => unknown } } {
  if (typeof value !== "function") return false;
  const prototype = (value as { prototype?: unknown }).prototype;
  if (!(prototype instanceof Error)) return false;
  return typeof (prototype as { errorNextSteps?: unknown }).errorNextSteps === "function";
}

describe("error-specific structured-step assertions", () => {
  it("ClaimerNotRegisteredError names the pane in the message and offers --self / --for", () => {
    const err = new ClaimerNotRegisteredError("pi-mu", "%42");
    expect(err.message).toContain("(pane %42)");
    expect(err.errorNextSteps().map((s) => s.command)).toEqual([
      "mu task claim <id> --self",
      "mu task claim <id> --for <worker>",
    ]);
  });

  it("TaskNotInWorkstreamError suggests the actual workstream", () => {
    const err = new TaskNotInWorkstreamError("foo", "wsA", "wsB");
    const steps = err.errorNextSteps();
    const useActual = steps.find((s) => s.command.includes("-w wsB"));
    expect(useActual).toBeDefined();
  });

  it("AgentSpawnStartupError on an exec-failure line drops the provider/API-key hints", () => {
    const line = "sh: pi-meta: No such file or directory";
    const exec = new AgentSpawnStartupError("alice", "%15", line, `${line}\n$ `);
    const commands = exec.errorNextSteps().map((s) => s.command);
    expect(commands.some((c) => c.includes("ANTHROPIC_API_KEY"))).toBe(false);
    expect(commands.some((c) => c.includes("pi-meta --no-solo"))).toBe(false);
    expect(commands).toContain("mu agent read alice -n 100");
    const auth = new AgentSpawnStartupError("alice", "%15", "No API key found for x", "");
    expect(auth.errorNextSteps().some((s) => s.command.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("AgentNotInWorkstreamError suggests the actual workstream", () => {
    const err = new AgentNotInWorkstreamError("alice", "wsA", "wsB");
    const steps = err.errorNextSteps();
    const useActual = steps.find((s) => s.command.includes("wsB"));
    expect(useActual).toBeDefined();
  });

  it("WorkstreamNameInvalidError suggests a sanitised name (lowercases the mu- prefix too)", () => {
    const err = new WorkstreamNameInvalidError("Mu-Auth.Refactor");
    const steps = err.errorNextSteps();
    const init = steps.find((s) => s.command.startsWith("mu workstream init"));
    expect(init?.command).toContain("auth_refactor");
    // The 'mu-' prefix must be stripped REGARDLESS of input case (the
    // ws name will be lowercased anyway). Surfaced via dogfood: the
    // first version of this fix only matched a lowercase prefix, so
    // 'Mu-Foo' came out as 'mu workstream init mu-foo' — still invalid.
    expect(init?.command).not.toContain("mu-");
  });

  it("WorkstreamNameInvalidError uses a direct intent for the mu- prefix branch (no 'best guess' hedge)", () => {
    // workstream_init_name_rejected_mu (feedback ws): the rationale
    // for rejecting `mu-foo` lives on stderr but the only loud action
    // line was "Try a sanitized name (best guess)". Dogfooding agents
    // skipped past the rationale and treated the hedge as a hint, not
    // a fix. For the prefix branch the correction is unambiguous, so
    // the intent must read as a direct retry.
    const prefix = new WorkstreamNameInvalidError("mu-feedback");
    const prefixSteps = prefix.errorNextSteps();
    const prefixInit = prefixSteps.find((s) => s.command.startsWith("mu workstream init"));
    expect(prefixInit?.intent).toBe("Retry without the 'mu-' prefix");
    expect(prefixInit?.command).toBe("mu workstream init feedback");

    // For the regex/mangle branch the sanitiser really is guessing
    // (`.`, `:`, case all collapse), so the hedge is honest and stays.
    const mangle = new WorkstreamNameInvalidError("roadmap-v0.2");
    const mangleSteps = mangle.errorNextSteps();
    const mangleInit = mangleSteps.find((s) => s.command.startsWith("mu workstream init"));
    expect(mangleInit?.intent).toBe("Try a sanitized name (best guess)");
  });

  it("WorkstreamNameInvalidError never suggests a name that fails validation", () => {
    // f_wsstate_name_hint_invalid: the sanitiser used to echo a leading
    // digit, '/' and spaces back, so the suggestion failed the same check
    // (and an unquoted space split it into two positionals).
    const cases: Array<[string, string]> = [
      ["1foo/bar", "mu workstream init foo_bar"],
      ["Foo Bar", "mu workstream init foo_bar"],
      ["roadmap-v0.2", "mu workstream init roadmap-v0_2"],
      ["123", "mu workstream init <name>"],
    ];
    for (const [attempted, expected] of cases) {
      const init = new WorkstreamNameInvalidError(attempted)
        .errorNextSteps()
        .find((s) => s.command.startsWith("mu workstream init"));
      expect(init?.command).toBe(expected);
    }
  });

  it("TaskIdInvalidError and TaskNotFoundError hints name real flags and do not repeat", () => {
    // f_tasks_error_hints_wrong: `mu task add` has no --id flag (the id is a
    // positional), and TaskNotFoundError printed one recipe under two intents.
    const idSteps = new TaskIdInvalidError("Bad ID").errorNextSteps();
    expect(idSteps.map((s) => s.intent).join(" ")).not.toContain("--id");
    const nfCommands = new TaskNotFoundError("foo").errorNextSteps().map((s) => s.command);
    expect(new Set(nfCommands).size).toBe(nfCommands.length);
  });

  it("PaneNotFoundError borrows its pane-probe steps from the backend that raised it", () => {
    const err = new PaneNotFoundError("%999", tmuxBackend);
    const steps = err.errorNextSteps();
    expect(steps.some((s) => s.command.includes("list-panes"))).toBe(true);
  });

  // A herdr user must never be shown `tmux list-panes`. With no backend
  // attached we degrade to mu's own verbs rather than guessing.
  it("PaneNotFoundError with no backend offers only backend-agnostic steps", () => {
    const err = new PaneNotFoundError("%999");
    const commands = err.errorNextSteps().map((s) => s.command);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((c) => !c.includes("tmux "))).toBe(true);
    expect(commands.some((c) => c.startsWith("mu "))).toBe(true);
  });

  // agent_spawn_liveness_check_trips_on: the spawn-died Next: block
  // used to suggest only the global env-var override, which is
  // overkill for one-off spawns (and silently affects every later
  // spawn in the same shell). The per-spawn `--command` recipe must
  // be advertised AND must come BEFORE the env-var step.
  it("AgentDiedOnSpawnError advertises per-spawn --command override before the global env-var", () => {
    const err = new AgentDiedOnSpawnError("scout-perf-1", "%42", undefined);
    const steps = err.errorNextSteps();

    const perSpawnIdx = steps.findIndex(
      (s) => s.command.startsWith("mu agent spawn ") && s.command.includes('--command "'),
    );
    expect(
      perSpawnIdx,
      `expected a per-spawn --command step; got: ${JSON.stringify(steps)}`,
    ).toBeGreaterThanOrEqual(0);

    // Agent name is interpolated into the per-spawn recipe so the
    // operator can copy-paste it verbatim.
    expect(steps[perSpawnIdx]?.command).toContain("scout-perf-1");

    const globalIdx = steps.findIndex((s) => s.command.includes("MU_PI_COMMAND"));
    expect(globalIdx, "expected the global env-var step to still exist").toBeGreaterThanOrEqual(0);

    // Per-spawn (right scope for one-offs) must come first.
    expect(perSpawnIdx).toBeLessThan(globalIdx);
  });

  it("AgentDiedOnSpawnError for an ssh command names remote causes, not wrapper locks", () => {
    const err = new AgentDiedOnSpawnError(
      "rw-1",
      "%7",
      "zsh:1: command not found: pi",
      "ssh -o ControlMaster=no host -t 'pi'",
    );
    expect(err.message).toContain("remote binary is missing");
    expect(err.message).toContain("-ilc");
    expect(err.message).toContain("AllowStreamLocalForwarding");
    expect(err.message).toContain("command not found: pi");
    expect(err.message).not.toContain("instance lock");
    const cmds = err.errorNextSteps().map((s) => s.command);
    expect(cmds).toContain("mu host init <host> --ssh");
    expect(cmds.join("\n")).not.toContain("remote-env");
    expect(cmds.join("\n")).not.toContain("pi-meta --no-solo");
  });

  it("AgentDiedOnSpawnError for a --host spawn names the host and its check", () => {
    const err = new AgentDiedOnSpawnError(
      "rw-1",
      "%7",
      undefined,
      "exec /bin/sh -c x",
      undefined,
      "dev",
    );
    expect(err.message).toContain("host dev");
    expect(err.errorNextSteps().map((s) => s.command)).toContain("mu host check dev");
  });

  it("AgentCtlUnreachableError points at the host check only for a remote agent", () => {
    const local = new AgentCtlUnreachableError("w-1", "auth", "/s.sock", "missing");
    expect(
      local
        .errorNextSteps()
        .map((s) => s.command)
        .join("\n"),
    ).not.toContain("mu host");
    const remote = new AgentCtlUnreachableError("w-1", "auth", "/s.sock", "refused", "dev");
    expect(remote.errorNextSteps().map((s) => s.command)).toContain(
      "mu host check dev --agent w-1 -w auth",
    );
  });
});

// Regression: nextsteps_audit_task_not_found_workstream_col
//
// Several typed errors suggest `mu sql "..."` recipes as next steps.
// Pre-v5 these recipes referenced the long-gone `tasks.workstream`
// (TEXT) column; v5 replaced it with `tasks.workstream_id` (FK →
// workstreams.id). The hint a user sees first on a missed-task lookup
// must actually run.
//
// This test extracts every SELECT-style `mu sql` recipe from
// TaskNotFoundError.errorNextSteps() and executes it against a
// freshly-opened v-current DB. Any "no such column" error fails the
// test loudly, instead of waiting for an end user to be the canary.
describe("TaskNotFoundError SQL recipes execute against the live schema", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-test-nextsteps-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('every `mu db query "SELECT ..."` recipe parses and runs (no stale columns)', () => {
    const err = new TaskNotFoundError("foo");
    const steps = err.errorNextSteps();
    const recipes = steps.map((s) => s.command).filter((c) => c.startsWith('mu db query "SELECT'));
    expect(recipes.length).toBeGreaterThan(0);

    const db = openDb({ path: dbPath });
    try {
      for (const recipe of recipes) {
        // Strip `mu db query "..."` wrapper to get raw SQL.
        const sql = recipe.replace(/^mu db query "(.*)"$/, "$1");
        expect(() => db.prepare(sql).all()).not.toThrow();
      }
    } finally {
      db.close();
    }
  });
});
