/**
 * mu pi extension: the keep-driving settle wait, and the close nudge.
 *
 * Keep-driving (registerNudge): every completed settle of an orchestrator runs
 * `mu wait --first --on-stall exit --json` as this session's callers (the
 * inherited managed identity and pi:<session>). Producers (spawn/send/claim)
 * arm that wait from state, so no shell line is parsed. The turn ends only when
 * nothing is owed, a `mu human-needed` stop is open, the wait fails (shown), or
 * the user cancels it. The rule text lives in skills/mu/SKILL.md between the
 * keep-driving markers and heads the wait's result.
 *
 * Its worker-side twin, the close nudge: a mu-spawned pi worker
 * ($MU_AGENT_NAME + $MU_WORKSTREAM) that settles while it still owns an
 * IN_PROGRESS task is told once per prompt to close it or say why not.
 * `MU_NUDGE=0` turns both off.
 *
 * Neither runs in a nested pi (mu-pi.ts decides at bind) or on a remote host
 * (`MU_REMOTE=1`, no mu DB); close also skips a pi with no UI (`pi -p`, json),
 * where nobody can answer. Neither starts while a delegate answer is on its way
 * (it resumes the agent with the answer) or a dialog is open.
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
 * Why this settle must not be nudged, read at settle time and again
 * after every awaited read: "answer" while a delegate answer is queued
 * or being delivered (it resumes the agent itself, and a continuation
 * would run before it; pi's hasPendingMessages() does not count custom
 * follow-ups), "blocked" while an extension dialog is open. undefined
 * when nothing holds the settle.
 */
export type SettleHold = (ctx?: MuNudgeCtx) => "answer" | "blocked" | undefined;
const noHold: SettleHold = () => undefined;

/** A queued user message (pi's own count) or a held settle: either way the
 *  next turn is already coming, so a continuation would run ahead of it. */
export function withQueuedInput(hold: SettleHold): SettleHold {
  return (ctx) => (ctx?.hasPendingMessages?.() ? "answer" : hold(ctx));
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

type ListJson = { items?: { id?: string; status?: string }[]; count?: number; more?: number };

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
 * checked it long before, so an answer that queued meanwhile drops every
 * result ("answer") or the continuing ones ("blocked"), and each dropped
 * nudge may fire on a later settle (a receipt keeps its entries).
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
          if (late === "answer" || (late === "blocked" && r.continue === true)) {
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
/** Escape, plain or in the kitty keyboard protocol. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ESC = /^\u001b(\[27(;\d+)*u)?$/;

/** Subscribe to "an answer is on its way" (a delegate answer); returns the unsubscribe. */
export type SettleWake = (onWake: () => void) => () => void;
const noWake: SettleWake = () => () => {};

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

/**
 * The keep-driving settle wait. Every completed settle (no once-per-prompt latch,
 * no shell parsing: producers arm the wait from state) runs the ONE wait,
 * `mu wait --first --on-stall exit --json`, as this session's callers. The turn
 * then ends only when the wait says nothing is owed (WaitNothingError, or drained),
 * a human stop is open, the wait failed (shown), or the user cancelled it (Esc,
 * typed input, a dialog, shutdown). A delegate answer on its way cancels the wait
 * too: the answer resumes the agent, and its settle waits again. A heartbeat
 * timeout with work still owed waits again; an event continues the turn with the
 * wait's own result, which survives a late hold (it was consumed).
 */
export function registerNudge(
  pi: MuNudgeApi,
  run: MuRunner = defaultRunner(),
  skillMd: string | undefined = readSkill(),
  nested: NestedCheck = notNested,
  hold: SettleHold = noHold,
  wake: SettleWake = noWake,
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
    const offs = [
      wake(() => ctl.abort()),
      ctx?.ui?.onTerminalInput?.((data) => {
        if (ESC.test(data)) ctl.abort();
        return undefined; // never consumed: pi still sees the key
      }) ?? (() => {}),
    ];
    try {
      for (;;) {
        const needs = await humanNeeds(run, sid);
        if (ctl.signal.aborted || hold(ctx)) return;
        if (needs === undefined)
          return {
            entries: [
              entry(
                "[mu] settle: could not read your open human needs (mu state --me); not waiting.",
              ),
            ],
          };
        if (needs > 0) return; // a deliberate human stop
        const r = await run(SETTLE_WAIT_ARGS, ctl.signal, undefined, {
          env,
          drainMs: SETTLE_DRAIN_MS,
        });
        const v = envelopeOf(r.stdout);
        if (v?.ok === false && v.error === "WaitNothingError") return; // nothing owed
        if (v === undefined || v.ok !== true || v.data === undefined) {
          const why = (r.stdout.trim() || r.stderr.trim()).slice(0, 2000);
          return { entries: [entry(`[mu] settle: mu wait failed (exit ${r.code}): ${why}`)] };
        }
        const d = v.data;
        if (d.interrupted === true || d.drained === true) return; // cancelled, or nothing owed
        if (d.timedOut === true) continue; // work still owed: wait again
        const stop = Array.isArray(d.humanNeeds) && d.humanNeeds.length > 0;
        const text = [
          `[mu] ${rule}`,
          "",
          `Work you own is still running, so the settle ran \`mu ${SETTLE_WAIT_ARGS.join(" ")}\` for you. Its result:`,
          JSON.stringify(d),
        ].join("\n");
        return { entries: [entry(text)], ...(stop ? {} : { continue: true }), receipt: true };
      }
    } finally {
      for (const off of offs) off();
      if (current === ctl) current = undefined;
    }
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

/** IN_PROGRESS task names owned by `agent`, from `mu task owned-by --json`. */
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
    return items.flatMap((t) => (t.status === "IN_PROGRESS" && t.id ? [t.id] : []));
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
