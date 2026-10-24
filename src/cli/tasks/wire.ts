// mu — `mu task` commander wiring.
//
// Pure glue: every `task.command(...)` definition lives here, so the
// per-verb modules in this cluster stay focused on behaviour. Imported
// by buildProgram() in src/cli.ts via the re-export hub at
// src/cli/tasks.ts.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import { type Command, Option } from "commander";
import {
  handle,
  JSON_OPT,
  normalizeInheritedWorkstream,
  parseImpact,
  parseLines,
  parsePositiveNumber,
  parseSeconds,
  TASK_SORT_KEYS,
  WORKSTREAM_OPT,
} from "../../cli.js";
import { NOTE_KINDS, type NoteKind } from "../../db.js";
import { TASK_SUBSTATES } from "../../tasks/status.js";
import { TASK_STATUS_LIST } from "../../tasks.js";
import { cmdClaim, cmdTaskRelease, cmdTaskWait } from "./claim.js";
import { cmdTaskBlock, cmdTaskDelete, cmdTaskReparent, cmdTaskUnblock } from "./edges.js";
import {
  cmdTaskAdd,
  cmdTaskNote,
  cmdTaskNotes,
  cmdTaskShow,
  cmdTaskUpdate,
  resolveNoteText,
} from "./edit.js";
import {
  cmdTaskAccept,
  cmdTaskClose,
  cmdTaskOpen,
  cmdTaskPark,
  cmdTaskUnpark,
} from "./lifecycle.js";
import { cmdTaskList, cmdTaskNext, cmdTaskOwnedBy } from "./queries.js";
import { cmdTaskTree } from "./tree.js";

