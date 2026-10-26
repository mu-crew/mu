// audit_cli_validation_uniformity: every operator-error path must
// (1) print the error, (2) print/include the failing subcommand's
// --help, (3) exit 2.
//
// Three classes of "operator typed something wrong":
//   A. CommanderError — missing required option, unknown option,
//      unknown subcommand, missing positional argument, type-coercion
//      failure (parseImpact / parsePositiveNumber via InvalidArgumentError).
//   B. UsageError thrown inside a handler — mutex flags, range checks,
//      arity checks, anything the verb's own .action() body validates.
//   C. Typed *Invalid* domain errors that fault on a value the operator
//      typed AT THE CLI: WorkstreamNameInvalidError, PruneOptionsInvalidError,
//      TaskIdInvalidError.
//
// All three must produce the same surface:
//   - human path: red `error: <msg>`, then the failing command's
//     helpInformation() to stderr, exit 2
//   - --json path: ONE document on STDOUT, exit 2:
//     { ok:false, error, message, next:null, exit: 2, nextSteps, usage }
//     where `usage` is the verb's accepted syntax in at most 3 short lines.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, runCliJson, runCliWire } from "./_runCli.js";

interface ErrorEnvelope {
  ok: false;
  error: string;
  message: string;
  next: null;
  exit: number;
  nextSteps: unknown[];
  usage?: string[];
}

/** Run with --json and return the failure document (stdout, one line). */
async function failure(argv: string[], dbPath: string) {
  const r = await runCliJson(argv, dbPath);
  expect(r.stderr).toBe("");
  expect(r.stdout.trim().split("\n")).toHaveLength(1);
  return { exitCode: r.exitCode, env: r.doc as unknown as ErrorEnvelope };
}

