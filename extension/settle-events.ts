/**
 * mu pi extension: what one keep-driving settle shows for the events its wait consumed
 * (extension/nudge.ts runs the wait; this file reads delegate rows and words the entry).
 *
 * The settle's wait is `mu wait --ready`: one result may carry several events (`data.events`,
 * the ready batch; else `firing`). Each consumed event gets a line, each delegate answer its
 * block. Delegates of a wave first run ONE loop of the same wait over the owed rows of every
 * wave in the batch, folding siblings in, so each wave is summarised once. Exactly-once: every
 * event a wait consumed is printed in this entry, and nothing it did not consume is shown as
 * delivered (a superseded result counts only what it marks delivered, src/wait-event-text.ts).
 */
import {
  consumedEvents,
  eventLine,
  owedLine,
  type Rec,
  recs,
  str,
} from "../src/wait-event-text.js";
import type { MuResult } from "./mu-run.js";

export type Envelope = { ok?: unknown; error?: unknown; data?: Record<string, unknown> };

export function envelopeOf(stdout: string): Envelope | undefined {
  try {
    const v = JSON.parse(stdout) as Envelope | null;
    return typeof v === "object" && v !== null && typeof v.ok === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** One answer's report in a settle entry is cut to this many characters (tail of the pointer kept). */
export const REPORT_CAP = 4000;
/** In a wave summary, or beside other answers, each answer shown in full is cut to this. */
export const WAVE_REPORT_CAP = 1500;
const PENDING_STATES = new Set(["queued", "starting", "running", "recording"]);

/** A superseded result that consumed nothing: shown, never continued, never waited again. */
export const SUPERSEDED_LINE =
  "[mu] settle: a newer mu wait of this session began; nothing was consumed here, that wait returns these events.";

/** A delegate call row as `mu delegates show|list --json` prints it (the fields read here). */
type CallRow = {
  callId: string;
  task: string;
  workstream: string;
  state: string;
  verdict?: string | null;
  error?: string | null;
  wave?: string | null;
  record?: { workstream?: string; task?: string } | null;
};
export type Run1 = (args: readonly string[]) => Promise<Envelope | undefined>;

const recordOf = (c: CallRow): string | undefined =>
  c.record?.workstream && c.record.task ? `${c.record.workstream}/${c.record.task}` : undefined;

/** The call's report note (its full answer), or undefined when unreadable. */
async function reportOf(mu: Run1, c: CallRow): Promise<string | undefined> {
  const v = await mu(["task", "notes", c.task, "-w", c.workstream, "--json"]);
  const items = (v?.ok === true ? v.data?.items : undefined) as
    | { kind?: string; content?: string }[]
    | undefined;
  return items?.filter((n) => n.kind === "report").at(-1)?.content;
}

/**
 * One answer as the model reads it: a header (call, task, state, verdict, record),
 * then the report capped to `cap` with the pointer to the whole of it. A recorded
 * check with a verdict is the header only: the verdict is on its task already.
 */
async function answerBlock(mu: Run1, c: CallRow, cap: number): Promise<string> {
  const where = recordOf(c);
  const notes = `mu task notes ${c.task} -w ${c.workstream}`;
  const head = [
    `Delegate answer: call ${c.callId}, task ${c.workstream}/${c.task}, ${c.state}`,
    c.verdict ? `, ${c.verdict}` : "",
    where ? `, recorded on ${where}` : "",
    c.error ? `. Error: ${c.error}` : "",
    ".",
  ].join("");
  if (where && c.verdict) return `${head} Full answer: ${notes}`;
  const text = await reportOf(mu, c);
  if (text === undefined) return `${head} Report unreadable here; read it: ${notes}`;
  const body =
    text.length > cap
      ? `${text.slice(0, cap)}\n[... ${text.length - cap} more characters: ${notes}]`
      : text;
  return `${head}\n${body}`;
}

const unreadable = (id: string): string =>
  `Delegate answer: call ${id}. Its row is unreadable here: mu delegates show ${id}`;

/** The ONE wave line: counts per verdict, then one line per call. */
function waveSummary(wave: string, rows: CallRow[]): string {
  const n = (p: (c: CallRow) => boolean) => rows.filter(p).length;
  const refused = rows.filter((c) => c.state === "refused");
  const counts = [
    `${n((c) => c.verdict === "CONFIRMED")}/${rows.length} CONFIRMED`,
    `${n((c) => c.verdict === "REFUTED")} REFUTED`,
    `${n((c) => c.state !== "refused" && !PENDING_STATES.has(c.state) && c.verdict !== "CONFIRMED" && c.verdict !== "REFUTED")} UNVERIFIED`,
    `${n((c) => PENDING_STATES.has(c.state))} pending`,
    `${refused.length} refused`,
  ].join(", ");
  const lines = rows.map(
    (c) =>
      `- ${recordOf(c) ?? `${c.workstream}/${c.task}`}: ${c.state === "refused" ? "REFUSED, reissue it: mu_delegate_reissue" : (c.verdict ?? c.state)} (call ${c.callId})`,
  );
  return [`Wave ${wave}: ${counts}.`, ...lines].join("\n");
}

/** A wait result's `notices` (one line each; `waitData` never cuts them). */
function noticesOf(d: Rec): string[] {
  return Array.isArray(d.notices)
    ? d.notices.filter((n): n is string => typeof n === "string")
    : [];
}

/** The call id of a `delegate:<id>` event, else undefined. */
function delegateIdOf(e: Rec): string | undefined {
  const ref = str(e.ref);
  return e.kind === "delegate" && ref?.startsWith("delegate:")
    ? ref.slice("delegate:".length)
    : undefined;
}

/**
 * The call ids of the delegate calls a wait result's snapshots still show (its owed picture), or
 * undefined when the result cut its snapshots (the picture is then unknown, not empty).
 */
function pictureOf(d: Rec): Set<string> | undefined {
  if (typeof d.snapshotsCut === "number" && d.snapshotsCut > 0) return undefined;
  return new Set(
    recs(d.snapshots).flatMap((s) => {
      const ref = str(s.ref);
      return ref?.startsWith("delegate:") ? [ref.slice("delegate:".length)] : [];
    }),
  );
}

/** What the settle needs from its host: the same wait again, one mu read, and cancellation. */
export interface SettleIo {
  wait: () => Promise<MuResult>;
  mu: Run1;
  aborted: () => boolean;
}

export interface SettleBody {
  /** The lines after the lead: what the settle ran and what it consumed. */
  head: string[];
  /** Blank-line separated blocks: wave summaries, answers, later events, the owed line. */
  blocks: string[];
  /** The delegate calls this entry shows (every one consumed by its waits). */
  shown: string[];
}

/**
 * The entry body for one consumed wait result `d`. `ran` names the wait; `everShown` holds the
 * calls earlier settles showed, so a wave that already had its summary prints only what is new.
 * One event, no owed news: the text is the single-event text (byte for byte). A wave of the batch
 * waits (with `io.wait`) until every batch wave is in or another event ends it.
 */
export async function settleBody(
  io: SettleIo,
  d: Rec,
  ran: string,
  everShown: Set<string>,
): Promise<SettleBody> {
  const call = async (id: string): Promise<CallRow | undefined> => {
    const v = await io.mu(["delegates", "show", id, "--json"]);
    return (v?.ok === true ? v.data?.call : undefined) as CallRow | undefined;
  };
  const listed = async (wave: string, fallback: CallRow[]): Promise<CallRow[]> => {
    const v = await io.mu(["delegates", "list", "--wave", wave, "--json"]);
    const items = (v?.ok === true ? v.data?.items : undefined) as CallRow[] | undefined;
    return Array.isArray(items) ? items : fallback;
  };
  const events = consumedEvents(d);
  const n = Math.max(1, events.length); // a result with no typed event still is one (its JSON)
  const shown = new Set<string>();
  const rows = new Map<string, CallRow | undefined>();
  for (const e of events) {
    const id = delegateIdOf(e);
    if (id === undefined || rows.has(id)) continue;
    shown.add(id);
    rows.set(id, await call(id));
  }
  // Every wave of the batch, in first-appearance order, with its rows.
  const waves = new Map<string, CallRow[]>();
  for (const c of rows.values()) {
    if (!c?.wave || waves.has(c.wave)) continue;
    const mine = [...rows.values()].filter((x): x is CallRow => x?.wave === c.wave);
    waves.set(c.wave, await listed(c.wave, mine));
  }
  const after: string[] = [];
  let failed = false;
  const notices = new Set<string>(noticesOf(d));
  // The latest result read: its picture says which rows are still owed, its `owed` the owed line.
  let last: Rec | undefined = d;
  let picture = pictureOf(d);
  // Owed: a pending sibling, or a finished one whose event no wait has handed over yet (leaving it
  // would repeat the summary one settle per call). A sibling absent from the latest picture was
  // consumed by an earlier wait, so it is not owed (waiting for it would never end).
  const owedRow = (r: CallRow) =>
    PENDING_STATES.has(r.state) ||
    (r.state !== "refused" && !shown.has(r.callId) && picture?.has(r.callId) !== false);
  const waveOf = (id: string): string | undefined =>
    [...waves].find(([, rs]) => rs.some((r) => r.callId === id))?.[0];
  const labels = [...waves.keys()];
  const waveWords =
    labels.length === 1
      ? `wave ${labels[0]}`
      : `waves ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  // ONE loop over the union of the batch waves: never one wave's wait after the other's. A human
  // stop does not end it (a wave is work already started); refused calls are never waited on.
  while (!io.aborted() && [...waves.values()].some((rs) => rs.some(owedRow))) {
    const r = await io.wait();
    const v = envelopeOf(r.stdout);
    if (v?.ok === false && v.error === "WaitNothingError") {
      last = undefined; // nothing owed
      break;
    }
    const d2 = v?.ok === true ? v.data : undefined;
    if (d2 === undefined) {
      failed = true;
      after.push(
        `The wave's wait failed (exit ${r.code}): ${(r.stdout.trim() || r.stderr.trim()).slice(0, 500)}`,
      );
      break;
    }
    if (d2.interrupted === true || d2.drained === true) break;
    for (const x of noticesOf(d2)) notices.add(x);
    picture = pictureOf(d2);
    last = d2;
    if (d2.timedOut === true) continue;
    const got = consumedEvents(d2);
    const superseded = d2.superseded === true;
    const touched = new Set<string>();
    const others: Rec[] = [];
    const otherCalls: CallRow[] = [];
    for (const e of got) {
      const id = delegateIdOf(e);
      if (id === undefined) {
        others.push(e);
        continue;
      }
      shown.add(id);
      let w = waveOf(id);
      let oc: CallRow | undefined;
      if (w === undefined) {
        oc = await call(id);
        if (oc?.wave && waves.has(oc.wave)) w = oc.wave; // a sibling the last list did not have yet
      }
      if (w !== undefined) touched.add(w);
      else {
        others.push(e);
        if (oc) otherCalls.push(oc);
      }
    }
    // A sibling of any batch wave folds into it (its rows refresh), even beside another event.
    for (const w of touched) waves.set(w, await listed(w, waves.get(w) ?? []));
    if (others.length > 0 || (got.length === 0 && !superseded)) {
      // Another event ended the waves' wait: it is consumed, so it is shown too.
      const snaps = recs(d2.snapshots);
      after.push(
        [
          `Another event came before the rest of ${waveWords}:`,
          ...(others.length > 1 ? others.map((e) => eventLine(e, snaps)) : []),
          JSON.stringify(d2),
        ].join("\n"),
      );
      for (const oc of otherCalls) after.push(await answerBlock(io.mu, oc, REPORT_CAP));
    }
    if (superseded) {
      // The newer wait returns what this one did not consume; waiting again would supersede it.
      after.push(
        got.length === 0
          ? SUPERSEDED_LINE.replace("[mu] settle: ", "")
          : "A newer mu wait of this session began; what is not shown here was not consumed, that wait returns it.",
      );
      break;
    }
    if (others.length > 0 || got.length === 0) break;
  }
  for (const [w, rs] of waves) waves.set(w, await listed(w, rs));
  const complete = (w: string): boolean =>
    !io.aborted() && !failed && !(waves.get(w) ?? []).some(owedRow);

  const snaps = recs(d.snapshots);
  const lineOf = (e: Rec): string => {
    const id = delegateIdOf(e);
    if (id === undefined) return eventLine(e, snaps);
    const c = rows.get(id);
    if (c === undefined) return `- delegate call ${id}: row unreadable, see below`;
    const label = recordOf(c) ?? `${c.workstream}/${c.task}`;
    return `- delegate ${label} (call ${id}) ${c.state}${c.verdict ? `, ${c.verdict}` : ""}: ${c.wave ? `in wave ${c.wave} below` : "answer below"}`;
  };
  const noticeLines = [...notices].map((x) => `Notice: ${x}`);
  const [only] = labels;
  const head =
    labels.length === 0
      ? n === 1
        ? [`${ran} Its result:`, JSON.stringify(d)]
        : [`${ran} ${n} events:`, ...events.map(lineOf), "Its result:", JSON.stringify(d)]
      : n === 1 && only !== undefined
        ? [
            complete(only)
              ? `${ran} It waited until wave ${only} was in:`
              : `${ran} It waited for wave ${only}, which is not all in (below):`,
            ...noticeLines,
          ]
        : [
            `${ran} ${n} events:`,
            ...events.map(lineOf),
            ...labels.map((w) => (complete(w) ? `wave ${w} in` : `wave ${w} not all in (below)`)),
            ...noticeLines,
          ];
  const blocks: string[] = [];
  for (const [w, rs] of waves) {
    const mine = rs.filter((x) => shown.has(x.callId));
    const summary = waveSummary(w, rs);
    // A wave an earlier settle already summarised: only what is new, and the tally line.
    blocks.push(
      rs.some((x) => everShown.has(x.callId))
        ? `wave ${w}: ${mine.length} more in\n${summary.split("\n")[0]}`
        : summary,
    );
    blocks.push(...(await Promise.all(mine.map((x) => answerBlock(io.mu, x, WAVE_REPORT_CAP)))));
  }
  const standalone = [...rows].filter(([, c]) => !c?.wave);
  const cap = standalone.length > 1 ? WAVE_REPORT_CAP : REPORT_CAP;
  for (const [id, c] of standalone)
    blocks.push(c === undefined ? unreadable(id) : await answerBlock(io.mu, c, cap));
  blocks.push(...after);
  const owed = last === undefined ? undefined : owedLine(last, "the next settle");
  if (owed !== undefined) blocks.push(owed);
  for (const id of shown) everShown.add(id);
  return { head, blocks, shown: [...shown] };
}
