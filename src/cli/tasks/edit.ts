// mu — `mu task` create/read/edit verbs (add / show / notes / note / update).
//
// add → addTasks (one or a batch), with auto-id derivation when ids are omitted.
// show → row + edges + notes (+ lastClaimActor when owner=NULL).
// notes / note → list + append on task_notes.
// update → scalar edits (title/impact/effortDays).
//
// Plus the helpers:
//   unescapeNoteText  — \n / \t / \r / \\ inside a quoted string body
//   printNote         — shared note formatter for show + notes
//
// `who claimed this task?` for the owner=NULL --self path comes from
// the SDK's lastClaimActor (src/logs.ts) directly — the prior CLI-side
// thin-wrapper was a vestigial re-export from the cluster split, gone
// in schema_v5_cleanups.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import {
  assertTaskInWorkstream,
  colorPair,
  emitJson,
  parseCsvFlag,
  resolveEntityRef,
  resolveWorkstream,
  UsageError,
  withRoiAll,
} from "../../cli.js";
import type { Db, NoteKind } from "../../db.js";
import { lastClaimActor } from "../../logs.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../../output-contract.js";
import { taskRevision } from "../../revision.js";
import {
  addNote,
  addTasks,
  getTask,
  getTaskEdgesWithStatus,
  getTaskNote,
  listNotes,
  resolveActorIdentity,
  selectTaskNotes,
  type TaskEdgeWithStatus,
  type TaskNoteRow,
  TaskNotFoundError,
  type UpdateTaskOptions,
  updateTask,
} from "../../tasks.js";
import { noteRecord, planNotes, type ShownNote, stubAuthor, stubPreview } from "../format.js";
import { readStdinText, STDIN_ARG } from "../stdin.js";

/**
 * Translate the small set of shell-style escapes (\n, \t, \r, \\)
 * inside a note body so a heredoc-free shell call can write a
 * multi-line note in one quoted string:
 *
 *   mu task note auth "FILES: a.rs:45\nDECISION: chose JWT"
 *
 * Backslashes are protected via a NUL placeholder so `\\n` stays as
 * a literal `\n` in the output rather than being processed twice.
 */
export function unescapeNoteText(s: string): string {
  // Single-pass regex: match a backslash followed by one of the four
  // recognised escape characters and decide per-match what to emit.
  // This avoids the in-band-sentinel pattern (where a placeholder string
  // could in principle collide with legitimate note content) and means
  // `\\n` correctly yields a literal `\n` rather than a newline, because
  // the leading `\\` consumes the backslash before `\n` can match.
  return s.replace(/\\([\\ntr])/g, (_, ch: string) => {
    switch (ch) {
      case "\\":
        return "\\";
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return _;
    }
  });
}

/** Kinds a filtered `notes` view still never cuts (the default view also pins the closer's fallback). */
const PINNED_KINDS: ReadonlySet<string> = new Set(["brief", "report", "verdict"]);

/** The notes view of one task, ready to print or to put in the JSON envelope. */
interface NotesPage {
  /** The records shown (oldest first), JSON-shaped. */
  items: Record<string, unknown>[];
  /** Notes left out (by the selection or by the byte cap). */
  more: number;
  /** The exact command that recovers them; null when nothing is left out. */
  next: string | null;
  lines: string[];
}

/** The JSON record of one shown note; a stub carries a clipped author and preview, `cut` and `retrieve`. */
function noteItem(ref: string, { note, cutBytes }: ShownNote): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    n: note.n,
    kind: note.kind,
    author: cutBytes === undefined ? note.author : stubAuthor(note.author),
    created_at: note.createdAt,
    content: cutBytes === undefined ? note.content : stubPreview(note.content),
  };
  if (cutBytes !== undefined) {
    rec.cut = cutBytes;
    rec.retrieve = noteCommand(ref, note.n);
  }
  return rec;
}

const noteCommand = (ref: string, n: number): string => `mu task show ${ref} --note ${n}`;

