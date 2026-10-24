/**
 * mu pi extension: the keep-driving nudge (docs/specs/2026-10-03-keep-driving-nudge.md).
 *
 * An orchestrator that dispatched mu work and then ends its turn while
 * that work is still IN_PROGRESS gets ONE visible message quoting the
 * skill's keep-driving rule, and one continuation. If it stops again,
 * that stop stands. Not a goal loop: no re-check, no counter.
 *
 * Its only read is `mu task list --status IN_PROGRESS --json`, its only write `mu log --kind
 * nudge`; the armed set and fired flag are per-prompt scratch. The rule
 * text lives in skills/mu/SKILL.md between the keep-driving markers.
 *
 * Its worker-side twin, the close nudge: a mu-spawned pi worker
 * ($MU_AGENT_NAME + $MU_WORKSTREAM) that settles while it still owns an
 * IN_PROGRESS task is told once to close it or say why not. Same
 * once-per-prompt rule and `MU_NUDGE=0` opt-out.
 *
 * Neither fires in a nested pi (mu-pi.ts decides at bind); close also
 * skips a pi with no UI (`pi -p`, json), where nobody can answer.
 * Neither fires while a delegate answer is on its way (it resumes the agent
 * with the answer), and keep-driving and close skip an open dialog. A
 * held settle does not count as the prompt's one nudge.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWorkstreamFragments,
  qualifiedRefProblem,
  workstreamNameProblem,
} from "../src/workstream-scope.js";
import { defaultRunner, type MuRunner } from "./delegate.js";

export const NUDGE_MESSAGE_TYPE = "mu-keep-driving";
export const NUDGE_LOG_KIND = "nudge";
export const CLOSE_NUDGE_MESSAGE_TYPE = "mu-close-task";
const MARK_START = "<!-- mu:keep-driving -->";
const MARK_END = "<!-- /mu:keep-driving -->";
/** Tasks named in the wait hint; the rest are counted, not listed. */
const WAIT_HINT_MAX = 8;

/** The slice of pi's ExtensionContext the nudge reads. */
export type MuNudgeCtx = { mode?: string; hasUI?: boolean; hasPendingMessages?: () => boolean };

