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
  emitJson,
  parseCsvFlag,
  resolveEntityRef,
  resolveExistingWorkstream,
  UsageError,
} from "../../cli.js";
import type { Db, NoteKind } from "../../db.js";
import { lastClaimActor } from "../../logs.js";
import { say } from "../../messages.js";
import { pc } from "../../output.js";
import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../../output-contract.js";
import { taskRevision } from "../../revision.js";
import { shellWord } from "../../shell-quote.js";
import { formatPair, type TaskStatus, type TaskSubstate } from "../../tasks/status.js";
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
import {
  escapeRecordText,
  footerLine,
  linesBytes,
  SHOW_TITLE_CHARS,
  taskItemCut,
  taskRecordCut,
  taskToOutput,
} from "./records.js";

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
  /** Emitted bytes of the whole output as measured for the cap (pinned notes exempt). */
  size: number;
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
    /** Text lines printed BEFORE the notes that count toward the cap (the `show` task and edge records). */
    fixedLines?: readonly string[];
    /** Text lines printed after the notes that count toward the cap (hints). */
    tailLines?: readonly string[];
    /** The cap on the whole output (default RESULT_BYTES). */
    budget?: number;
    /** The one way back a `more=` names (default: `task notes --all` / `--from`). */
    next?: string;
    /** The text footer, given the notes left out (`show` adds its edges and cuts); default `more=N next=…`. */
    footer?: (notesMore: number) => string | null;
    /** May the cap drop every ordinary note (`show`: the task and edges come first)? Default: the last one stays. */
    allowEmpty?: boolean;
  },
): NotesPage {
  const budget = opts.budget ?? RESULT_BYTES;
  const ref = `${taskId} -w ${ws}`;
  const nextFor = (first: number): string =>
    opts.next !== undefined
      ? opts.next
      : first === 1
        ? `mu task notes ${ref} --all`
        : `mu task notes ${ref} --from ${first}`;
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
  const footLine = (more: number, next: string | null): string | null =>
    opts.footer !== undefined
      ? opts.footer(more)
      : next === null
        ? null
        : `more=${more} next=${next}`;
  const render = (shown: readonly ShownNote[]): NotesPage => {
    const { more, next } = omission(shown);
    const lines = shown.map((s) => noteLine(ref, s));
    const foot = footLine(more, next);
    if (foot !== null) lines.push(foot);
    return { items: shown.map((s) => noteItem(ref, s)), lines, more, next, size: emitted(shown) };
  };
  // The cap, measured on the FINAL output (every metadata field as emitted),
  // pinned records set aside. Exact, not predicted: serialize, then shrink.
  const emitted = (shown: readonly ShownNote[]): number => {
    const { more, next } = omission(shown);
    const ordinary = shown.filter((s) => !isPinned(s));
    if (!opts.json) {
      const lines = [...(opts.fixedLines ?? []), ...ordinary.map((s) => noteLine(ref, s))];
      const foot = footLine(more, next);
      if (foot !== null) lines.push(foot);
      lines.push(...(opts.tailLines ?? []));
      return Buffer.byteLength(lines.join("\n")) + 1;
    }
    const fields = next === null ? { more: 0 } : { more, retrieve: next };
    const items = ordinary.map((s) => noteItem(ref, s));
    return Buffer.byteLength(encodeEnvelope(okEnvelope(opts.wrap(items, fields)))) + 1;
  };
  // The planner's probes are the same serialization, not an estimate: the
  // pinned notes are always shown, so a probe is pinned plus the ordinary run.
  const plan = planNotes(
    notes,
    opts.pinned,
    opts.fill,
    (ordinary) => emitted([...pinnedShown, ...ordinary]),
    { budget },
  );
  const final = [...plan.shown];
  // Drop the oldest ordinary note (default view) or the last (a page, so what
  // is left out stays a suffix `--from` reaches). The last one stays: a page
  // makes progress, and a stub is bounded.
  while (emitted(final) > budget) {
    const ordinary = final.filter((s) => !isPinned(s));
    const victim = opts.fill === "newest" ? ordinary[0] : ordinary[ordinary.length - 1];
    if (ordinary.length <= (opts.allowEmpty === true ? 0 : 1) || victim === undefined) break;
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
  const workstream = await resolveExistingWorkstream(db, opts.workstream);
  const titles = opts.title;
  if (localIds.length > 0 && titles.length !== localIds.length) {
    // A stray word is nearly always an apostrophe that ended '...' early
    // (the commander "too many arguments" case this used to be).
    throw new UsageError(say("task.add_titles", localIds, titles.length), { showHelp: false });
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
  if (task === undefined) throw new UsageError(say("task.add_nothing"), { showHelp: true });
  const note = noteText !== undefined ? (listNotes(db, task.name, workstream)[0] ?? null) : null;
  const derivation = derivations[0] ?? { id: task.name, truncated: false, originalSlug: task.name };
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
      // The SQL-column record every task read prints (records.ts), never the SDK row.
      task: taskToOutput(task),
      ...(tasks.length > 1 ? { tasks: tasks.map((t) => taskToOutput(t)) } : {}),
      blockers: blockedBy,
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(note !== null ? { note } : {}),
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
    process.stderr.write(say("task.add_truncated", tasks[i]?.name ?? ""));
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
      say(
        "task.note_twice",
        given.map(([n]) => n),
      ),
    );
  }
  const text = given[0]?.[1];
  if (text === undefined) {
    throw new UsageError(say("task.note_required"), { showHelp: false });
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
    throw new UsageError(say("task.note_kind_twice"), { showHelp: false });
  }
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  // Author resolution: explicit --author wins; otherwise consult
  // MU_AGENT_NAME (env var injected at spawn) > $USER >
  // 'orchestrator'. Surfaced from mufeedback note #176: notes from
  // spawned agents were appearing as <orchestrator> because the CLI
  // wasn't propagating identity. After this fix, mu-spawned workers'
  // notes are correctly attributed to the agent name.
  const author = opts.author ?? (await resolveActorIdentity());
  const text = content === STDIN_ARG ? await readStdinText("note text") : unescapeNoteText(content);
  const warnings = suspiciousNoteWarnings(text);
  const kind: NoteKind = opts.report === true ? "report" : (opts.kind ?? "note");
  const note = addNote(db, localId, text, { author, workstream: ws, kind });
  // A worker reads notes at dispatch, not while it runs: a note on its
  // IN_PROGRESS task reaches it only through a send.
  const task = getTask(db, localId, ws);
  const owner = task?.status === "IN_PROGRESS" ? task.ownerName : null;
  if (owner !== null && owner !== author) {
    warnings.push(say("task.note_unseen", owner, ws));
  }
  emitWarnings(warnings, opts.json);
  if (opts.json) {
    emitJson({
      taskName: localId,
      note,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
    return;
  }
  console.log(pc.dim(`note appended to ${localId}`));
}

/** Bytes the edge records of one `show` may take before the notes get their share of the 4 KB. */
const EDGE_BYTES = 1200;
/** Title bounds `show` tries, widest first, when even the task alone does not fit. */
const SHOW_TITLE_STEPS = [SHOW_TITLE_CHARS, 300, 150, 75, 30];

/** One neighbour of a task, in the order `show` lists them: blockers then dependents, still-gating first. */
interface EdgeRecord {
  kind: "blocker" | "dependent";
  id: string;
  status: string;
  substate: string;
}

function edgeRecords(edges: {
  blockers: readonly TaskEdgeWithStatus[];
  dependents: readonly TaskEdgeWithStatus[];
}): EdgeRecord[] {
  const side = (kind: EdgeRecord["kind"], list: readonly TaskEdgeWithStatus[]): EdgeRecord[] => {
    const { stillGating, satisfied } = partitionEdges(list);
    return [...stillGating, ...satisfied].map((e) => ({
      kind,
      id: e.name,
      status: e.status,
      substate: e.substate,
    }));
  };
  return [...side("blocker", edges.blockers), ...side("dependent", edges.dependents)];
}

const edgeLine = (e: EdgeRecord): string =>
  [
    e.kind,
    escapeRecordText(e.id),
    formatPair({ status: e.status as TaskStatus, substate: e.substate as TaskSubstate }),
  ].join("\t");
const edgeItem = (e: EdgeRecord): Record<string, unknown> => ({
  id: e.id,
  status: e.status,
  substate: e.substate,
});

export async function cmdTaskShow(
  db: Db,
  rawId: string,
  opts: { json?: boolean; workstream?: string; note?: number; all?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  // v5: tasks.local_id is per-workstream unique. Resolve the
  // operator's workstream up front so the lookup scopes correctly.
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const task = getTask(db, localId, ws);
  if (!task) throw new TaskNotFoundError(localId, ws);
  const json = opts.json === true;
  const whole = opts.all === true;
  const ref = `${shellWord(task.name)} -w ${shellWord(task.workstreamName)}`;
  const edges = edgeRecords(getTaskEdgesWithStatus(db, localId, task.workstreamName));
  if (opts.note !== undefined) {
    // One note, whole: no cap, exact membership of this task's own notes.
    const note = getTaskNote(db, localId, task.workstreamName, opts.note);
    if (json) {
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
  // The ONE way back from a cut: this same read with --all (uncapped).
  const allCmd = `mu task show ${ref} ${json ? "--json " : ""}--all`;
  const view = whole
    ? selectTaskNotes(db, localId, { workstream: task.workstreamName, all: true })
    : selectTaskNotes(db, localId, { workstream: task.workstreamName });

  // When owner IS NULL but the task is IN_PROGRESS (or recently was),
  // the actor is in the ops log (ops.actor). Surface it so 'who's working on this'
  // is answerable from `mu task show` alone.
  const lastActor =
    task.ownerName === null && task.status !== "OPEN"
      ? lastClaimActor(db, task.workstreamName, task.name)
      : null;
  const lastActorShown =
    lastActor === null || whole ? lastActor : [...lastActor].slice(0, 80).join("");
  const actorCut =
    lastActor === null ? 0 : [...lastActor].length - [...(lastActorShown ?? "")].length;
  const revision = taskRevision(db, task.workstreamName, task.name);

  // Only the non-default substates get a hint: they are the ones whose
  // way out is not obvious from the status alone. Executable as printed (no placeholder).
  const hints: string[] = [];
  if (task.substate === "parked" && task.kind !== "human") hints.push(`next=mu task unpark ${ref}`);
  else if (task.substate === "triage") {
    hints.push(`next=mu task accept ${ref}`);
  } else if (task.status === "CLOSED" && task.substate !== "done") {
    hints.push(`next=mu task open ${ref}`);
  }

  /** The whole output for `k` neighbours and a title of `titleChars`, serialized: its lines, JSON data and emitted bytes. */
  const build = (k: number, titleChars: number) => {
    const shownEdges = edges.slice(0, k);
    const more = edges.length - k;
    const rec = taskRecordCut(task, {
      withWorkstream: true,
      revision,
      claimedBy: lastActor,
      times: true,
      whole,
      titleChars,
      maxChars: titleChars + 400,
    });
    const itm = taskItemCut(task, {
      withWorkstream: true,
      revision,
      whole,
      titleChars,
      extraCut: actorCut,
    });
    const fixedLines = [rec.line, ...shownEdges.map(edgeLine)];
    // One footer, last: everything cut (neighbours, notes, clipped fields) and the one way back.
    const footer = (notesMore: number): string | null =>
      footerLine({ more: more + notesMore, cut: rec.cut }, allCmd);
    const wrap = (items: Record<string, unknown>[], fields: Record<string, unknown>) => {
      const notesMore = Number(fields.more ?? 0);
      return {
        task: itm.item,
        blockers: shownEdges.filter((e) => e.kind === "blocker").map(edgeItem),
        dependents: shownEdges.filter((e) => e.kind === "dependent").map(edgeItem),
        edges_more: more,
        notes: items,
        notes_more: notesMore,
        ...(itm.cut > 0 ? { cut: itm.cut } : {}),
        ...(more + notesMore > 0 || itm.cut > 0 ? { retrieve: allCmd } : {}),
        lastClaimActor: lastActorShown,
      };
    };
    const page = buildNotesPage(localId, task.workstreamName, view.notes, {
      pinned: new Set(view.pinned),
      total: view.total,
      fill: whole ? "page" : "newest",
      explicit: whole,
      json,
      wrap,
      fixedLines,
      tailLines: hints,
      next: allCmd,
      footer,
      allowEmpty: true,
      ...(whole ? { budget: Number.POSITIVE_INFINITY } : {}),
    });
    return { page, fixedLines, wrap };
  };
  // The cap is on the FINAL bytes (task, edges, footer, notes; pinned notes exempt): shrink by
  // whole records. Neighbours first (at most their EDGE_BYTES share, then as few as the notes
  // leave room for), the title only when the task alone does not fit.
  let kMax = edges.length;
  if (!whole) {
    const edgeBytes = (k: number): number =>
      json
        ? Buffer.byteLength(JSON.stringify(edges.slice(0, k).map(edgeItem)))
        : linesBytes(edges.slice(0, k).map(edgeLine));
    kMax = 0;
    while (kMax < edges.length && edgeBytes(kMax + 1) <= EDGE_BYTES) kMax++;
  }
  const fits = (k: number, t: number): boolean => whole || build(k, t).page.size <= RESULT_BYTES;
  let out = build(kMax, SHOW_TITLE_CHARS);
  if (!fits(kMax, SHOW_TITLE_CHARS)) {
    let lo = 0;
    let hi = kMax;
    let titleChars = SHOW_TITLE_CHARS;
    if (!fits(0, titleChars)) {
      titleChars = SHOW_TITLE_STEPS.find((t) => fits(0, t)) ?? 30;
      hi = 0;
    } else {
      // Largest k in [0, kMax) that fits (fewer neighbours never need more room).
      hi = kMax - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(mid, titleChars)) lo = mid;
        else hi = mid - 1;
      }
      hi = lo;
    }
    out = build(hi, titleChars);
  }
  const { page, fixedLines, wrap } = out;

  if (json) {
    emitJson(wrap(page.items, { more: page.more }));
    return;
  }
  // Notes keep their own records; an empty view prints none (the task record says nothing of them).
  console.log([...fixedLines, ...page.lines, ...hints].join("\n"));
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
    throw new UsageError(say("task.notes_all_from"));
  }
  if (opts.all === true && opts.from !== undefined) {
    throw new UsageError(say("task.notes_all_is_from"));
  }
  // Mutex: --since and --since-claim both define a cutoff; allowing
  // both would force one to silently win, which is a footgun. The SDK
  // documents "since wins" for safety, but the CLI is strict so the
  // user gets feedback at the surface they typed at. (Mirrors the
  // pattern in cmdTaskUpdate where conflicting fields error rather
  // than picking one.)
  if (opts.since !== undefined && opts.sinceClaim === true) {
    throw new UsageError(say("task.notes_since_twice"));
  }
  // --tail must be a positive integer. The commander parser
  // (parsePositiveNumber) already rejects 0 and negatives at the
  // parse layer, but defend here too in case a programmatic caller
  // pokes a bad value through (the SDK accepts >=0 by design).
  if (
    opts.tail !== undefined &&
    (!Number.isFinite(opts.tail) || opts.tail <= 0 || !Number.isInteger(opts.tail))
  ) {
    throw new UsageError(say("task.notes_tail", opts.tail));
  }
  // --since must parse as ISO 8601. We accept anything Date.parse
  // recognises (so '2025-01-01' and full RFC3339 both work) but
  // reject typos that produce NaN (e.g. 'yesterday', 'last week').
  if (opts.since !== undefined) {
    const parsed = Date.parse(opts.since);
    if (Number.isNaN(parsed)) {
      throw new UsageError(say("task.notes_since", opts.since));
    }
  }
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveExistingWorkstream(db, opts.workstream);
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
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const updateOpts: UpdateTaskOptions = {};
  if (opts.title !== undefined) updateOpts.title = opts.title;
  if (opts.impact !== undefined) updateOpts.impact = opts.impact;
  if (opts.effortDays !== undefined) updateOpts.effortDays = opts.effortDays;
  if (Object.keys(updateOpts).length === 0) {
    throw new UsageError(say("task.update_nothing"), { showHelp: false });
  }
  const r = updateTask(db, localId, updateOpts, { workstream: ws });
  if (opts.json) {
    emitJson({ taskName: localId, ...r });
    return;
  }
  if (!r.updated) {
    console.log(pc.dim(`${localId}: no fields differ from current (no-op)`));
    return;
  }
  console.log(`Updated ${pc.bold(localId)} ${pc.dim(`(${r.changedFields.join(", ")})`)}`);
}
