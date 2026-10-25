// mu — the CLOSE block of a settled pi run: parse it, apply it once.
//
// A pi worker ends its final message with
//
//   CLOSE: task=<id> evidence="<command + result>"
//   REPORT:
//   <report, any number of lines>
//
// `applySettledClose` reads that block from the run's authoritative ctl
// `lastText` (never the pane) and, when `task=` is a task the agent owns,
// writes the report note, the close note and the status flip in ONE op
// group, once per (agent, incarnation, runs). Everything else is ignored
// or recorded as "no close (malformed)": the block never closes by guess.
//
// Grammar (the only definition; the README names the shape, not the escapes):
//   - The CLOSE block is recognised ONLY as the literal final block of the
//     message. Trailing blank lines are dropped; the report is everything
//     after the `REPORT:` line to there, byte for byte (leading blank lines,
//     indentation, CRLF and all). Nothing else is normalized.
//   - Fence state (``` / ~~~, CommonMark open/close rules) is tracked over
//     the WHOLE message. An unclosed fence quotes the rest of it, so a message
//     that ends inside a fence has no block at all. A line
//     inside a fence (or a fence line) is never a block line.
//   - A block starts at a line at column 0, outside any fence, that begins
//     `CLOSE:` and is followed at once by a line that is exactly `REPORT:`.
//     The FINAL such start is the block; earlier ones are ignored.
//   - If the last non-blank line is itself such a `CLOSE:` line (outside a
//     fence), the final block is malformed, whatever precedes it: no
//     fallback to an earlier block.
//   - Header: `CLOSE: task=<id> evidence="<text>"`. <id> is a task id.
//     Inside the quotes `\"`, `\\` and `\n` are escapes; any other
//     backslash is literal; a bare `"` ends the evidence and so must be
//     the last character of the line, or the block is malformed.
//   - Malformed: bad header, invalid id, empty evidence, blank report, or a
//     final `CLOSE:` line with no `REPORT:` after it.
//   - The template line `CLOSE: task=<id> ...` is a quoted contract: not a
//     start.

import type { Db } from "./db.js";
import { withOpContext } from "./op-context.js";
import { addNote } from "./tasks/edit.js";
import { isValidTaskId } from "./tasks/id.js";
import { closeTask } from "./tasks/lifecycle.js";

export type CloseBlock =
  | { kind: "valid"; task: string; evidence: string; report: string }
  | { kind: "malformed" }
  | { kind: "none" };

const HEADER = /^CLOSE:[ \t]+task=(\S+)[ \t]+evidence="/;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Per line: true when it is a fence line or sits inside a fence. */
function quotedLines(lines: string[]): { quoted: boolean[]; unclosed: boolean } {
  const quoted: boolean[] = [];
  let open: { ch: string; len: number } | undefined;
  for (const line of lines) {
    if (open) {
      quoted.push(true);
      const c = FENCE_CLOSE.exec(line);
      const run = c?.[1] ?? "";
      if (run[0] === open.ch && run.length >= open.len) open = undefined;
      continue;
    }
    const o = FENCE_OPEN.exec(line);
    const run = o?.[1] ?? "";
    if (o && !(run[0] === "`" && (o[2] ?? "").includes("`"))) {
      open = { ch: run[0] as string, len: run.length };
      quoted.push(true);
    } else {
      quoted.push(false);
    }
  }
  return { quoted, unclosed: open !== undefined };
}

const isStart = (line: string): boolean =>
  line.startsWith("CLOSE:") && !/^CLOSE:[ \t]+task=<[^>\s]*>/.test(line);

/** Parse the CLOSE block at the tail of a settled run's final message. */
export function parseCloseBlock(text: string): CloseBlock {
  if (text.trim() === "") return { kind: "none" };
  // Only the trailing blank lines go; the last content line keeps its bytes.
  const body = text.replace(/(?:\r?\n[ \t\r\f\v]*)+$/, "");
  const raw = body.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const l of raw) {
    offsets.push(at);
    at += l.length + 1;
  }
  const lines = raw.map((l) => l.replace(/\r$/, ""));
  const { quoted, unclosed } = quotedLines(lines);
  // A fence still open at the end quotes the tail: the message does not END
  // with a block, whatever block-looking lines sit before it.
  if (unclosed) return { kind: "none" };
  const last = lines.length - 1;
  if (!quoted[last] && isStart(lines[last] ?? "")) return { kind: "malformed" };
  let start = -1;
  for (let i = 0; i < last; i++) {
    if (quoted[i] || !isStart(lines[i] ?? "")) continue;
    if ((lines[i + 1] ?? "").trimEnd() === "REPORT:") start = i;
  }
  if (start < 0) return { kind: "none" };
  const header = (lines[start] ?? "").trimEnd();
  const m = HEADER.exec(header);
  if (!m) return { kind: "malformed" };
  const task = m[1] ?? "";
  if (!isValidTaskId(task)) return { kind: "malformed" };
  const evidence = unescapeEvidence(header.slice(m[0].length));
  if (evidence === undefined || evidence.trim() === "") return { kind: "malformed" };
  const report = body.slice(offsets[start + 2] ?? body.length);
  if (report.trim() === "") return { kind: "malformed" };
  return { kind: "valid", task, evidence, report };
}