/** The slice of pi's ExtensionAPI the nudge uses. */
export interface MuNudgeApi {
  on(
    event: "tool_call" | "agent_before_settle" | "input",
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

/** Leading `NAME=value` words: env assignments before the command. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The args after `mu` when this segment runs mu (after any env
 *  assignments), or undefined when it runs something else. */
function muArgs(words: string[]): string[] | undefined {
  let at = 0;
  while (at < words.length && ENV_ASSIGN.test(words[at] ?? "")) at++;
  const cmd = words[at];
  if (cmd !== "mu" && !cmd?.endsWith("/mu")) return undefined;
  return words.slice(at + 1);
}

/** Options (after the verb) that take a value, so their value is not mistaken for the ref. */
const VALUE_OPTS = new Set([
  "--for",
  "-f",
  "--evidence",
  "--actor",
  "--timeout",
  "--cli",
  "--command",
  "--tab",
  "--role",
  "--cwd",
  "--from",
  "--root",
  "--send",
]);

/**
 * Scan args from `from`: every `-w` / `--workstream` value in order (a
 * missing one is `""`, which is invalid), the option names seen, and the
 * positionals. Mirrors commander: `-wX` attaches, `--workstream=X` splits.
 * `stopAtPositional` ends the scan at the first positional (the root
 * options before the verb); `end` is where it stopped.
 */
function scanArgs(
  args: string[],
  from: number,
  stopAtPositional = false,
): { ws: string[]; seen: Set<string>; positionals: string[]; end: number; forValue?: string } {
  const ws: string[] = [];
  let forValue: string | undefined;
  const seen = new Set<string>();
  const positionals: string[] = [];
  let k = from;
  for (; k < args.length; k++) {
    const w = args[k] ?? "";
    if (w === "--") {
      positionals.push(...args.slice(k + 1));
      k = args.length;
      break;
    }
    if (!w.startsWith("-") || w === "-") {
      if (stopAtPositional) break;
      positionals.push(w);
      continue;
    }
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const opt = eq === -1 ? w : w.slice(0, eq);
    seen.add(opt);
    if (opt === "-w" || opt === "--workstream") {
      ws.push(eq !== -1 ? w.slice(eq + 1) : (args[++k] ?? ""));
    } else if (!w.startsWith("--") && w.startsWith("-w")) {
      ws.push(w.slice(2));
    } else if (opt === "--for" || opt === "-f") {
      seen.add("--for");
      forValue = eq !== -1 ? w.slice(eq + 1) : (args[++k] ?? "");
    } else if (!w.startsWith("--") && w.startsWith("-f")) {
      seen.add("--for");
      forValue = w.slice(2);
    } else if (VALUE_OPTS.has(opt) && eq === -1) {
      k++;
    }
  }
  return forValue === undefined
    ? { ws, seen, positionals, end: k }
    : { ws, seen, positionals, end: k, forValue };
}

/**
 * The workstream mu would act on, or undefined when mu would refuse (so
 * nothing is dispatched): a root `-w` (before the verb; one name), the
 * verb's `-w` (last wins), a qualified `<ws>/<name>` ref, else the injected
 * one. Given explicitly, they must agree. Validation is the CLI's one
 * validator (src/workstream-scope.ts): an empty, blank or padded name is
 * invalid, never trimmed and never a reason to fall back to the injected
 * workstream.
 */
function scopeOf(
  root: string[],
  verb: string[],
  prefix: string | undefined,
  injected: string,
): string | undefined {
  if (root.length > 0 && verb.length > 0) return undefined;
  let explicit: string | undefined;
  if (root.length > 0) {
    const parsed = parseWorkstreamFragments(root);
    if ("problem" in parsed || parsed.names.length !== 1) return undefined;
    explicit = parsed.names[0];
  } else if (verb.length > 0) {
    explicit = verb[verb.length - 1] ?? "";
    if (workstreamNameProblem(explicit) !== undefined) return undefined;
  }
  if (prefix !== undefined) {
    if (workstreamNameProblem(prefix) !== undefined) return undefined;
    if (explicit !== undefined && explicit !== prefix) return undefined;
    explicit = prefix;
  }
  const ws = explicit ?? injected;
  return ws === "" ? undefined : ws;
}

/**
 * The workstreams a bash command dispatches mu work into, or undefined
 * when it dispatches nothing. Dispatch = `mu agent send|spawn`, or
 * `mu task claim <id> --for`. The scope is the CLI's (see scopeOf): a
 * root or verb `-w`, or the `<ws>/` of the agent or task ref. A dispatch
 * with no scope, or an invalid one, is refused by mu (nothing was
 * dispatched); a missing scope counts only when `env` carries a managed
 * worker's injected workstream.
 */
export function dispatchedWorkstreams(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const injected = env.MU_MANAGED_AGENT === "1" ? (env.MU_WORKSTREAM ?? "") : "";
  const found = new Set<string>();
  // One mu invocation per shell segment.
  for (const words of shellSegments(command)) {
    const all = muArgs(words);
    if (all === undefined) continue;
    const rootOpts = scanArgs(all, 0, true);
    const args = all.slice(rootOpts.end);
    const isClaim = args[0] === "task" && args[1] === "claim";
    const isAgent = args[0] === "agent" && (args[1] === "send" || args[1] === "spawn");
    if (!isClaim && !isAgent) continue;
    const { ws, seen, positionals, forValue } = scanArgs(args, 2);
    if (isClaim && !seen.has("--for")) continue;
    const ref = positionals[0];
    if (isClaim && ref === undefined) continue;
    const slash = ref?.indexOf("/") ?? -1;
    // `agent spawn` takes a bare name: the CLI refuses a qualified one.
    if (slash >= 0 && args[1] === "spawn") continue;
    const prefix = slash >= 0 ? ref?.slice(0, slash) : undefined;
    if (ref !== undefined && qualifiedRefProblem(ref) !== undefined) continue;
    // The `--for` agent's own prefix is validated; the dispatch is still
    // the TASK's partition.
    if (forValue !== undefined && qualifiedRefProblem(forValue) !== undefined) continue;
    const dispatched = scopeOf(rootOpts.ws, ws, prefix, injected);
    if (dispatched !== undefined && dispatched !== "scratch") found.add(dispatched);
  }
  return found.size > 0 ? [...found] : undefined;
}

/** A heredoc body to skip: lines up to `delim` (leading tabs stripped with `<<-`). */
type Heredoc = { delim: string; strip: boolean };

/**
 * The words of each shell segment. Quotes group words and are dropped;
 * `&&`, `||`, `;`, `|` and newlines split segments only outside
 * quotes, so a quoted `--evidence 'a | b'` stays one word. A
 * backslash-newline joins lines, and heredoc bodies are skipped: they
 * are data, not commands. A `<<<` here-string and a `<<` shift inside
 * `(( ))` arithmetic do not start a heredoc. As in bash, `((` is
 * arithmetic only when its matching close is `))`; otherwise it is
 * nested subshells, where `<<` is a heredoc. A `#` that starts a word
 * comments out the rest of the line.
 */
export function shellSegments(command: string): string[][] {
  const segs: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  const heredocs: Heredoc[] = [];
  /** Index of the closing `)` of the current `(( ))` arithmetic, where `<<` is a shift. */
  let arithEnd = -1;
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endSeg = () => {
    endWord();
    if (words.length > 0) segs.push(words);
    words = [];
  };
  /** Skip the pending heredoc bodies that start after the newline at `i`;
   *  returns the index of the last newline consumed. */
  const skipHeredocs = (i: number): number => {
    for (const h of heredocs.splice(0)) {
      while (i < command.length) {
        const eol = command.indexOf("\n", i + 1);
        const end = eol < 0 ? command.length : eol;
        const line = command.slice(i + 1, end);
        i = end;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
      }
    }
    return i;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      const end = close < 0 ? command.length : close;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (c === "\\" && command[i + 1] === "\n") {
      i++; // line continuation: neither a word nor a segment break
    } else if (c === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command[++i];
    } else if (c === "#" && word === undefined) {
      const eol = command.indexOf("\n", i);
      i = (eol < 0 ? command.length : eol) - 1; // a comment: the newline still ends the segment
    } else if (c === "(" && command[i + 1] === "(" && i > arithEnd) {
      arithEnd = arithmeticEnd(command, i);
      word = `${word ?? ""}((`;
      i++;
    } else if (command.startsWith("<<<", i)) {
      endWord(); // a here-string: its word is data on the same line
      i += 2;
    } else if (c === "<" && command[i + 1] === "<" && i > arithEnd) {
      // `<<[-] DELIM`: the delimiter may be quoted; its body starts on the next line.
      endWord();
      const m = /^<<(-?)[ \t]*('([^']*)'|"([^"]*)"|[^\s;&|<>()]+)/.exec(command.slice(i));
      if (!m) {
        i++;
        continue;
      }
      const delim = m[3] ?? m[4] ?? (m[2] ?? "").replace(/\\/g, "");
      heredocs.push({ delim, strip: m[1] === "-" });
      i += m[0].length - 1;
    } else if (c === ";" || c === "|" || c === "\n" || (c === "&" && command[i + 1] === "&")) {
      if (c !== ";" && c !== "\n" && command[i + 1] === c) i++;
      endSeg();
      if (c === "\n" && heredocs.length > 0) i = skipHeredocs(i);
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? "") + c;
    }
  }
  endSeg();
  return segs;
}

