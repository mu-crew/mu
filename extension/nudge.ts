/**
 * mu pi extension: the keep-driving settle wait, and the close nudge.
 *
 * Keep-driving (registerNudge): every completed settle of an orchestrator runs
 * `mu wait --ready --on-stall exit --json` as this session's callers (the
 * inherited managed identity and pi:<session>). Producers (spawn/send/claim)
 * arm that wait from state, so no shell line is parsed. The turn ends only when
 * nothing is owed, the wait fails (shown), or the user cancels it. The rule
 * text lives in skills/mu/SKILL.md between the keep-driving markers and heads
 * the wait's result; under a `mu human-needed` stop HUMAN_STOP_DRAIN heads it
 * instead (collect what runs, start nothing), and a stuck worker that is the
 * only owed work keeps the settle waiting until Esc or input.
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
 * the wave and shows ONE summary (extension/settle-events.ts). `registerNudge` takes the delegate side's
 * `delivered` hook (mu-pi.ts); the delegate side sends a one-line wake only
 * when no live settle wait will catch a just-recorded answer (delegate.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeNudgeText, keepDrivingRule } from "../src/nudge-text.js";
import { consumedEvents } from "../src/wait-event-text.js";
import { defaultRunner, type MuRunner, parseEnvelope } from "./delegate.js";
import { envelopeOf, type Run1, SUPERSEDED_LINE, settleBody } from "./settle-events.js";

// The words are shared with the Stop hook of the other harnesses (src/hook-stop.ts).
export { closeNudgeText, keepDrivingRule };

export const NUDGE_MESSAGE_TYPE = "mu-keep-driving";
export const NUDGE_LOG_KIND = "nudge";
export const CLOSE_NUDGE_MESSAGE_TYPE = "mu-close-task";

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
/** The one wait the settle runs: whatever this caller owns, every ready event (the ready batch). */
export const SETTLE_WAIT_ARGS = ["wait", "--ready", "--on-stall", "exit", "--json"] as const;
/**
 * The head of a settle entry while a human stop is open: the stop ends new work,
 * not the collection of what is already running (else results sit unmerged until
 * the human types). Replaces the keep-driving rule, which says "stop" there.
 */
export const HUMAN_STOP_DRAIN =
  "A human stop is open (mu human-needed). Collect and merge what you already started; start nothing new (no `mu next`, no spawn, no new delegate, no restart of a stalled or dead worker: tell the human). The settle keeps waiting while work you own is still running, and ends the turn when nothing is.";
/** Escape, plain or in the kitty keyboard protocol. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ESC = /^\u001b(\[27(;\d+)*u)?$/;

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
 * `mu wait --ready --on-stall exit --json`, as this session's callers. The turn
 * then ends only when the wait says nothing is owed (WaitNothingError, or drained),
 * the wait failed (shown), or the user cancelled it (Esc,
 * typed input, a dialog, shutdown). A heartbeat timeout with work still owed waits
 * again. The events it consumed (the ready batch: one line each) continue the turn
 * with the wait's own result (a wave's summary replaces it: its snapshots predate
 * the siblings' answers), which survives a late hold (it was consumed). A delegate
 * event adds that call's report; the waves of the batch first wait, in one loop,
 * for the rest of every wave (refused calls are listed, never waited on) and add
 * ONE summary each (settleBody). A superseded result that consumed nothing is one
 * shown line and no continue: the newer wait returns its events. An open human stop does not end the loop
 * while work is owed: the entry leads with HUMAN_STOP_DRAIN (collect, start
 * nothing) instead of the keep-driving rule; `mu next`, its hints and stall
 * release refuse on their own.
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
  // The delegate calls earlier settles showed: a wave summarised once prints only what is new.
  const everShown = new Set<string>();

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
          // Superseded with nothing of its own consumed: the newer wait returns these events. Shown,
          // not continued, and never waited again (that would supersede the newer wait in turn).
          if (d.superseded === true && consumedEvents(d).length === 0)
            return { entries: [entry(SUPERSEDED_LINE)] };
          const ran = `Work you own is still running, so the settle ran \`mu ${SETTLE_WAIT_ARGS.join(" ")}\` for you.`;
          const io = { wait: () => wait(SETTLE_WAIT_ARGS), mu, aborted: () => ctl.signal.aborted };
          const body = await settleBody(io, d, ran, everShown);
          if (body.shown.length > 0) delivered(body.shown);
          const stops = Array.isArray(d.humanNeeds) ? (d.humanNeeds as { reason?: unknown }[]) : [];
          const humanStop = needs > 0 || stops.length > 0;
          const lead = humanStop
            ? [
                `[mu] ${HUMAN_STOP_DRAIN}`,
                ...stops.flatMap((h) =>
                  typeof h.reason === "string" ? [`Stop: ${h.reason}`] : [],
                ),
              ]
            : [`[mu] ${rule}`];
          const text = [...lead, "", ...body.head, ...body.blocks.flatMap((b) => ["", b])].join(
            "\n",
          );
          return { entries: [entry(text)], continue: true, receipt: true };
        }
      })();
    } finally {
      off();
      if (current === ctl) current = undefined;
    }
    return result;
  });
}

/** The mu-spawned worker this pi runs as, or undefined outside mu. An
 *  orchestrator (`MU_ORCHESTRATOR=1`) is not a worker: no close nudge (D9). */
export function workerIdentity(
  env: NodeJS.ProcessEnv = process.env,
): { agent: string; workstream: string } | undefined {
  if (env.MU_ORCHESTRATOR === "1") return undefined;
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