/**
 * Cap a selection into a page. `omitted` counts what the selection left out
 * before the byte cap (default view only; an explicit `--from` asked for its
 * suffix, so only the cap's cuts count). The way back is `--from <n>` for the
 * smallest `n` not shown, or `--all` when that is note 1. The 4 KB cap is
 * measured on the bytes that go out (text lines, or the JSON document with
 * its keys and `more`/`retrieve`), pinned notes set aside; `show` and `notes`
 * differ only in the JSON key names, so each passes its own `wrap`.
 */
function buildNotesPage(
  taskId: string,
  ws: string,
  notes: readonly TaskNoteRow[],
  opts: {
    pinned: ReadonlySet<number>;
    total: number;
    fill: "newest" | "page";
    explicit: boolean;
    json: boolean;
    wrap: (items: Record<string, unknown>[], fields: Record<string, unknown>) => unknown;
  },
): NotesPage {
  const ref = `${taskId} -w ${ws}`;
  const nextFor = (first: number): string =>
    first === 1 ? `mu task notes ${ref} --all` : `mu task notes ${ref} --from ${first}`;
  const isPinned = (s: ShownNote): boolean => opts.pinned.has(s.note.n);
  const pinnedShown: ShownNote[] = notes
    .filter((n) => opts.pinned.has(n.n))
    .map((note) => ({ note }));

  // What the output says is left out, from what is actually shown.
  const omission = (shown: readonly ShownNote[]): { more: number; next: string | null } => {
    const shownN = new Set(shown.map((s) => s.note.n));
    const left = opts.explicit
      ? notes.filter((n) => !shownN.has(n.n)).map((n) => n.n)
      : Array.from({ length: opts.total }, (_, i) => i + 1).filter((i) => !shownN.has(i));
    const first = left[0];
    return { more: left.length, next: first === undefined ? null : nextFor(first) };
  };
  const render = (
    shown: readonly ShownNote[],
  ): { items: Record<string, unknown>[]; lines: string[]; more: number; next: string | null } => {
    const { more, next } = omission(shown);
    const lines = shown.map((s) => noteLine(ref, s));
    if (next !== null) lines.push(`more=${more} next=${next}`);
    return { items: shown.map((s) => noteItem(ref, s)), lines, more, next };
  };
  // The cap, measured on the FINAL output (every metadata field as emitted),
  // pinned records set aside. Exact, not predicted: serialize, then shrink.
  const emitted = (shown: readonly ShownNote[]): number => {
    const { more, next } = omission(shown);
    const ordinary = shown.filter((s) => !isPinned(s));
    if (!opts.json) {
      const lines = ordinary.map((s) => noteLine(ref, s));
      if (next !== null) lines.push(`more=${more} next=${next}`);
      return Buffer.byteLength(lines.join("\n")) + 1;
    }
    const fields = next === null ? { more: 0 } : { more, retrieve: next };
    const items = ordinary.map((s) => noteItem(ref, s));
    return Buffer.byteLength(encodeEnvelope(okEnvelope(opts.wrap(items, fields)))) + 1;
  };
  // The planner's probes are the same serialization, not an estimate: the
  // pinned notes are always shown, so a probe is pinned plus the ordinary run.
  const plan = planNotes(notes, opts.pinned, opts.fill, (ordinary) =>
    emitted([...pinnedShown, ...ordinary]),
  );
  const final = [...plan.shown];
  // Drop the oldest ordinary note (default view) or the last (a page, so what
  // is left out stays a suffix `--from` reaches). The last one stays: a page
  // makes progress, and a stub is bounded.
  while (emitted(final) > RESULT_BYTES) {
    const ordinary = final.filter((s) => !isPinned(s));
    const victim = opts.fill === "newest" ? ordinary[0] : ordinary[ordinary.length - 1];
    if (ordinary.length <= 1 || victim === undefined) break;
    final.splice(final.indexOf(victim), 1);
  }
  return render(final);
}

function noteLine(ref: string, s: ShownNote): string {
  return s.cutBytes === undefined
    ? noteRecord(s.note)
    : noteRecord(s.note, { cutBytes: s.cutBytes, command: noteCommand(ref, s.note.n) });
}