/**
 * For the `((` at `open`: the index of the `)` that closes it when the
 * matching close is a `))` pair (arithmetic), else -1 (nested
 * subshells, or unclosed). Bash decides `((` the same way.
 */
function arithmeticEnd(command: string, open: number): number {
  let depth = 0;
  for (let i = open + 2; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (c === "\\") {
      i++;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      if (depth > 0) depth--;
      else return command[i + 1] === ")" ? i + 1 : -1;
    }
  }
  return -1;
}

type ListJson = { items?: { name?: string; workstreamName?: string }[] };

/**
 * IN_PROGRESS task refs, one `mu task list --status IN_PROGRESS --json`
 * per workstream (newest first, as `mu state` listed them), all in flight at once. (`mu state` also lists tmux
 * panes and builds orphans; this read needs none of it.
 * `task list` does not reap dead owners, so a task a ghost agent still
 * owns shows until the next `mu state` or `mu task wait` reaps it.)
 * Every workstream is named: mu has no ambient default.
 */
async function inProgress(run: MuRunner, workstreams: string[]): Promise<string[] | undefined> {
  const results = await Promise.all(
    workstreams.map(async (w) => {
      const r = await run([
        "task",
        "list",
        "--status",
        "IN_PROGRESS",
        "--json",
        "--sort",
        "recency",
        "-w",
        w,
      ]);
      if (r.code !== 0) return undefined;
      try {
        const items = (JSON.parse(r.stdout) as ListJson).items ?? [];
        return items.flatMap((t) => (t.name ? [`${t.workstreamName ?? w}/${t.name}`] : []));
      } catch {
        return undefined;
      }
    }),
  );
  if (results.some((r) => r === undefined)) return undefined;
  // Dedupe by qualified ref, keeping first (most recent) position.
  return [...new Set(results.flatMap((r) => r ?? []))];
}