export function wireTaskCommands(program: Command): void {
  const task = program.command("task").description("Task graph commands");

  const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

  task
    .command("add [ids...]")
    .description(
      "Add tasks atomically. No id: derived from -t (cut at ~40 chars, collisions get _2…). Several ids need one -t each; --note, score and edges apply to all. --blocks <umbrella> makes the umbrella wait for them.",
    )
    .requiredOption("-t, --title <title>", "task title (repeat: one per id)", collect)
    .option(
      "-i, --impact <n>",
      "impact 1..100 (default 50; giving -i or -e scores the task)",
      parseImpact,
    )
    .option("-e, --effort-days <days>", "effort in days (>0; default 1)", parsePositiveNumber)
    .option(
      "-b, --blocked-by <ids...>",
      "task ids that block this one (repeat or comma-separate; or both)",
    )
    .option(
      "--blocks <ids...>",
      "umbrella ids this task blocks (repeat or comma-separate); rolls back with the task on a cycle",
    )
    .option(
      "--note <text>",
      "append an initial note (the brief) after creating the task; `-` reads it from stdin (prose: --note - <<'EOF')",
    )
    .option("--note-author <name>", "author label for --note (default: current actor)")
    .option(
      "--triage",
      "start as OPEN/triage: a proposal (e.g. a review finding) kept out of next/claim until `mu task accept`",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (ids: string[]) {
      const opts = (this as Command).opts() as {
        title: string[];
        impact?: number;
        effortDays?: number;
        blockedBy?: string[];
        blocks?: string[];
        note?: string;
        noteAuthor?: string;
        triage?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskAdd(db, ids, opts), this as Command)();
    });

  // --sort key list shared across list/next. `id` is the historical
  // default for `mu task list`; `roi` is the default for `next` (the
  // "what should I do" verb; `next -n 0` replaced `task ready`). The two time-based
  // keys (`recency` = updated_at DESC, `age` = created_at ASC) trigger
  // an extra `updated`/`created` column with relative timestamps so
  // the user sees the dimension they sorted by.
  const SORT_OPT_DESC = `sort key (${TASK_SORT_KEYS.join(" | ")})`;
  const SUBSTATE_OPT_DESC = `filter by substate (${[...new Set(Object.values(TASK_SUBSTATES).flat())].join(" | ")}; repeat or comma-separate)`;

  task
    .command("list")
    .description("List every task in the current workstream (id, status, ROI, owner)")
    .option(...WORKSTREAM_OPT)
    .option(
      "--status <status...>",
      `filter by lifecycle status (${TASK_STATUS_LIST}; case-insensitive; repeat or comma-separate; or both)`,
    )
    .option("--substate <substate...>", SUBSTATE_OPT_DESC)
    .option("--sort <key>", `${SORT_OPT_DESC} (default id)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        status?: string[];
        substate?: string[];
        sort?: string;
      };
      return handle((db) => cmdTaskList(db, opts), this as Command)();
    });

  task
    .command("next")
    .description(
      "Show the next ready task(s) by ROI (impact / effort_days). The 'what should I do?' verb. Pass -n 0 for the unlimited 'what is doable?' shape (merged-in `task ready`).",
    )
    .option(
      "-n, --lines <k>",
      "how many top-K tasks to return (default 1; 0 = all ready)",
      parseLines,
    )
    .option(...WORKSTREAM_OPT)
    .option("--sort <key>", `${SORT_OPT_DESC} (default roi)`)
    .option(
      "--status <status...>",
      `filter by lifecycle status (${TASK_STATUS_LIST}; case-insensitive; repeat or comma-separate; or both)`,
    )
    .option("--substate <substate...>", SUBSTATE_OPT_DESC)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        lines?: number;
        json?: boolean;
        sort?: string;
        status?: string[];
        substate?: string[];
      };
      return handle((db) => cmdTaskNext(db, opts), this as Command)();
    });

  task
    .command("owned-by <agent>")
    .description(
      "List tasks owned by an agent. Defaults to the current workstream (v5: agent names are per-workstream unique). Pass --all to surface every workstream's same-named worker. Excludes CLOSED by default — pass --include-closed for the full historical owner list.",
    )
    .option(
      "--include-closed",
      "include CLOSED tasks (closeTask preserves owner as historical record; default omits them)",
    )
    .option(
      "--all",
      "surface every workstream's same-named agent (cross-workstream view; default scopes to current workstream)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).optsWithGlobals() as {
        json?: boolean;
        includeClosed?: boolean;
        all?: boolean;
        workstream?: string | string[];
      };
      return handle(
        (db) =>
          cmdTaskOwnedBy(db, agent, {
            ...opts,
            workstream: normalizeInheritedWorkstream(opts.workstream),
          }),
        this as Command,
      )();
    });

  task
    .command("note <id> [text]")
    .description(
      "Append a note: <text> or -m/--message/--note/--text. Prose (an apostrophe ends '...'): pass `-` and a quoted heredoc, mu task note <id> - <<'EOF'; stdin is stored verbatim. --report files the report.",
    )
    .option("-m, --message <text>", "the note text (alias for <text>)")
    .option("--note <text>", "the note text (alias for <text>)")
    .option("--text <text>", "the note text (alias for <text>)")
    .option("--report", "file the note as the task's report (kind report; set once, never edited)")
    .addOption(
      new Option("--kind <kind>", "note kind (internal: delegates write verdicts)")
        .choices(NOTE_KINDS)
        .hideHelp(),
    )
    .option("--author <name>", "override the auto-detected author label")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string, text: string | undefined) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        author?: string;
        message?: string;
        note?: string;
        text?: string;
        report?: boolean;
        kind?: NoteKind;
      };
      // resolveNoteText throws UsageError; call it INSIDE the handle()
      // callback so the typed-error → exit-code map wraps it. A throw
      // from the .action() body itself escapes to commander's
      // parse-time catch, which is a different (and DB-close-skipping)
      // lane. Same rule every other verb's validation follows.
      return handle(
        (db) =>
          cmdTaskNote(
            db,
            id,
            resolveNoteText(text, {
              "-m/--message": opts.message,
              "--note": opts.note,
              "--text": opts.text,
            }),
            opts,
          ),
        this as Command,
      )();
    });

  task
    .command("show <id>")
    .description("Show a task: row + edges (blockers/dependents) + notes")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { json?: boolean; workstream?: string };
      return handle((db) => cmdTaskShow(db, id, opts), this as Command)();
    });

  task
    .command("tree <id>")
    .description(
      "ASCII tree of a task's blockers (default) or dependents (--down). Diamonds collapse to one render with an arrow marker.",
    )
    .option("--down", "render dependents (what this task blocks) instead of blockers")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        down?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskTree(db, id, opts), this as Command)();
    });

  task
    .command("notes <id>")
    .description(
      "List the notes attached to a task (oldest first). Filters: --tail N (last N), --since <iso> (after timestamp), --since-claim (since most recent claim event).",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .option("--tail <n>", "print only the last N notes (alias --last)", parsePositiveNumber)
    .option("--last <n>", "alias for --tail", parsePositiveNumber)
    .option("--since <iso>", "print only notes created after this ISO 8601 timestamp")
    .option(
      "--since-claim",
      "print only notes since the most recent 'task claim' event (auto-resolved)",
    )
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        json?: boolean;
        workstream?: string;
        tail?: number;
        last?: number;
        since?: string;
        sinceClaim?: boolean;
      };
      // --last is an alias for --tail; collapse before passing to the verb.
      // If both are provided, prefer the explicit --tail.
      const tail = opts.tail ?? opts.last;
      const merged: {
        json?: boolean;
        workstream?: string;
        tail?: number;
        since?: string;
        sinceClaim?: boolean;
      } = {};
      if (opts.json !== undefined) merged.json = opts.json;
      if (opts.workstream !== undefined) merged.workstream = opts.workstream;
      if (tail !== undefined) merged.tail = tail;
      if (opts.since !== undefined) merged.since = opts.since;
      if (opts.sinceClaim !== undefined) merged.sinceClaim = opts.sinceClaim;
      return handle((db) => cmdTaskNotes(db, id, merged), this as Command)();
    });

  // --evidence <text> on the four lifecycle verbs records what the
  // caller relied on (test output, command exit, observed file change)
  // in the auto-emitted event payload. The verb still trusts the
  // caller; the audit trail records what they said. First inch of
  // the "observed vs claimed state" distinction.
  const EVIDENCE_OPT = [
    "--evidence <text>",
    "record what the caller observed (e.g. 'tests pass: npm test exit 0'); appears verbatim in the event log",
  ] as const;

  task
    .command("close <id>")
    .description(
      'Mark a task CLOSED (idempotent). `done` needs --evidence/--note "<command + result>" and closed blockers (exit 4); --report adds the report. --as <substate> needs --why. --if-ready waits for blockers.',
    )
    .option(
      "--as <substate>",
      `closing substate (${TASK_SUBSTATES.CLOSED.join(" | ")}; default done)`,
    )
    .option("--why <text>", "reason, stored as a note; required unless --as done")
    .option(
      "--if-ready",
      "only close when every blocker is CLOSED; otherwise no-op + list the still-blocking ids",
    )
    .option("--report <text>", "the worker's report, stored first as its own note (not evidence)")
    .option("--note <text>", "alias for --evidence")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        note?: string;
        report?: string;
        as?: string;
        why?: string;
        ifReady?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskClose(db, id, opts), this as Command)();
    });

  task
    .command("open <id>")
    .description("Mark a task OPEN — e.g. to reopen something closed by mistake (idempotent)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskOpen(db, id, opts), this as Command)();
    });

  task
    .command("park <id>")
    .description(
      "Park an OPEN task (OPEN/parked): it leaves `next` and `claim` refuses it without --force. Dependents stay blocked. Idempotent.",
    )
    .requiredOption("--why <text>", "why it is parked; stored as a note")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        why: string;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskPark(db, id, opts), this as Command)();
    });

  task
    .command("accept <id>")
    .description(
      "Accept an OPEN/triage task (a proposed finding) as work: OPEN/todo, back in `next`. No-op on any other state. Decline with `close --as rejected|duplicate --why`.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskAccept(db, id, opts), this as Command)();
    });

  task
    .command("unpark <id>")
    .description("Return a parked task to OPEN (back in `next`). No-op on any other state.")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskUnpark(db, id, opts), this as Command)();
    });

  task
    .command("release <id>")
    .description(
      "Clear a task's owner. IN_PROGRESS auto-flips to OPEN so the task re-enters the ready set; other statuses preserved. Use --reopen to force OPEN from CLOSED. Idempotent.",
    )
    .option(
      "--reopen",
      "force status to OPEN regardless of current status (escape hatch for un-closing a CLOSED owned task in one verb)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        reopen?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskRelease(db, id, opts), this as Command)();
    });

  task
    .command("claim <id>")
    .description(
      "Claim a task. Default: the claiming agent is $MU_AGENT_NAME (injected at spawn; must be a registered worker). " +
        "Use --for <worker> to dispatch. Use --self for orchestrator-direct work (anonymous claim, owner=NULL, actor recorded in agent_logs).",
    )
    .option(
      "-f, --for <agent>",
      "claim on behalf of a registered worker (dispatch); accepts bare 'name' (resolves in the task's workstream) or qualified '<workstream>/<name>' for cross-workstream dispatch (e.g. 'roadmap-v0-3/worker-1')",
    )
    .option(
      "--self",
      "anonymous claim (orchestrator pattern): owner stays NULL; actor recorded in agent_logs.source. Mutually exclusive with --for.",
    )
    .option(
      "--actor <name>",
      "override the actor name used for the log (only valid with --self; defaults to $MU_AGENT_NAME or $USER)",
    )
    .option("--force", "claim even when the task is parked or in triage (OPEN/parked, OPEN/triage)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (taskId: string) {
      const opts = (this as Command).opts() as {
        for?: string;
        self?: boolean;
        actor?: string;
        evidence?: string;
        workstream?: string;
        json?: boolean;
        force?: boolean;
      };
      return handle((db) => cmdClaim(db, taskId, opts), this as Command)();
    });

  task
    .command("block <blocked>")
    .description(
      "Add blocking edges: --by <ids...> blocks <blocked>. Accepts repeat or comma-separated ids (same shape as `mu task add --blocked-by`). Validates same-workstream + cycle.",
    )
    .requiredOption(
      "-b, --by <blockers...>",
      "the task(s) that should block <blocked> (repeat or comma-separate)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as {
        by: string | string[];
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskBlock(db, blocked, opts), this as Command)();
    });

  task
    .command("unblock <blocked>")
    .description(
      "Remove blocking edges (idempotent). --by accepts repeat or comma-separated ids, symmetric with `mu task block`.",
    )
    .requiredOption(
      "-b, --by <blockers...>",
      "the task(s) whose blocker edge to remove (repeat or comma-separate)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as {
        by: string | string[];
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskUnblock(db, blocked, opts), this as Command)();
    });

  task
    .command("delete <id>")
    .description(
      "Delete a task (cascades edges + notes via FK). Two-phase: bare = dry-run preview; --yes commits. Idempotent on missing.",
    )
    .option("-y, --yes", "actually delete (without --yes prints a dry-run preview)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        yes?: boolean;
      };
      return handle((db) => cmdTaskDelete(db, id, opts), this as Command)();
    });

  task
    .command("update <id>")
    .description(
      "Update scalar fields on a task. Pass at least one of --title, --impact, --effort-days. Use close/open/release for status/owner changes.",
    )
    .option("-t, --title <title>", "new title")
    .option("-i, --impact <n>", "new impact 1..100", parseImpact)
    .option("-e, --effort-days <days>", "new effort in days (>0)", parsePositiveNumber)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        title?: string;
        impact?: number;
        effortDays?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskUpdate(db, id, opts), this as Command)();
    });

  task
    .command("reparent <id>")
    .description(
      "Atomically replace every incoming edge of <id> with the new --blocked-by list. Pass --blocked-by '' to clear all blockers.",
    )
    .requiredOption(
      "-b, --blocked-by <ids...>",
      "tasks that block <id> (repeat or comma-separate; or both; pass an empty string to clear)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        blockedBy: string[];
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskReparent(db, id, opts), this as Command)();
    });

  task
    .command("wait <ids...>")
    .description(
      "Block until the listed tasks reach --status (default CLOSED). Each <id> may be bare (needs -w, or the worker's injected workstream) or qualified `<workstream>/<name>` (cross-workstream waits don't need -w). Default: every task must reach the target. --any / --first exit on the first one that does; --first additionally prints the firing ref's qualified id to stdout. A worker needing attention terminates the wait with exit 7 (--on-stall exit, the default). Exit 0 = condition met; 5 = timeout; 6 = a watched task was reaper-flipped IN_PROGRESS→OPEN (target=CLOSED only); 7 = a worker needs attention (target=CLOSED, unless --on-stall warn).",
    )
    .option(
      "--status <status>",
      `target status (${TASK_STATUS_LIST}, case-insensitive); default CLOSED`,
    )
    .option(
      "--any",
      "succeed as soon as ONE listed task reaches the target (default: all must). Reports THAT one fired, not which: --json leaves `firing` null even on success, so use --first if you need to identify the ref.",
    )
    .option(
      "--first",
      "alias for --any that ALSO prints the firing ref's qualified id to stdout and populates `firing` in --json (which --any leaves null). Use to drive a single-shot dispatch loop: `closed=$(mu task wait a b --first --json | jq -r .firing.qualifiedId)`.",
    )
    .option(
      "--timeout <seconds>",
      "max seconds to wait, fractions allowed (0 = forever, default 600)",
      parseSeconds,
    )
    .option(
      "--stuck-after <seconds>",
      "the TRIGGER: mark an IN_PROGRESS task as needing attention when its owner has been in needs_input for >= N seconds since their last status change (0 = disable; default 120, or 5 for a pi owner read over its control socket, whose idle is exact and comes after the close nudge; an explicit value applies to every owner). needs_input has several causes — the worker may have finished without closing, be waiting on an answer, or be sitting at a prompt — so the warning names the observation and points at `mu agent read <owner>`, which is the next move in every case. The default ACTION is `exit` (exit 7); see --on-stall warn to keep polling instead.",
      parseSeconds,
    )
    .option(
      "--on-stall <action>",
      "the ACTION when --stuck-after fires: 'exit' (default; yellow attention warning naming the owner + age, plus a corroborating agent_logs event, then exit 7 = STALL_DETECTED so an orchestrator can branch on the idle-vs-dead distinction) or 'warn' (same emit + persist; wait keeps polling). Suppressed when --status is anything other than CLOSED (mirrors exit-6's carve-out). If exit-6 (dead pane) and exit-7 (stall) would fire in the same poll, exit 6 wins (dead pane is unambiguous; stall is ambiguous).",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (ids: string[]) {
      const opts = (this as Command).opts() as {
        status?: string;
        any?: boolean;
        first?: boolean;
        timeout?: number;
        stuckAfter?: number;
        onStall?: "warn" | "exit";
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskWait(db, ids, opts), this as Command)();
    });
}