/** `rest` is what follows the opening quote. Undefined unless it is the
 *  escaped text plus exactly one closing quote at the end. */
function unescapeEvidence(rest: string): string | undefined {
  if (!rest.endsWith('"')) return undefined;
  const body = rest.slice(0, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === '"') return undefined;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = body[i + 1];
    if (n === '"' || n === "\\") {
      out += n;
      i++;
    } else if (n === "n") {
      out += "\n";
      i++;
    } else {
      out += c;
    }
  }
  // A trailing lone backslash escaped the closing quote: unterminated.
  return /(?:^|[^\\])(?:\\\\)*\\$/.test(body) ? undefined : out;
}

export const CLOSE_MALFORMED = "no close (malformed)";
export const CLOSE_TRUNCATED =
  "CLOSE block not applied: the final message was truncated; close with mu task close";

export interface SettledCloseInput {
  /** The agent's workstream, and the workstream of the task it may close. */
  workstream: string;
  agent: string;
  agentId: number;
  incarnation: string;
  /** The settled run's count from ctl (not a wait baseline). */
  runs: number;
  lastText: string;
  /** Ctl `lastTextTruncated`: the head was cut, so the block cannot be trusted. */
  lastTextTruncated?: boolean;
  /** ctl `ended === "settled"`; a blocked or unknown observation is false. */
  settled: boolean;
  lastError?: string;
}

export interface SettledCloseResult {
  applied: boolean;
  task: string | null;
  reason: string;
}

const no = (reason: string, task: string | null = null): SettledCloseResult => ({
  applied: false,
  task,
  reason,
});

/**
 * Apply a settled pi run's CLOSE block exactly once. One transaction owns
 * the decision, the notes, the status flip and the replay row (inserted
 * last), so a refused or failed close leaves nothing and a retry is safe.
 * Guard errors (open blockers) propagate and roll everything back.
 */
export function applySettledClose(db: Db, input: SettledCloseInput): SettledCloseResult {
  if (!input.settled) return no("not settled");
  if (input.lastError !== undefined) return no("run ended on an error");
  return withOpContext(db, { intent: "close.apply", actor: input.agent, group: "new" }, () =>
    applyInTxn(db, input),
  );
}

function applyInTxn(db: Db, input: SettledCloseInput): SettledCloseResult {
  const agent = db
    .prepare(
      `SELECT a.cli FROM agents a JOIN workstreams w ON w.id = a.workstream_id
        WHERE a.id = ? AND a.name = ? AND w.name = ? AND w.torn_down_at IS NULL`,
    )
    .get(input.agentId, input.agent, input.workstream) as { cli: string } | undefined;
  if (!agent) return no("unknown agent");
  if (agent.cli !== "pi") return no("not a pi agent");
  const seen = db
    .prepare("SELECT 1 FROM agent_settles WHERE agent_id = ? AND incarnation = ? AND runs = ?")
    .get(input.agentId, input.incarnation, input.runs);
  if (seen) return no("already applied");
  const record = (taskId: number | null): void => {
    db.prepare(
      "INSERT INTO agent_settles (agent_id, incarnation, runs, task_id) VALUES (?, ?, ?, ?)",
    ).run(input.agentId, input.incarnation, input.runs, taskId);
  };
  const diagnose = (reason: string): SettledCloseResult => {
    const open = db
      .prepare(
        `SELECT t.local_id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
          WHERE t.owner_id = ? AND t.status = 'IN_PROGRESS' AND w.name = ?`,
      )
      .all(input.agentId, input.workstream) as { local_id: string }[];
    const only = open.length === 1 ? (open[0]?.local_id ?? null) : null;
    if (only !== null) {
      addNote(db, only, reason, {
        workstream: input.workstream,
        author: input.agent,
        group: "inherit",
      });
    }
    record(null);
    return no(reason, only);
  };
  if (input.lastTextTruncated === true) return diagnose(CLOSE_TRUNCATED);
  const block = parseCloseBlock(input.lastText);
  if (block.kind === "none") return no("no CLOSE block");
  if (block.kind === "malformed") return diagnose(CLOSE_MALFORMED);
  const task = db
    .prepare(
      `SELECT t.id, t.status, t.owner_id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = ? AND w.torn_down_at IS NULL AND t.local_id = ?`,
    )
    .get(input.workstream, block.task) as
    | { id: number; status: string; owner_id: number | null }
    | undefined;
  if (!task || task.owner_id !== input.agentId) {
    record(null);
    return no("task is not owned by this agent", block.task);
  }
  if (task.status === "CLOSED") {
    record(task.id);
    return no("task already closed", block.task);
  }
  closeTask(db, block.task, {
    workstream: input.workstream,
    evidence: block.evidence,
    report: block.report,
    author: input.agent,
    group: "inherit",
  });
  record(task.id);
  return { applied: true, task: block.task, reason: "closed" };
}