/** The nudge text: the rule verbatim, then the live count and the wait. */
export function nudgeText(rule: string, refs: string[]): string {
  const shown = refs.slice(0, WAIT_HINT_MAX).join(" ");
  const more = refs.length > WAIT_HINT_MAX ? ` (+${refs.length - WAIT_HINT_MAX} more)` : "";
  return [
    `[mu] ${rule}`,
    "",
    `${refs.length} task(s) IN_PROGRESS. Next: mu task wait ${shown} --first --on-stall exit --json${more}`,
  ].join("\n");
}

/** Write a `mu log` breadcrumb without holding the settle for it: the
 *  nudge's message does not depend on the log line. */
function breadcrumb(run: MuRunner, args: string[]): void {
  void run(args).catch(() => {});
}

/** A nudge's settle result. `yielded` undoes the nudge's once-per-prompt
 *  bookkeeping when the merge drops the result for a late hold. */
type SettleResult = { entries?: unknown[]; continue?: boolean; yielded?: () => void } | undefined;
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
 * nudge may fire on a later settle.
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

function bashCommand(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const e = event as { toolName?: unknown; input?: { command?: unknown } };
  return e.toolName === "bash" && typeof e.input?.command === "string"
    ? e.input.command
    : undefined;
}

export function registerNudge(
  pi: MuNudgeApi,
  run: MuRunner = defaultRunner(),
  skillMd: string | undefined = readSkill(),
  nested: NestedCheck = notNested,
  hold: SettleHold = noHold,
): void {
  if (!nudgeEnabled()) return;
  const rule = skillMd === undefined ? undefined : keepDrivingRule(skillMd);
  if (rule === undefined) return; // no markers: nothing true to quote

  const armed = new Set<string>();
  let fired = false;

  pi.on("input", () => {
    armed.clear();
    fired = false;
  });

  pi.on("tool_call", (event) => {
    const cmd = bashCommand(event);
    if (cmd === undefined) return;
    for (const ws of dispatchedWorkstreams(cmd) ?? []) armed.add(ws);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (fired || armed.size === 0 || nested() || hold(ctx)) return;
    if (outcomeOf(event) !== "completed") return; // Esc or an error: stop
    fired = true; // once per prompt, even if the check below fails
    const refs = await inProgress(run, [...armed]);
    if (refs === undefined || refs.length === 0) return;
    if (hold(ctx)) {
      fired = false; // the answer's turn settles again; nudge then if still due
      return;
    }
    const text = nudgeText(rule, refs);
    const logWs = [...armed][0];
    breadcrumb(run, [
      "log",
      ...(logWs ? ["-w", logWs] : []),
      "--kind",
      NUDGE_LOG_KIND,
      `keep-driving: ${refs.length} in progress`,
    ]);
    return {
      entries: [
        { type: "custom_message", customType: NUDGE_MESSAGE_TYPE, content: text, display: true },
      ],
      continue: true,
      yielded: () => {
        fired = false;
      },
    };
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
  const r = await run(["task", "owned-by", agent, "-w", workstream, "--json"]);
  if (r.code !== 0) return undefined;
  try {
    const json = JSON.parse(r.stdout) as { items?: { name?: string; status?: string }[] };
    return (json.items ?? []).flatMap((t) =>
      t.status === "IN_PROGRESS" && t.name ? [t.name] : [],
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