/** `more` and `retrieve`: the notes left out and the command that recovers them (key-prefixed in `show`). */
function pageFields(page: NotesPage, prefix = ""): Record<string, unknown> {
  return prefixed(
    page.next === null ? { more: 0 } : { more: page.more, retrieve: page.next },
    prefix,
  );
}

function prefixed(fields: Record<string, unknown>, prefix: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${prefix}${k}`, v]));
}

/** Split a list of edge neighbours into (still-gating, satisfied)
 *  buckets. CLOSED is the only status that satisfies a `blocks` edge;
 *  OPEN/IN_PROGRESS stay in the still-gating bucket.
 *  (task_show_blocked_by_renders_closed.) */
function partitionEdges(edges: readonly TaskEdgeWithStatus[]): {
  stillGating: TaskEdgeWithStatus[];
  satisfied: TaskEdgeWithStatus[];
} {
  const stillGating: TaskEdgeWithStatus[] = [];
  const satisfied: TaskEdgeWithStatus[] = [];
  for (const e of edges) {
    if (e.status === "CLOSED") satisfied.push(e);
    else stillGating.push(e);
  }
  return { stillGating, satisfied };
}

/** Render one edge bucket as a comma-separated `<name> [<STATUS[/substate]>]`
 *  list. The status is colour-coded the same way the task table
 *  renders it (src/cli/format.ts colorPair); satisfied buckets are
 *  additionally dimmed so they recede visually. An empty bucket
 *  renders as an em-dash (—) to match the prior "no edges" rendering
 *  for back-compat with operator-eyed scripts. */
function formatEdgeList(edges: readonly TaskEdgeWithStatus[], dim: boolean): string {
  if (edges.length === 0) return pc.dim("—");
  const parts = edges.map((e) => {
    const piece = `${e.name} [${colorPair(e)}]`;
    return dim ? pc.dim(piece) : piece;
  });
  return parts.join(", ");
}

/** A note whose whole text is empty, whitespace or a bare `-` is almost
 *  always a mistake (an older mu stored `-` literally when stdin was
 *  meant; a typo or an empty variable gives ""). It is still stored,
 *  but loudly: the warning goes to stderr and the --json `warnings`. */
export function suspiciousNoteWarnings(text: string): string[] {
  const t = text.trim();
  if (t === "") return ["note text is empty or whitespace only; stored anyway"];
  if (t === STDIN_ARG) {
    return [
      `note text is a bare "-"; stored anyway. To read stdin, pass - and pipe the text: <<'EOF' ... EOF`,
    ];
  }
  return [];
}

/** Human mode: yellow stderr lines. `--json` carries them in the document's `warnings`. */
function emitWarnings(warnings: readonly string[], json: boolean | undefined): void {
  if (json) return;
  for (const w of warnings) console.error(pc.yellow(`warning: ${w}`));
}

export async function cmdTaskAdd(
  db: Db,
  localIds: readonly string[],
  opts: {
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
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const titles = opts.title;
  if (localIds.length > 0 && titles.length !== localIds.length) {
    // A stray word is nearly always an apostrophe that ended '...' early
    // (the commander "too many arguments" case this used to be).
    throw new UsageError(
      `${localIds.length} id(s) (${localIds.join(" ")}) need ${localIds.length} -t/--title, got ${titles.length}. If text was split by an apostrophe inside '...', pass long text with a quoted heredoc: --note - <<'EOF'`,
      { showHelp: false },
    );
  }
  // Ids come from the positionals, or are derived from each title via
  // slugify (collisions get _2, _3, … suffixes) and carry the truncation
  // telemetry (slugifytitle_silently_drops_clauses). `autoDerived`
  // distinguishes the explicit-id branch so `--json` exposes the
  // truncation fields only when meaningful
  // (task_add_slugify_silently_truncates_ids).
  const autoDerived = localIds.length === 0;
  const blockedBy = parseCsvFlag(opts.blockedBy, "-b/--blocked-by");
  const blocks = parseCsvFlag(opts.blocks, "--blocks");
  const hasBlockers = blockedBy.length > 0;
  // `--note -` reads stdin verbatim (no \\n unescaping: a heredoc has
  // real newlines). Read before the transaction; it is async.
  const noteText =
    opts.note === STDIN_ARG
      ? await readStdinText("--note")
      : opts.note !== undefined
        ? unescapeNoteText(opts.note)
        : undefined;
  const warnings = noteText !== undefined ? suspiciousNoteWarnings(noteText) : [];
  emitWarnings(warnings, opts.json);
  const initialNoteAuthor =
    noteText !== undefined ? (opts.noteAuthor ?? (await resolveActorIdentity())) : undefined;
  // One group, one transaction: every task, brief and edge, or none.
  const { ids, derived: derivations } = addTasks(
    db,
    titles.map((title, i) => ({
      ...(autoDerived ? {} : { id: localIds[i] ?? "" }),
      title,
      ...(noteText !== undefined ? { note: noteText } : {}),
    })),
    {
      workstream,
      ...(hasBlockers ? { blockedBy } : {}),
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(opts.triage === true ? { triage: true } : {}),
      ...(opts.impact !== undefined ? { impact: opts.impact } : {}),
      ...(opts.effortDays !== undefined ? { effortDays: opts.effortDays } : {}),
      ...(initialNoteAuthor !== undefined ? { noteAuthor: initialNoteAuthor } : {}),
    },
  );
  const tasks = ids.map((id) => {
    const t = getTask(db, id, workstream);
    if (!t) throw new TaskNotFoundError(id, workstream);
    return t;
  });
  const task = tasks[0];
  if (task === undefined) throw new UsageError("task add: nothing to add", { showHelp: true });
  const note = noteText !== undefined ? (listNotes(db, task.name, workstream)[0] ?? null) : null;
  const derivation = derivations[0] ?? { id: task.name, truncated: false, originalSlug: task.name };
  const nextSteps: NextStep[] = [
    { intent: "Show this task", command: `mu task show ${task.name} -w ${workstream}` },
    ...(note === null
      ? [
          {
            // Single-quoted example: shell metachars (`...`, $VAR, $(...))
            // inside a double-quoted string expand in YOUR shell before mu
            // sees the note (mufeedback note #257). Single quotes defer
            // expansion to the agent.
            intent: "Add initial context (or use --note next time)",
            command: `mu task note ${task.name} 'REPRO: ...\\nSCOPE: ...' -w ${workstream}`,
          },
        ]
      : [{ intent: "Show notes", command: `mu task notes ${task.name} -w ${workstream}` }]),
    {
      intent: "Add a blocker",
      command: `mu task block ${task.name} --by <other-id> -w ${workstream}`,
    },
    opts.triage === true
      ? { intent: "Accept it as work", command: `mu task accept ${task.name} -w ${workstream}` }
      : {
          intent: "Claim and start",
          command: `mu task claim ${task.name} -w ${workstream} --self  (or --for <worker>)`,
        },
  ];
  if (opts.json) {
    // JSON callers are scripts: stay machine-readable. The human
    // stderr hint is suppressed under --json (matches every other
    // prose surface in the CLI). The truncation signal still has to
    // reach scripted callers, though — otherwise pipelines that
    // build follow-up commands from the JSON envelope can't tell the
    // id no longer carries the title's full meaning. Surface it as
    // top-level `truncated`/`originalSlug` siblings of `task` (NOT
    // inside `task`, which mirrors the persisted row).
    // Conventions, consistent with the audit_json_envelope_uniformity
    // singleton style: only emit when meaningful. Both fields are
    // omitted when the operator passed an explicit <id> (no
    // auto-derive) and when auto-derivation produced no truncation
    // (task_add_slugify_silently_truncates_ids).
    const truncationFields =
      autoDerived && derivation.truncated
        ? { truncated: true, originalSlug: derivation.originalSlug }
        : {};
    emitJson({
      task: withRoiAll([task])[0],
      ...(tasks.length > 1 ? { tasks: withRoiAll(tasks) } : {}),
      blockers: blockedBy,
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(note !== null ? { note } : {}),
      nextSteps,
      ...truncationFields,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
    return;
  }
  // Stderr hint when auto-id derivation truncated the slug. Stderr +
  // exit 0 so scripts that already pipe stdout aren't disturbed; the
  // operator sees the heads-up that the id no longer carries the full
  // title's meaning, with a one-paste fix (pass <id> positional).
  // Suppressed when the operator passed an explicit id (truncated is
  // false in that branch) since they already chose the id by hand.
  derivations.forEach((d, i) => {
    if (!d.truncated) return;
    process.stderr.write(
      `hint: id '${tasks[i]?.name}' truncated from a longer slug; pass <id> positional to override (mu task add <id> --title ... ).\n`,
    );
  });
  const idHint = autoDerived ? pc.dim(" (id derived from title)") : "";
  for (const t of tasks) {
    console.log(
      `Added task ${pc.bold(t.name)}${idHint} ${pc.dim(
        `(workstream=${workstream}, impact=${t.impact}, effort=${t.effortDays})`,
      )}`,
    );
  }
  if (note !== null) {
    console.log(
      pc.dim(`  initial note: ${note.content.length} chars by ${note.author ?? "<orchestrator>"}`),
    );
  }
  if (hasBlockers) console.log(pc.dim(`  blocked by: ${blockedBy.join(", ")}`));
  if (blocks.length > 0) console.log(pc.dim(`  blocks: ${blocks.join(", ")}`));
  printNextSteps(nextSteps);
}

/** Reconcile `mu task note <id> [text]`'s positional text with its flag
 *  aliases (`-m/--message`, `--note`, `--text`): exactly one source.
 *
 *  dogfood-note-arg-shape: `mu task add --note <text>` is a FLAG, so the
 *  flag form is what operators and models reach for on `mu task note`. */
export function resolveNoteText(
  positional: string | undefined,
  flags: Readonly<Record<string, string | undefined>>,
): string {
  const given: [string, string][] = [];
  if (positional !== undefined) given.push(["the positional text", positional]);
  for (const [name, value] of Object.entries(flags)) {
    if (value !== undefined) given.push([name, value]);
  }
  if (given.length > 1) {
    throw new UsageError(
      `note text given twice (${given.map(([n]) => n).join(" and ")}): pass it once, positionally or via -m/--message/--note/--text`,
    );
  }
  const text = given[0]?.[1];
  if (text === undefined) {
    throw new UsageError(
      'note text required: mu task note <id> "..." (or -m/--message/--note/--text "...")',
    );
  }
  return text;
}

export async function cmdTaskNote(
  db: Db,
  rawId: string,
  content: string,
  opts: {
    workstream?: string;
    json?: boolean;
    author?: string;
    report?: boolean;
    kind?: NoteKind;
  } = {},
): Promise<void> {
  if (opts.report === true && opts.kind !== undefined) {
    throw new UsageError("--report and --kind both set the note kind: pass one", {
      showHelp: false,
    });
  }
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  // Author resolution: explicit --author wins; otherwise consult
  // MU_AGENT_NAME (env var injected at spawn) > $USER >
  // 'orchestrator'. Surfaced from mufeedback note #176: notes from
  // spawned agents were appearing as <orchestrator> because the CLI
  // wasn't propagating identity. After this fix, mu-spawned workers'
  // notes are correctly attributed to the agent name.
  const author = opts.author ?? (await resolveActorIdentity());
  const text = content === STDIN_ARG ? await readStdinText("note text") : unescapeNoteText(content);
  const warnings = suspiciousNoteWarnings(text);
  emitWarnings(warnings, opts.json);
  const kind: NoteKind = opts.report === true ? "report" : (opts.kind ?? "note");
  const note = addNote(db, localId, text, { author, workstream: ws, kind });
  const nextSteps: NextStep[] = [
    { intent: "Show all notes on this task", command: `mu task notes ${localId} -w ${ws}` },
    { intent: "Show full task state", command: `mu task show ${localId} -w ${ws}` },
  ];
  // A worker reads notes at dispatch, not while it runs: a note on its
  // IN_PROGRESS task reaches it only through a send.
  const task = getTask(db, localId, ws);
  const owner = task?.status === "IN_PROGRESS" ? task.ownerName : null;
  if (owner !== null && owner !== author) {
    nextSteps.unshift({
      intent: `${owner} will not see this note: send it (--steer, or --interrupt if the note makes the current work wasted)`,
      command: `mu agent send ${owner} -w ${ws} --steer "..."`,
    });
  }
  if (opts.json) {
    emitJson({
      taskName: localId,
      note,
      nextSteps,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
    return;
  }
  console.log(pc.dim(`note appended to ${localId}`));
  printNextSteps(nextSteps);
}

export async function cmdTaskShow(
  db: Db,
  rawId: string,
  opts: { json?: boolean; workstream?: string; note?: number } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  // v5: tasks.local_id is per-workstream unique. Resolve the
  // operator's workstream up front so the lookup scopes correctly.
  const ws = await resolveWorkstream(opts.workstream);
  const task = getTask(db, localId, ws);
  if (!task) throw new TaskNotFoundError(localId, ws);
  const edges = getTaskEdgesWithStatus(db, localId, task.workstreamName);
  const view =
    opts.note !== undefined
      ? null
      : selectTaskNotes(db, localId, { workstream: task.workstreamName });
  if (opts.note !== undefined) {
    // One note, whole: no cap, exact membership of this task's own notes.
    const note = getTaskNote(db, localId, task.workstreamName, opts.note);
    if (opts.json) {
      emitJson({
        n: note.n,
        kind: note.kind,
        author: note.author,
        created_at: note.createdAt,
        content: note.content,
      });
      return;
    }
    console.log(noteRecord(note));
    return;
  }
  const page = buildNotesPage(localId, task.workstreamName, view?.notes ?? [], {
    pinned: new Set(view?.pinned ?? []),
    total: view?.total ?? 0,
    fill: "newest",
    explicit: false,
    json: opts.json === true,
    wrap: (items, fields) => ({ notes: items, ...prefixed(fields, "notes_") }),
  });

  // When owner IS NULL but the task is IN_PROGRESS (or recently was),
  // the actor is in agent_logs. Surface it so 'who's working on this'
  // is answerable from `mu task show` alone.
  const lastActor =
    task.ownerName === null && task.status !== "OPEN"
      ? lastClaimActor(db, task.workstreamName, task.name)
      : null;

  if (opts.json) {
    // JSON shape: blockers/dependents are arrays of {name, status}
    // objects so scripts can filter by status without a second query.
    // (task_show_blocked_by_renders_closed: prior shape was bare
    // string[], which discarded the gating-vs-satisfied distinction.)
    emitJson({
      task: {
        ...withRoiAll([task])[0],
        revision: taskRevision(db, task.workstreamName, task.name),
      },
      blockers: edges.blockers,
      dependents: edges.dependents,
      notes: page.items,
      ...pageFields(page, "notes_"),
      lastClaimActor: lastActor,
    });
    return;
  }

  const roi = task.effortDays > 0 ? (task.impact / task.effortDays).toFixed(1) : "∞";
  console.log(pc.bold(`${task.name}  —  ${task.title}`));
  console.log(`  workstream : ${task.workstreamName}`);
  console.log(`  status     : ${colorPair(task)}`);
  // owner: registered worker name, or '(self: <actor>)' for an anonymous
  // claim, or '(unowned)' for OPEN tasks.
  const ownerLine =
    task.ownerName !== null
      ? task.ownerName
      : lastActor !== null
        ? pc.dim(`(self: ${lastActor})`)
        : pc.dim("(unowned)");
  console.log(`  owner      : ${ownerLine}`);
  console.log(`  impact     : ${task.impact}`);
  console.log(`  effort     : ${task.effortDays}  ${pc.dim(`(ROI ${roi})`)}`);
  console.log(`  created    : ${pc.dim(task.createdAt)}`);
  console.log(`  updated    : ${pc.dim(task.updatedAt)}`);
  console.log(`  rev        : ${pc.dim(String(taskRevision(db, task.workstreamName, task.name)))}`);

  console.log("");
  console.log(pc.bold("Edges"));
  // Group each side of the edge set by status so the operator can
  // tell at a glance which prerequisites still gate the task vs which
  // have already been satisfied. CLOSED is the only status that
  // satisfies a `blocks` edge; OPEN/IN_PROGRESS stay in the
  // still-gating bucket. (task_show_blocked_by_renders_closed.)
  const { stillGating: gatingBlockers, satisfied: satisfiedBlockers } = partitionEdges(
    edges.blockers,
  );
  const { stillGating: openDependents, satisfied: closedDependents } = partitionEdges(
    edges.dependents,
  );
  console.log(`  blocked by : ${formatEdgeList(gatingBlockers, false)}`);
  if (satisfiedBlockers.length > 0) {
    console.log(`  satisfied  : ${formatEdgeList(satisfiedBlockers, true)}`);
  }
  console.log(`  blocks     : ${formatEdgeList(openDependents, false)}`);
  if (closedDependents.length > 0) {
    console.log(`  no longer  : ${formatEdgeList(closedDependents, true)}`);
  }

  console.log("");
  console.log(pc.bold(`Notes (${view?.total ?? 0})`));
  if ((view?.total ?? 0) === 0) {
    console.log(pc.dim("  (no notes)"));
  } else {
    for (const line of page.lines) console.log(line);
  }
  // Only the non-default substates get a hint: they are the ones whose
  // way out is not obvious from the status alone.
  const ref = `${task.name} -w ${task.workstreamName}`;
  if (task.substate === "parked") {
    console.log("");
    printNextSteps([{ intent: "Return it to next", command: `mu task unpark ${ref}` }]);
  } else if (task.substate === "triage") {
    console.log("");
    printNextSteps([
      { intent: "Accept it as work", command: `mu task accept ${ref}` },
      { intent: "Decline it", command: `mu task close ${ref} --as rejected --why "<reason>"` },
    ]);
  } else if (task.status === "CLOSED" && task.substate !== "done") {
    console.log("");
    printNextSteps([{ intent: "Reopen it", command: `mu task open ${ref}` }]);
  }
}

export async function cmdTaskNotes(
  db: Db,
  rawId: string,
  opts: {
    json?: boolean;
    workstream?: string;
    tail?: number;
    since?: string;
    sinceClaim?: boolean;
    all?: boolean;
    from?: number;
  } = {},
): Promise<void> {
  const filtered = opts.tail !== undefined || opts.since !== undefined || opts.sinceClaim === true;
  if ((opts.all === true || opts.from !== undefined) && filtered) {
    throw new UsageError(
      "--all/--from pick a page of the whole history; they do not combine with --tail/--since/--since-claim",
    );
  }
  if (opts.all === true && opts.from !== undefined) {
    throw new UsageError("--all is --from 1; pass one of them");
  }
  // Mutex: --since and --since-claim both define a cutoff; allowing
  // both would force one to silently win, which is a footgun. The SDK
  // documents "since wins" for safety, but the CLI is strict so the
  // user gets feedback at the surface they typed at. (Mirrors the
  // pattern in cmdTaskUpdate where conflicting fields error rather
  // than picking one.)
  if (opts.since !== undefined && opts.sinceClaim === true) {
    throw new UsageError(
      "--since and --since-claim are mutually exclusive (both define a cutoff); pick one",
    );
  }
  // --tail must be a positive integer. The commander parser
  // (parsePositiveNumber) already rejects 0 and negatives at the
  // parse layer, but defend here too in case a programmatic caller
  // pokes a bad value through (the SDK accepts >=0 by design).
  if (
    opts.tail !== undefined &&
    (!Number.isFinite(opts.tail) || opts.tail <= 0 || !Number.isInteger(opts.tail))
  ) {
    throw new UsageError(`--tail must be a positive integer (got ${JSON.stringify(opts.tail)})`);
  }
  // --since must parse as ISO 8601. We accept anything Date.parse
  // recognises (so '2025-01-01' and full RFC3339 both work) but
  // reject typos that produce NaN (e.g. 'yesterday', 'last week').
  if (opts.since !== undefined) {
    const parsed = Date.parse(opts.since);
    if (Number.isNaN(parsed)) {
      throw new UsageError(
        `--since must be an ISO 8601 timestamp (got ${JSON.stringify(opts.since)})`,
      );
    }
  }
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const task = getTask(db, localId, ws);
  if (!task) throw new TaskNotFoundError(localId, ws);
  let page: NotesPage;
  let total: number;
  const notesWire = {
    json: opts.json === true,
    wrap: (items: Record<string, unknown>[], fields: Record<string, unknown>) => ({
      items,
      count: items.length,
      ...fields,
    }),
  };
  if (opts.all === true || opts.from !== undefined) {
    const sel = selectTaskNotes(db, localId, {
      workstream: task.workstreamName,
      ...(opts.all === true ? { all: true } : {}),
      ...(opts.from !== undefined ? { from: opts.from } : {}),
    });
    total = sel.total;
    page = buildNotesPage(localId, task.workstreamName, sel.notes, {
      pinned: new Set(sel.pinned),
      total,
      fill: "page",
      explicit: true,
      ...notesWire,
    });
  } else if (filtered) {
    const filterOpts: { tail?: number; since?: string; sinceClaim?: boolean } = {};
    if (opts.tail !== undefined) filterOpts.tail = opts.tail;
    if (opts.since !== undefined) filterOpts.since = opts.since;
    if (opts.sinceClaim === true) filterOpts.sinceClaim = true;
    const notes = listNotes(db, localId, task.workstreamName, filterOpts);
    total = notes.length;
    page = buildNotesPage(localId, task.workstreamName, notes, {
      pinned: new Set(notes.filter((n) => PINNED_KINDS.has(n.kind)).map((n) => n.n)),
      total,
      fill: "page",
      explicit: true,
      ...notesWire,
    });
  } else {
    const sel = selectTaskNotes(db, localId, { workstream: task.workstreamName });
    total = sel.total;
    page = buildNotesPage(localId, task.workstreamName, sel.notes, {
      pinned: new Set(sel.pinned),
      total,
      fill: "newest",
      explicit: false,
      ...notesWire,
    });
  }
  if (opts.json) {
    emitJson({ items: page.items, count: page.items.length, ...pageFields(page) });
    return;
  }
  if (total === 0) {
    console.log(pc.dim(`(no notes on ${localId})`));
    return;
  }
  for (const line of page.lines) console.log(line);
}

export async function cmdTaskUpdate(
  db: Db,
  rawId: string,
  opts: {
    title?: string;
    impact?: number;
    effortDays?: number;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const updateOpts: UpdateTaskOptions = {};
  if (opts.title !== undefined) updateOpts.title = opts.title;
  if (opts.impact !== undefined) updateOpts.impact = opts.impact;
  if (opts.effortDays !== undefined) updateOpts.effortDays = opts.effortDays;
  if (Object.keys(updateOpts).length === 0) {
    throw new UsageError(
      "nothing to update; pass at least one of --title, --impact, --effort-days",
    );
  }
  const r = updateTask(db, localId, updateOpts, { workstream: ws });
  const nextSteps: NextStep[] = [
    { intent: "Show updated task", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.updated) {
    console.log(pc.dim(`${localId}: no fields differ from current (no-op)`));
    return;
  }
  console.log(`Updated ${pc.bold(localId)} ${pc.dim(`(${r.changedFields.join(", ")})`)}`);
  printNextSteps(nextSteps);
}
