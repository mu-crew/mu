/**
 * mu pi extension: the keep-driving settle wait, and the close nudge.
 *
 * Keep-driving (registerNudge): every completed settle of an orchestrator runs
 * `mu wait --first --on-stall exit --json` as this session's callers (the
 * inherited managed identity and pi:<session>). Producers (spawn/send/claim)
 * arm that wait from state, so no shell line is parsed. The turn ends only when
 * nothing is owed, a `mu human-needed` stop is open (what is already ready is
 * still shown, without a blocking wait), the wait fails (shown), or the user
 * cancels it. The rule text lives in skills/mu/SKILL.md between the
 * keep-driving markers and heads the wait's result.
 *
 * Its worker-side twin, the close nudge: a mu-spawned pi worker
 * ($MU_AGENT_NAME + $MU_WORKSTREAM) that settles while it still owns an
 * IN_PROGRESS task is told once per prompt to close it or say why not.
 * `MU_NUDGE=0` turns both off.
 *
 * Neither runs in a nested pi (mu-pi.ts decides at bind) or on a remote host
 * (`MU_REMOTE=1`, no mu DB); close also skips a pi with no UI (`pi -p`, json),
 * where nobody can answer. Neither starts while a delegate wake is on its way
 * (its own turn waits) or a dialog is open.
 *
 * Delegate answers reach the model through the settle wait, never through a pi
 * echo: a `delegate` event is shown with that call's report (the durable task
 * note, capped, with a pointer), and an event of a wave waits for the rest of
 * the wave and shows ONE summary. `registerNudge` takes the delegate side's
 * `delivered` hook (mu-pi.ts); the delegate side sends a one-line wake only
 * when no live settle wait will catch a just-recorded answer (delegate.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRunner, type MuRunner, parseEnvelope } from "./delegate.js";

export const NUDGE_MESSAGE_TYPE = "mu-keep-driving";
export const NUDGE_LOG_KIND = "nudge";
export const CLOSE_NUDGE_MESSAGE_TYPE = "mu-close-task";
const MARK_START = "<!-- mu:keep-driving -->";
const MARK_END = "<!-- /mu:keep-driving -->";

/** The slice of pi's ExtensionContext the nudges read. */
export type MuNudgeCtx = {
  mode?: string;
  hasUI?: boolean;
  hasPendingMessages?: () => boolean;
  sessionManager?: { getSessionId?: () => string };
  ui?: { onTerminalInput?: (h: (data: string) => undefined) => () => void };
};

/** The slice of pi's ExtensionAPI the nudges use. */
export interface MuNudgeApi {
  on(
    event: "agent_before_settle" | "input" | "ui_prompt_start" | "session_shutdown",
    handler: (event: unknown, ctx: MuNudgeCtx) => unknown,
  ): unknown;
}

/**
 * True while this pi is nested: it inherited a MU_CTL_SOCK another pi
 * serves (a `pi -p` run inside an agent's pane). Read at settle time,
 * since the bind decision lands in session_start, after registration.
 */
export type NestedCheck = () => boolean;
const notNested: NestedCheck = () => false;

/**
 * Why this settle must not be nudged, read at settle time and again after
 * every awaited read. "input": a user message is queued (pi's own count).
 * "wake": a delegate wake is queued or being delivered (pi's
 * hasPendingMessages() does not count custom follow-ups); its own turn runs
 * the wait. Both mean the next turn is already coming. "blocked": an extension
 * dialog is open. undefined when nothing holds the settle. Any hold skips the
 * wait's START; none discards the entries of a wait already consumed.
 */
export type SettleHold = (ctx?: MuNudgeCtx) => "input" | "wake" | "blocked" | undefined;
const noHold: SettleHold = () => undefined;

/** A queued user message (pi's own count) holds like a wake: the next turn is coming. */
export function withQueuedInput(hold: SettleHold): SettleHold {
  return (ctx) => (ctx?.hasPendingMessages?.() ? "input" : hold(ctx));
}