describe("audit_cli_validation_uniformity", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-validation-"));
    dbPath = join(tempDir, "mu.db");
    // Seed a workstream so the verbs that need one can resolve.
    await runCli(["workstream", "init", "probe-ws"], dbPath);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // ─── Class A: commander-handled errors ────────────────────────────

  describe("class A — CommanderError (parse-time)", () => {
    it("missing required option (--title): exit 2 + help block + JSON usage", async () => {
      const human = await runCli(["task", "add", "-w", "probe-ws"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*--title.*not specified/);
      // Help block follows the error in the same stderr stream.
      expect(human.stderr).toMatch(/Usage: mu task add/);
      expect(human.stderr).toMatch(/Options:/);

      const { exitCode, env } = await failure(["task", "add", "-w", "probe-ws", "--json"], dbPath);
      expect(exitCode).toBe(2);
      expect(env.ok).toBe(false);
      expect(env.error).toBe("CommanderError");
      expect(env.exit).toBe(2);
      expect(env.next).toBeNull();
      // The human-level "error: " prefix is stripped from the JSON
      // message so JSON consumers don't get "error: error: ...".
      expect(env.message).not.toMatch(/^error:/);
      expect(env.message).toMatch(/--title.*not specified/);
      // The accepted syntax, in at most 3 lines (never the whole help as JSON).
      expect(env.usage).toBeDefined();
      expect(env.usage?.length).toBeLessThanOrEqual(3);
      expect(env.usage?.[0]).toMatch(/^mu task add/);
      expect(env.usage?.join("\n")).toMatch(/--title/);
    });

    it("unknown option: exit 2 + help block + JSON usage", async () => {
      const human = await runCli(["task", "list", "-w", "probe-ws", "--bogus"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*unknown option.*--bogus/);
      expect(human.stderr).toMatch(/Usage: mu task list/);

      const { exitCode, env } = await failure(
        ["task", "list", "-w", "probe-ws", "--bogus", "--json"],
        dbPath,
      );
      expect(exitCode).toBe(2);
      expect(env.usage?.[0]).toMatch(/^mu task list/);
      expect(env.usage?.length).toBeLessThanOrEqual(3);
    });

    it("unknown subcommand: exit 2, one line naming the parent's --help", async () => {
      const human = await runCli(["task", "bogus"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*unknown command.*bogus/);
      // One line naming the parent's --help, not the help itself (the subcommand "bogus" doesn't exist).
      expect(human.stderr).toContain("see mu task --help");
      expect(human.stderr).not.toMatch(/Usage: mu task/);
      expect(human.stderr.trim().split("\n")).toHaveLength(1);
    });

    it("missing positional argument: exit 2 + help block", async () => {
      const human = await runCli(["agent", "send"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*missing required argument.*name/);
      expect(human.stderr).toMatch(/Usage: mu agent send/);
    });

    it("type-coercion failure (parseImpact): exit 2 + JSON usage", async () => {
      const { exitCode, env } = await failure(
        ["task", "add", "-w", "probe-ws", "-t", "x", "-i", "abc", "-e", "1", "--json"],
        dbPath,
      );
      expect(exitCode).toBe(2);
      expect(env.error).toBe("CommanderError");
      expect(env.message).toMatch(/expected 1\.\.100/);
      expect(env.usage?.[0]).toMatch(/^mu task add/);
    });
  });

  // ─── Class B: handler-thrown UsageError ───────────────────────────

  describe("class B — UsageError (handler-thrown)", () => {
    it("--self / --for mutex: exit 2 + help block + JSON usage", async () => {
      const human = await runCli(
        ["task", "claim", "anything", "--self", "--for", "worker", "-w", "probe-ws"],
        dbPath,
      );
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*--self and --for are mutually exclusive/);
      // The fix versus today's behavior: handler-thrown UsageError now
      // ALSO prints the failing subcommand's --help.
      expect(human.stderr).toMatch(/Usage: mu task claim/);
      expect(human.stderr).toMatch(/--self/);
      expect(human.stderr).toMatch(/-f, --for/);

      const { exitCode, env } = await failure(
        ["task", "claim", "anything", "--self", "--for", "worker", "-w", "probe-ws", "--json"],
        dbPath,
      );
      expect(exitCode).toBe(2);
      expect(env.error).toBe("UsageError");
      expect(env.exit).toBe(2);
      // Same usage shape as the commander path.
      expect(env.usage?.[0]).toMatch(/^mu task claim/);
      expect(env.usage?.join("\n")).toMatch(/--self/);
    });

    it("--all / -w mutex on `mu state`: exit 2, one line (a scope error)", async () => {
      // `state` prints JSON by default: the failure is the document on stdout.
      const r = await runCliWire(["state", "--all", "-w", "probe-ws"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toBe("");
      const doc = JSON.parse(r.stdout) as { ok: boolean; message: string };
      expect(doc.ok).toBe(false);
      expect(doc.message).toMatch(/--all and -w\/--workstream are mutually exclusive/);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
    });
  });

  // ─── Class C: typed *Invalid* domain errors ───────────────────────

  describe("class C — typed *Invalid* errors", () => {
    it("WorkstreamNameInvalidError: exit 2 + help block + JSON usage", async () => {
      const human = await runCli(["workstream", "init", "Bad-Name"], dbPath);
      expect(human.exitCode).toBe(2);
      // The typed error message itself is the operator-facing message.
      expect(human.stderr).toMatch(/error:.*Bad-Name/);
      expect(human.stderr).toMatch(/Usage: mu workstream init/);

      const { exitCode, env } = await failure(["workstream", "init", "Bad-Name", "--json"], dbPath);
      expect(exitCode).toBe(2);
      expect(env.error).toBe("WorkstreamNameInvalidError");
      expect(env.usage?.[0]).toMatch(/^mu workstream init/);
    });
  });

  // ─── Cross-cutting invariants ────────────────────────────────────

  describe("invariants across all classes", () => {
    it("--help is exit 0 with no error envelope (must not regress)", async () => {
      const result = await runCli(["task", "add", "--help"], dbPath);
      // The help path goes through commander's helpDisplayed code,
      // which classifyCommanderError maps to exit 0.
      expect(result.exitCode === 0 || result.exitCode === null).toBe(true);
      expect(result.error).toBeUndefined();
      // The help text appears on stdout (commander's writeOut).
      expect(result.stdout).toMatch(/Usage: mu task add/);
    });
  });
});
