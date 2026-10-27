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
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveNumber,
  parseSeconds,
  TASK_SORT_KEYS,
  WORKSTREAM_OPT,
} from "../../cli.js";
import { NOTE_KINDS, type NoteKind } from "../../db.js";
import { TASK_SUBSTATES } from "../../tasks/status.js";
import { TASK_STATUS_LIST } from "../../tasks.js";
import { installWaitSignals } from "../wait.js";
import { cmdTaskAuto } from "./auto.js";
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
    .option("--all", "no cap: every task, whole (a cut result names this command)")
    .option("--owner <agent>", "only tasks this agent owns (<agent> or <workstream>/<agent>)")
    .option("--mine", "only tasks the calling agent owns")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        status?: string[];
        substate?: string[];
        sort?: string;
        all?: boolean;
        owner?: string;
        mine?: boolean;
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
    .option("--all", "no cap: every ready task, whole (a cut result names this command)")
    .option("--sort <key>", `${SORT_OPT_DESC} (default roi)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        lines?: number;
        json?: boolean;
        sort?: string;
        all?: boolean;
      };
      return handle((db) => cmdTaskNext(db, opts), this as Command)();
    });

  task
    .command("owned-by <agent>")
    .description(
      "List tasks owned by an agent in the current workstream; --all spans every workstream's same-named agent, --include-closed adds CLOSED ones, --full lifts the 4 KB cap.",
    )
    .option(
      "--include-closed",
      "include CLOSED tasks (closeTask preserves owner as historical record; default omits them)",
    )
    .option(
      "--all",
      "surface every workstream's same-named agent (cross-workstream view; default scopes to current workstream)",
    )
    .option("--full", "no cap: every task, whole (a cut result names this command)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).optsWithGlobals() as {
        json?: boolean;
        includeClosed?: boolean;
        all?: boolean;
        full?: boolean;
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
    .option(
      "--report",
      "file the note as the task's report (kind report, never edited; the last report wins, earlier ones stay in `mu task notes <id> --all`)",
    )
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
    .description(
      "Show a task: one record, its edges (blockers/dependents) and the default notes view (see `task notes`), capped at 4 KB; a cut names the same command with --all (everything, whole). --note <n> prints one note whole.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .option(
      "--note <n>",
      "print note <n> of this task whole (n as shown in `task notes`)",
      parsePositiveNumber,
    )
    .option("--all", "no cap: the task, every neighbour and every note, whole")
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        json?: boolean;
        workstream?: string;
        note?: number;
        all?: boolean;
      };
      return handle((db) => cmdTaskShow(db, id, opts), this as Command)();
    });

  task
    .command("tree <id>")
    .description(
      "Open tree of a task's blockers (--down: dependents), one record per entry: open tasks expand, CLOSED are leaves, diamonds list once then `again=1`. 4 KB cap; a cut names the same command with --all.",
    )
    .option("--down", "render dependents (what this task blocks) instead of blockers")
    .option("--all", "no cap: every level, CLOSED tasks too, whole")
    .option(
      "--from <n>",
      "start at entry <n> (a cut result names the command)",
      parsePositiveNumber,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        all?: boolean;
        down?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskTree(db, id, opts), this as Command)();
    });

  task
    .command("notes <id>")
    .description(
      "A task's notes, one per line (a newline inside a note prints as \\n): the brief, the report, every verdict, the last 3 others; `more=N next=…` names the rest. --all/--from <n> page the history; --tail, --since, --since-claim filter.",
    )
    .option("--all", "every note, from the first (the default view leaves some out)")
    .option("--from <n>", "every note from note <n> on", parsePositiveNumber)
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
        all?: boolean;
        from?: number;
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
        all?: boolean;
        from?: number;
      } = {};
      if (opts.all !== undefined) merged.all = opts.all;
      if (opts.from !== undefined) merged.from = opts.from;
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
    .option(
      "--why <text>",
      "reason, stored as a note; every --as but done needs it (done takes --evidence instead)",
    )
    .option(
      "--if-ready",
      "only close when every blocker is CLOSED; otherwise no-op + list the still-blocking ids",
    )
    .option(
      "--report <text>",
      "the worker's report, stored first as its own note (not evidence); the last report wins, earlier ones stay in `mu task notes <id> --all`",
    )
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
    .command("auto [ids...]")
    .description(
      "Authorise tasks for `mu next` on THIS machine (ready alone is never permission): stores cli key, worktree mode and run ceiling, and names this machine the task's dispatch host. --off revokes; counters stay. Refuses another host's task.",
    )
    .option("--blockers-of <id>", "also authorise every open transitive blocker of <id> (not <id>)")
    .option("--cli <key>", "agent CLI key to spawn (required unless --off)")
    .option("--worktree", "give each worker its own worktree")
    .option("--max <n>", "run ceiling per task (default 1)", parsePositiveInt)
    .option("--off", "revoke this machine's permission (keeps runs and the replay receipt)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (ids: string[]) {
      const opts = (this as Command).opts() as {
        blockersOf?: string;
        cli?: string;
        worktree?: boolean;
        max?: number;
        off?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskAuto(db, ids, opts), this as Command)();
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
    .option(
      "--if <rev>",
      "apply only if the task is still at this revision (from `mu task show --json` .task.revision or a preview); stale refuses with exit 4",
      parseNonNegativeInt,
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
        if?: number;
      };
      return handle((db) => cmdTaskRelease(db, id, opts), this as Command)();
    });

  task
    .command("claim <id>")
    .description(
      "Claim a task. Default: the claimer is $MU_AGENT_NAME (a registered worker). --for <worker> dispatches; --self is an anonymous orchestrator claim (owner NULL).",
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
    .option(
      "--and-wait",
      "after a --for dispatch, wait for the task (`mu wait` semantics: ONE JSON result, `data.claimed` is the claim, SIGINT/SIGTERM print a snapshot and a `resume`). Needs --for",
    )
    .option(
      "--if <rev>",
      "apply only if the task is still at this revision (from `mu task show --json` .task.revision or a preview); stale refuses with exit 4",
      parseNonNegativeInt,
    )
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
        if?: number;
        andWait?: boolean;
      };
      const sig = opts.andWait ? installWaitSignals() : undefined;
      const run = handle((db) => cmdClaim(db, taskId, opts, sig), this as Command)();
      return sig === undefined ? run : run.finally(() => sig.dispose());
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
    .option(
      "--if <rev>",
      "apply only if the task is still at this revision (from `mu task show --json` .task.revision or a preview); stale refuses with exit 4",
      parseNonNegativeInt,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as {
        by: string | string[];
        workstream?: string;
        json?: boolean;
        if?: number;
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
    .option(
      "--if <rev>",
      "apply only if the task is still at this revision (from `mu task show --json` .task.revision or a preview); stale refuses with exit 4",
      parseNonNegativeInt,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as {
        by: string | string[];
        workstream?: string;
        json?: boolean;
        if?: number;
      };
      return handle((db) => cmdTaskUnblock(db, blocked, opts), this as Command)();
    });

  task
    .command("delete <id>")
    .description(
      "Delete a task (cascades edges + notes via FK). Two-phase: bare = dry-run preview with `rev`; --if <rev> commits (refused if the task changed since); --yes commits unfenced. Idempotent on missing.",
    )
    .option("-y, --yes", "actually delete (without --yes prints a dry-run preview)")
    .option(
      "--if <rev>",
      "apply only if the task is still at this revision (from `mu task show --json` .task.revision or a preview); stale refuses with exit 4",
      parseNonNegativeInt,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        yes?: boolean;
        if?: number;
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
    .option(
      "--if <rev>",
      "apply only if the task is still at this revision (from `mu task show --json` .task.revision or a preview); stale refuses with exit 4",
      parseNonNegativeInt,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        blockedBy: string[];
        workstream?: string;
        json?: boolean;
        if?: number;
      };
      return handle((db) => cmdTaskReparent(db, id, opts), this as Command)();
    });

  task
    .command("wait <ids...>")
    .description(
      "Alias of `mu wait` over task refs: the FIRST task to reach --status (default CLOSED), or every one with --all. Same JSON result and exits. Ids: bare with -w, or <ws>/<id>. Task AND agent refs: `mu wait task:<id> agent:<name>`.",
    )
    .option(
      "--status <status>",
      `target status (${TASK_STATUS_LIST}, case-insensitive); default CLOSED`,
    )
    .option("--first", "end on the first event (the default)")
    .option("--any", "alias for --first")
    .option("--first-of", "alias for --first")
    .option(
      "--all",
      "end when every listed task reached the target (an owner dying or stalling still ends it early)",
    )
    .option("--all-of", "alias for --all")
    .option(
      "--timeout <seconds>",
      "heartbeat deadline, fractions allowed (default 1500, which is also the cap; 0 = the cap)",
      parseSeconds,
    )
    .option(
      "--stuck-after <seconds>",
      "report an owner stalled after this long in needs_input (0 = never; default 120, or 5 for a pi owner read over its control socket); a stall is an event with exit 7",
      parseSeconds,
    )
    .option(
      "--on-stall <action>",
      "exit (default): a stall ends the wait; warn: flag it and keep waiting; steer: send the stalled owner one fixed reminder and keep waiting; release: free the stalled task and end the wait",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (ids: string[]) {
      const opts = (this as Command).opts() as {
        status?: string;
        any?: boolean;
        first?: boolean;
        firstOf?: boolean;
        all?: boolean;
        allOf?: boolean;
        timeout?: number;
        stuckAfter?: number;
        onStall?: string;
        workstream?: string;
        json?: boolean;
      };
      const sig = installWaitSignals();
      return handle((db) => cmdTaskWait(db, ids, opts, sig), this as Command)().finally(() =>
        sig.dispose(),
      );
    });
}