/** No one can answer a nudge: print or json mode. */
function noUI(ctx: MuNudgeCtx | undefined): boolean {
  return ctx?.hasUI === false;
}

/** `MU_NUDGE=0` turns the nudge off. */
export function nudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MU_NUDGE !== "0";
}

/** The keep-driving paragraph from SKILL.md, or undefined without the markers. */
export function keepDrivingRule(skillMd: string): string | undefined {
  const i = skillMd.indexOf(MARK_START);
  const j = skillMd.indexOf(MARK_END);
  if (i < 0 || j < i) return undefined;
  const text = skillMd.slice(i + MARK_START.length, j).trim();
  return text === "" ? undefined : text;
}

/** SKILL.md next to this file in either layout (source or dist/extension). */
function readSkill(): string | undefined {
  for (const up of ["..", "../.."]) {
    const p = join(import.meta.dirname ?? "", up, "skills", "mu", "SKILL.md");
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return undefined;
}

type ListJson = {
  items?: { id?: string; status?: string; kind?: string }[];
  count?: number;
  more?: number;
};

/**
 * Every item of a task read, uncapped: `uncapped` is the flag that turns the 4 KB
 * cap off (`--all`; `--full` on owned-by). A result that still says `more` is
 * unknown (undefined): a cut is not proof that nothing else is running.
 */
async function allItems(
  run: MuRunner,
  argv: string[],
  uncapped: "--all" | "--full",
): Promise<NonNullable<ListJson["items"]> | undefined> {
  const r = await run([...argv, uncapped]);
  if (r.code !== 0) return undefined;
  // mu prints {ok,data:{items,count,more},next}; no envelope reads as "unknown".
  const data = parseEnvelope(r.stdout) as ListJson | undefined;
  if (data === undefined || !Array.isArray(data.items)) return undefined;
  if ((data.more ?? 0) > 0) return undefined;
  return data.items;
}

/** Write a `mu log` breadcrumb without holding the settle for it: the
 *  nudge's message does not depend on the log line. */
function breadcrumb(run: MuRunner, args: string[]): void {
  void run(args).catch(() => {});
}

/** A nudge's settle result. `yielded` undoes the nudge's once-per-prompt
 *  bookkeeping when the merge drops the result for a late hold. A `receipt`
 *  carries something already consumed (a wait's event): a late hold drops only
 *  its continuation, never its entries. */
type SettleResult =
  | { entries?: unknown[]; continue?: boolean; yielded?: () => void; receipt?: boolean }
  | undefined;
type SettleHandler = (event: unknown, ctx: MuNudgeCtx) => unknown;

/**
 * A view of `pi` whose `agent_before_settle` handlers run in PARALLEL
 * behind one real handler. pi awaits boundary handlers one after the
 * other, and each nudge awaits a mu subprocess, so several nudges held the
 * settle (and every `mu agent wait` on it) for the sum of their calls.
 * The merged result appends every handler's entries to the event's
 * (pi replaces `entries` with each handler's return, so separate
 * handlers dropped all but the last nudge) and continues when any asks.
 * A nudge that throws still reaches pi's extension-error path: after the
 * merged handler, one reporter handler per nudge rethrows that nudge's
 * error, so pi reports each failure (as it did when every nudge was its
 * own handler) while the other nudges' entries are still delivered.
 * The merge reads `hold` once more after the slowest nudge: a fast nudge
 * checked it long before, so input or a wake that queued meanwhile drops
 * every result, an open dialog the continuing ones, and each dropped nudge
 * may fire on a later settle. A receipt (a consumed wait event) keeps its
 * entries under any late hold and loses only its continuation.
 * Call `flush()` after registering the nudges.
 */
export function parallelSettle(
  pi: MuNudgeApi,
  hold: SettleHold = noHold,
): { api: MuNudgeApi; flush(): void } {
  const handlers: SettleHandler[] = [];
  const api: MuNudgeApi = {
    on(event, handler) {
      if (event === "agent_before_settle") handlers.push(handler);
      else pi.on(event, handler);
    },
  };
  // Errors of the last settle, by handler index; each reporter takes its own.
  let errors: (unknown[] | undefined)[] = [];
  return {
    api,
    flush() {
      if (handlers.length === 0) return;
      pi.on("agent_before_settle", async (event, ctx) => {
        errors = handlers.map(() => undefined);
        const results = await Promise.all(
          handlers.map(async (h, i) => {
            try {
              return (await h(event, ctx)) as SettleResult;
            } catch (err) {
              errors[i] = [err]; // reported by reporter i, after the merge
              return undefined;
            }
          }),
        );
        const late = hold(ctx);
        const fired = results.flatMap((r) => {
          if (r === undefined) return [];
          if (r.receipt === true && late !== undefined) return [{ entries: r.entries ?? [] }];
          if (late === "input" || late === "wake" || (late === "blocked" && r.continue === true)) {
            r.yielded?.();
            return [];
          }
          return [r];
        });
        if (fired.length === 0) return undefined;
        const prior = (event as { entries?: unknown[] } | null)?.entries ?? [];
        return {
          entries: [...prior, ...fired.flatMap((r) => r.entries ?? [])],
          ...(fired.some((r) => r.continue === true) ? { continue: true } : {}),
        };
      });
      handlers.forEach((_, i) => {
        pi.on("agent_before_settle", () => {
          const err = errors[i];
          errors[i] = undefined;
          if (err !== undefined) throw err[0];
          return undefined;
        });
      });
    },
  };
}

function outcomeOf(event: unknown): unknown {
  return typeof event === "object" && event !== null
    ? (event as { outcome?: unknown }).outcome
    : undefined;
}

/** How long a cancelled wait may take to print its final snapshot before SIGKILL. */
export const SETTLE_DRAIN_MS = 3000;
/** The one wait the settle runs: whatever this caller owns, first event. */
export const SETTLE_WAIT_ARGS = ["wait", "--first", "--on-stall", "exit", "--json"] as const;
/**
 * Under an open human stop the settle does not block: this wait returns an event
 * already ready, or times out within a second.
 */
export const SETTLE_READY_ARGS = [
  "wait",
  "--first",
  "--on-stall",
  "exit",
  "--timeout",
  "1",
  "--json",
] as const;
/** At most this many ready events are shown by one settle under a human stop. */
const READY_MAX = 50;
/** Escape, plain or in the kitty keyboard protocol. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ESC = /^\u001b(\[27(;\d+)*u)?$/;

type Envelope = { ok?: unknown; error?: unknown; data?: Record<string, unknown> };

function envelopeOf(stdout: string): Envelope | undefined {
  try {
    const v = JSON.parse(stdout) as Envelope | null;
    return typeof v === "object" && v !== null && typeof v.ok === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdOf(ctx: MuNudgeCtx | undefined): string | undefined {
  try {
    return ctx?.sessionManager?.getSessionId?.() || undefined;
  } catch {
    return undefined; // a stale ctx throws
  }
}

/**
 * The child env per caller identity: the inherited managed `<ws>/<name>` (pi
 * session stripped), and `pi:<session>` (managed identity stripped). Each is a
 * separate `mu state --me` read: --me resolves one identity, and a human stop
 * either one recorded ends the loop.
 */
function identityEnvs(sid: string | undefined): Record<string, string | undefined>[] {
  const e = process.env;
  const out: Record<string, string | undefined>[] = [];
  if (e.MU_MANAGED_AGENT === "1" && e.MU_WORKSTREAM && e.MU_AGENT_NAME)
    out.push({ PI_SESSION_ID: undefined });
  if (sid !== undefined) out.push({ MU_MANAGED_AGENT: undefined, PI_SESSION_ID: sid });
  return out;
}

/** Open human needs across every caller identity; undefined when a read failed. */
async function humanNeeds(run: MuRunner, sid: string | undefined): Promise<number | undefined> {
  const counts = await Promise.all(
    identityEnvs(sid).map(async (env) => {
      const r = await run(["state", "--me", "--all", "--full", "--json"], undefined, undefined, {
        env,
      }).catch(() => undefined);
      const env0 = r === undefined ? undefined : envelopeOf(r.stdout);
      const ws = env0?.ok === true ? env0.data?.workstreams : undefined;
      if (!Array.isArray(ws)) return undefined;
      return ws.reduce(
        (n: number, w: { human_needs?: unknown[] }) => n + (w.human_needs?.length ?? 0),
        0,
      );
    }),
  );
  return counts.some((c) => c === undefined)
    ? undefined
    : counts.reduce((a: number, b) => a + (b ?? 0), 0);
}

function entry(content: string): unknown {
  return { type: "custom_message", customType: NUDGE_MESSAGE_TYPE, content, display: true };
}

/** One answer's report in a settle entry is cut to this many characters (tail of the pointer kept). */
export const REPORT_CAP = 4000;
/** In a wave summary, each answer shown in full is cut to this. */
export const WAVE_REPORT_CAP = 1500;
const PENDING_STATES = new Set(["queued", "starting", "running", "recording"]);

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
type Run1 = (args: readonly string[]) => Promise<Envelope | undefined>;

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

/** The firing snapshot of a wait result, when its event is a delegate answer. */
function firingDelegate(d: Record<string, unknown>): string | undefined {
  const f = d.firing as { kind?: unknown; ref?: unknown } | undefined;
  if (f?.kind !== "delegate" || typeof f.ref !== "string") return undefined;
  return f.ref.startsWith("delegate:") ? f.ref.slice("delegate:".length) : undefined;
}

/**
 * The call ids of the delegate calls a wait result's snapshots still show (its owed picture), or
 * undefined when the result cut its snapshots (the picture is then unknown, not empty).
 */
function pictureOf(d: Record<string, unknown>): Set<string> | undefined {
  if (typeof d.snapshotsCut === "number" && d.snapshotsCut > 0) return undefined;
  const snaps = Array.isArray(d.snapshots) ? (d.snapshots as { ref?: unknown }[]) : [];
  return new Set(
    snaps.flatMap((s) =>
      typeof s.ref === "string" && s.ref.startsWith("delegate:")
        ? [s.ref.slice("delegate:".length)]
        : [],
    ),
  );
}

/**
 * Told which delegate answers a settle showed the model: their call ids, or
 * `{ before }` when the wait found nothing owed (every answer recorded before
 * that wait started, at epoch ms `before`, was consumed: by this settle or by
 * a wait the model ran itself). The delegate side wakes pi only for answers no
 * settle showed.
 */
export type SettleDelivered = (shown: readonly string[] | { before: number }) => void;
const noDelivered: SettleDelivered = () => {};

/**
 * The keep-driving settle wait. Every completed settle (no once-per-prompt latch,
 * no shell parsing: producers arm the wait from state) runs the ONE wait,
 * `mu wait --first --on-stall exit --json`, as this session's callers. The turn
 * then ends only when the wait says nothing is owed (WaitNothingError, or drained),
 * a human stop is open (ready events are still shown: no blocking wait, no
 * continue), the wait failed (shown), or the user cancelled it (Esc,
 * typed input, a dialog, shutdown). A heartbeat timeout with work still owed waits
 * again. An event continues the turn with the wait's own result, which survives a
 * late hold (it was consumed). A delegate event adds that call's report; one of a
 * wave first waits for the rest of the wave (refused calls are listed, never
 * waited on) and adds ONE summary.
 */
export function registerNudge(
  pi: MuNudgeApi,
  run: MuRunner = defaultRunner(),
  skillMd: string | undefined = readSkill(),
  nested: NestedCheck = notNested,
  hold: SettleHold = noHold,
  delivered: SettleDelivered = noDelivered,
): void {
  if (!nudgeEnabled()) return;
  if (process.env.MU_REMOTE === "1") return; // no mu DB on a remote host
  const rule = skillMd === undefined ? undefined : keepDrivingRule(skillMd);
  if (rule === undefined) return; // no markers: nothing true to quote

  let current: AbortController | undefined;
  const cancel = (): void => current?.abort();
  pi.on("input", cancel);
  pi.on("ui_prompt_start", cancel);
  pi.on("session_shutdown", cancel);

  pi.on("agent_before_settle", async (event, ctx) => {
    if (nested() || hold(ctx)) return;
    if (outcomeOf(event) !== "completed") return; // Esc or an error: stop
    const sid = sessionIdOf(ctx);
    if (identityEnvs(sid).length === 0) return; // no caller: nothing can be owed
    const env = { PI_SESSION_ID: sid };
    const ctl = new AbortController();
    current = ctl;
    const off =
      ctx?.ui?.onTerminalInput?.((data) => {
        if (ESC.test(data)) ctl.abort();
        return undefined; // never consumed: pi still sees the key
      }) ?? (() => {});
    const wait = (args: readonly string[]) =>
      run(args, ctl.signal, undefined, { env, drainMs: SETTLE_DRAIN_MS });
    const mu: Run1 = async (args) =>
      envelopeOf(
        (await run(args, undefined, undefined, { env }).catch(() => undefined))?.stdout ?? "",
      );
    const call = async (id: string): Promise<CallRow | undefined> => {
      const v = await mu(["delegates", "show", id, "--json"]);
      return (v?.ok === true ? v.data?.call : undefined) as CallRow | undefined;
    };
    /**
     * The report block(s) of a consumed delegate event. One of a wave keeps
     * running the same owned wait while siblings are pending (refused ones are
     * not waited on: they need a reissue), folding each sibling's answer into ONE
     * summary; any other event ends that and is shown after it. `stop`: a human
     * stop came with one of those results.
     */
    const answers = async (
      callId: string,
      shown: Set<string>,
      first: Record<string, unknown>,
    ): Promise<{ blocks: string[]; stop: boolean }> => {
      shown.add(callId);
      const c = await call(callId);
      if (c === undefined)
        return {
          blocks: [
            `Delegate answer: call ${callId}. Its row is unreadable here: mu delegates show ${callId}`,
          ],
          stop: false,
        };
      const wave = c.wave;
      if (!wave) return { blocks: [await answerBlock(mu, c, REPORT_CAP)], stop: false };
      const listed = async () => {
        const v = await mu(["delegates", "list", "--wave", wave, "--json"]);
        const items = (v?.ok === true ? v.data?.items : undefined) as CallRow[] | undefined;
        return Array.isArray(items) ? items : [c];
      };
      const after: string[] = [];
      let stop = false;
      let rows = await listed();
      // Owed: a pending sibling, or a finished one whose event this wait has not yet handed over
      // (the cursor still owes it: leaving it would repeat the summary one settle per call). The
      // latest wait's picture says which: it drops what an earlier wait already consumed, so a
      // sibling absent from it is not owed (waiting for it would never end).
      let picture = pictureOf(first);
      const owedRow = (r: CallRow) =>
        PENDING_STATES.has(r.state) ||
        (r.state !== "refused" && !shown.has(r.callId) && picture?.has(r.callId) !== false);
      while (!ctl.signal.aborted && rows.some(owedRow)) {
        const r = await wait(SETTLE_WAIT_ARGS);
        const v = envelopeOf(r.stdout);
        if (v?.ok === false && v.error === "WaitNothingError") break;
        const d = v?.ok === true ? v.data : undefined;
        if (d === undefined) {
          after.push(
            `The wave's wait failed (exit ${r.code}): ${(r.stdout.trim() || r.stderr.trim()).slice(0, 500)}`,
          );
          break;
        }
        if (d.interrupted === true || d.drained === true) break;
        picture = pictureOf(d);
        if (d.timedOut === true) continue;
        if (Array.isArray(d.humanNeeds) && d.humanNeeds.length > 0) stop = true;
        const id = firingDelegate(d);
        const sibling = id !== undefined && rows.some((x) => x.callId === id);
        if (id !== undefined) shown.add(id);
        if (sibling && !stop) {
          rows = await listed();
          continue;
        }
        // Another event ended the wave's wait: it is consumed, so it is shown too.
        after.push(`Another event came before the rest of wave ${wave}:\n${JSON.stringify(d)}`);
        const oc = id === undefined || sibling ? undefined : await call(id);
        if (oc) after.push(await answerBlock(mu, oc, REPORT_CAP));
        break;
      }
      rows = await listed();
      const bodies = await Promise.all(
        rows.filter((x) => shown.has(x.callId)).map((x) => answerBlock(mu, x, WAVE_REPORT_CAP)),
      );
      return { blocks: [waveSummary(wave, rows), ...bodies, ...after], stop };
    };
    /**
     * The settle under an open human stop: drain the events already ready (each
     * delegate answer with its report), show them, and never continue. Nothing
     * ready: the turn ends quietly.
     */
    const ready = async (): Promise<SettleResult> => {
      const blocks: string[] = [];
      const shown: string[] = [];
      for (let i = 0; i < READY_MAX && !ctl.signal.aborted; i++) {
        const started = Date.now();
        const r = await wait(SETTLE_READY_ARGS);
        const v = envelopeOf(r.stdout);
        if (v?.ok === false && v.error === "WaitNothingError") {
          delivered({ before: started });
          break;
        }
        const d = v?.ok === true ? v.data : undefined;
        if (d === undefined) {
          const why = (r.stdout.trim() || r.stderr.trim()).slice(0, 2000);
          blocks.push(`mu wait failed (exit ${r.code}): ${why}`);
          break;
        }
        if (d.drained === true) delivered({ before: started });
        if (d.interrupted === true || d.drained === true || d.timedOut === true) break;
        blocks.push(JSON.stringify(d));
        const id = firingDelegate(d);
        if (id === undefined) continue;
        shown.push(id);
        const c = await call(id);
        blocks.push(
          c === undefined
            ? `Delegate answer: call ${id}. Its row is unreadable here: mu delegates show ${id}`
            : await answerBlock(mu, c, REPORT_CAP),
        );
      }
      if (shown.length > 0) delivered(shown);
      if (blocks.length === 0) return undefined;
      const text = [
        "[mu] A human stop is open (mu human-needed), so the settle did not wait. It showed what was already ready:",
        ...blocks.flatMap((b) => ["", b]),
      ].join("\n");
      return { entries: [entry(text)], receipt: true };
    };
    let result: SettleResult;
    try {
      result = await (async (): Promise<SettleResult> => {
        for (;;) {
          const needs = await humanNeeds(run, sid);
          if (ctl.signal.aborted || hold(ctx)) return undefined;
          if (needs === undefined)
            return {
              entries: [
                entry(
                  "[mu] settle: could not read your open human needs (mu state --me); not waiting.",
                ),
              ],
            };
          if (needs > 0) return ready(); // a deliberate human stop: show what is ready, never block
          const started = Date.now();
          const r = await wait(SETTLE_WAIT_ARGS);
          const v = envelopeOf(r.stdout);
          if (v?.ok === false && v.error === "WaitNothingError") {
            delivered({ before: started }); // nothing owed: every finished answer was consumed
            return undefined;
          }
          if (v === undefined || v.ok !== true || v.data === undefined) {
            const why = (r.stdout.trim() || r.stderr.trim()).slice(0, 2000);
            return { entries: [entry(`[mu] settle: mu wait failed (exit ${r.code}): ${why}`)] };
          }
          const d = v.data;
          if (d.drained === true) delivered({ before: started });
          if (d.interrupted === true || d.drained === true) return undefined; // cancelled, or nothing owed
          if (d.timedOut === true) continue; // work still owed: wait again
          const callId = firingDelegate(d);
          const shown = new Set<string>();
          const got = callId === undefined ? undefined : await answers(callId, shown, d);
          const blocks = got?.blocks ?? [];
          if (shown.size > 0) delivered([...shown]);
          const stop =
            (Array.isArray(d.humanNeeds) && d.humanNeeds.length > 0) || got?.stop === true;
          const text = [
            `[mu] ${rule}`,
            "",
            `Work you own is still running, so the settle ran \`mu ${SETTLE_WAIT_ARGS.join(" ")}\` for you. Its result:`,
            JSON.stringify(d),
            ...blocks.flatMap((b) => ["", b]),
          ].join("\n");
          return { entries: [entry(text)], ...(stop ? {} : { continue: true }), receipt: true };
        }
      })();
    } finally {
      off();
      if (current === ctl) current = undefined;
    }
    return result;
  });
}

/** The mu-spawned worker this pi runs as, or undefined outside mu. */
export function workerIdentity(
  env: NodeJS.ProcessEnv = process.env,
): { agent: string; workstream: string } | undefined {
  const agent = env.MU_AGENT_NAME;
  const workstream = env.MU_WORKSTREAM;
  if (!agent || !workstream || workstream === "scratch") return undefined;
  return { agent, workstream };
}

/**
 * IN_PROGRESS task names owned by `agent`, from `mu task owned-by --json`. A
 * `kind=delegate` task is left out: a delegate is spawned with `--task` bound
 * to its own call task, and that call records the answer and closes it
 * (finishDelegate); a pane that closed it itself would lose the answer.
 */
async function ownedInProgress(
  run: MuRunner,
  agent: string,
  workstream: string,
): Promise<string[] | undefined> {
  try {
    const items = await allItems(
      run,
      ["task", "owned-by", agent, "-w", workstream, "--json"],
      "--full",
    );
    if (items === undefined) return undefined;
    return items.flatMap((t) =>
      t.status === "IN_PROGRESS" && t.kind !== "delegate" && t.id ? [t.id] : [],
    );
  } catch {
    return undefined;
  }
}

/** The close-nudge text: name each task and the two ways out. */
export function closeNudgeText(workstream: string, names: string[]): string {
  const close = names
    .map((n) => `mu task close ${n} -w ${workstream} --evidence "<what you verified>"`)
    .join("\n  ");
  return [
    `[mu] You are stopping while you still own ${names.map((n) => `${workstream}/${n}`).join(", ")} (IN_PROGRESS).`,
    "If the work is done and verified, close it now:",
    `  ${close}`,
    "If you are blocked or need an answer, say so in one line and stop; the orchestrator will read your pane.",
  ].join("\n");
}

export function registerCloseNudge(
  pi: MuNudgeApi,
  run: MuRunner = defaultRunner(),
  env: NodeJS.ProcessEnv = process.env,
  nested: NestedCheck = notNested,
  hold: SettleHold = noHold,
): void {
  if (!nudgeEnabled(env)) return;
  // A remote worker has no mu DB: `mu task owned-by` there would read nothing.
  // The orchestrator owns CLOSE (spawn --host sets MU_REMOTE=1).
  if (env.MU_REMOTE === "1") return;
  const me = workerIdentity(env);
  if (me === undefined) return;
  let fired = false;

  pi.on("input", () => {
    fired = false;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (fired || nested() || noUI(ctx) || hold(ctx)) return; // nested: workerIdentity is the parent's
    if (outcomeOf(event) !== "completed") return;
    fired = true;
    const names = await ownedInProgress(run, me.agent, me.workstream);
    if (names === undefined || names.length === 0) return;
    if (hold(ctx)) {
      fired = false;
      return;
    }
    breadcrumb(run, [
      "log",
      "-w",
      me.workstream,
      "--kind",
      NUDGE_LOG_KIND,
      `close: ${me.agent} settled owning ${names.join(", ")}`,
    ]);
    return {
      entries: [
        {
          type: "custom_message",
          customType: CLOSE_NUDGE_MESSAGE_TYPE,
          content: closeNudgeText(me.workstream, names),
          display: true,
        },
      ],
      continue: true,
      yielded: () => {
        fired = false;
      },
    };
  });
}
