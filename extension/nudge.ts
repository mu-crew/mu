/**
 * mu pi extension: the keep-driving nudge (docs/specs/2026-10-03-keep-driving-nudge.md).
 *
 * An orchestrator that dispatched mu work and then ends its turn while
 * that work is still IN_PROGRESS gets ONE visible message quoting the
 * skill's keep-driving rule, and one continuation. If it stops again,
 * that stop stands. Not a goal loop: no re-check, no counter.
 *
 * Its only read is `mu state --json`, its only write `mu log --kind
 * nudge`; the armed set and fired flag are per-prompt scratch. The rule
 * text lives in skills/mu/SKILL.md between the keep-driving markers.
 *
 * The refute nudge: `mu task claim <id> --for` on a task whose notes
 * carry no line starting `REFUTER `, `VERDICT:` or `REFUTE-EXEMPT:`
 * (read with `mu task notes --json`) gets ONE visible message per prompt
 * listing those tasks. It informs, never continues; `review_*` tasks
 * are exempt (their brief is the fixed reviewer template).
 *
 * Its worker-side twin, the close nudge: a mu-spawned pi worker
 * ($MU_AGENT_NAME + $MU_WORKSTREAM) that settles while it still owns an
 * IN_PROGRESS task is told once to close it or say why not. Same
 * once-per-prompt rule and `MU_NUDGE=0` opt-out.
 *
 * None fire in a nested pi (mu-pi.ts decides at bind); close and refute
 * also skip a pi with no UI (`pi -p`, json), where nobody can answer.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRunner, type MuRunner } from "./delegate.js";

export const NUDGE_MESSAGE_TYPE = "mu-keep-driving";
export const NUDGE_LOG_KIND = "nudge";
export const CLOSE_NUDGE_MESSAGE_TYPE = "mu-close-task";
export const REFUTE_NUDGE_MESSAGE_TYPE = "mu-refute-brief";
const MARK_START = "<!-- mu:keep-driving -->";
const MARK_END = "<!-- /mu:keep-driving -->";
/** Tasks named in the wait hint; the rest are counted, not listed. */
const WAIT_HINT_MAX = 8;

/** The slice of pi's ExtensionContext the nudge reads. */
export type MuNudgeCtx = { mode?: string; hasUI?: boolean };

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

/**
 * The workstreams a bash command dispatches mu work into, or undefined
 * when it dispatches nothing. Dispatch = `mu agent send|spawn`, or
 * `mu task claim <id> --for` (parsed by claimOf, as the refute nudge
 * does). `""` stands for the default workstream (resolved by mu
 * itself: $MU_SESSION, then tmux).
 */
export function dispatchedWorkstreams(command: string): string[] | undefined {
  const found = new Set<string>();
  // One mu invocation per shell segment.
  for (const words of shellSegments(command)) {
    const args = muArgs(words);
    if (args === undefined) continue;
    const claim = claimOf(args);
    if (claim !== undefined) {
      if (claim.ws !== "scratch") found.add(claim.ws);
      continue;
    }
    if (args[0] !== "agent" || (args[1] !== "send" && args[1] !== "spawn")) continue;
    let ws = "";
    for (let k = 2; k < args.length; k++) {
      const w = args[k] ?? "";
      if (w === "-w" || w === "--workstream") ws = args[k + 1] ?? "";
      else if (w.startsWith("--workstream=")) ws = w.slice("--workstream=".length);
    }
    if (ws !== "scratch") found.add(ws);
  }
  return found.size > 0 ? [...found] : undefined;
}

/** Claim options that take a value; the task id is the first other positional. */
const CLAIM_VALUE_OPTS = new Set(["--for", "-f", "-w", "--workstream", "--evidence", "--actor"]);

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

/** The task a `mu task claim <id> --for` dispatches, from the args after
 *  `mu`, as `{ ws, id }`; undefined for any other mu command. */
function claimOf(args: string[]): { ws: string; id: string } | undefined {
  if (args[0] !== "task" || args[1] !== "claim") return undefined;
  let ws = "";
  let id: string | undefined;
  let isFor = false;
  for (let k = 2; k < args.length; k++) {
    const w = args[k] ?? "";
    const [opt, eq] = w.startsWith("--") && w.includes("=") ? w.split("=", 2) : [w, undefined];
    if (opt === "--for" || opt === "-f") isFor = true;
    if (opt === "-w" || opt === "--workstream") ws = eq ?? args[k + 1] ?? "";
    if (CLAIM_VALUE_OPTS.has(opt ?? "")) {
      if (eq === undefined) k++;
    } else if (id === undefined && !w.startsWith("-")) id = w;
  }
  if (!isFor || id === undefined) return undefined;
  const slash = id.indexOf("/");
  if (slash >= 0) {
    if (ws === "") ws = id.slice(0, slash);
    id = id.slice(slash + 1);
  }
  return { ws, id };
}

/**
 * The tasks a bash command dispatches with `mu task claim <id> --for`,
 * as `{ ws, id }`. `ws` is `""` for the default workstream; a qualified
 * `<ws>/<id>` splits. `scratch` is skipped, like dispatchedWorkstreams.
 */
export function dispatchedTasks(command: string): { ws: string; id: string }[] {
  const out: { ws: string; id: string }[] = [];
  for (const words of shellSegments(command)) {
    const args = muArgs(words);
    const claim = args === undefined ? undefined : claimOf(args);
    if (claim !== undefined && claim.ws !== "scratch") out.push(claim);
  }
  return out;
}

type Card = { workstreamName?: string; inProgress?: { name?: string }[] };
/** `mu state --json` prints one bare card for one workstream, and
 *  `{ workstreams: [...] }` for several (or none named). */
type StateJson = Card & { workstreams?: Card[] };

/** IN_PROGRESS task refs per workstream, from `mu state --json`. */
async function inProgress(run: MuRunner, workstreams: string[]): Promise<string[] | undefined> {
  const named = workstreams.filter((w) => w !== "");
  const args = ["state", "--json", "--events", "0"];
  for (const w of named) args.push("-w", w);
  const r = await run(args);
  if (r.code !== 0) return undefined;
  let json: StateJson;
  try {
    json = JSON.parse(r.stdout) as StateJson;
  } catch {
    return undefined;
  }
  const cards = json.workstreams ?? [json];
  const refs: string[] = [];
  for (const ws of cards) {
    for (const t of ws.inProgress ?? []) {
      if (t.name) refs.push(`${ws.workstreamName ?? ""}/${t.name}`);
    }
  }
  return refs;
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

  pi.on("agent_before_settle", async (event) => {
    if (fired || armed.size === 0 || nested()) return;
    if (outcomeOf(event) !== "completed") return; // Esc or an error: stop
    fired = true; // once per prompt, even if the check below fails
    const refs = await inProgress(run, [...armed]);
    if (refs === undefined || refs.length === 0) return;
    const text = nudgeText(rule, refs);
    const logWs = [...armed].find((w) => w !== "");
    await run([
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
): void {
  if (!nudgeEnabled(env)) return;
  const me = workerIdentity(env);
  if (me === undefined) return;
  let fired = false;

  pi.on("input", () => {
    fired = false;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (fired || nested() || noUI(ctx)) return; // nested: workerIdentity is the parent's
    if (outcomeOf(event) !== "completed") return;
    fired = true;
    const names = await ownedInProgress(run, me.agent, me.workstream);
    if (names === undefined || names.length === 0) return;
    await run([
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
    };
  });
}

/** A note counts as a refute decision only when a line starts with a marker. */
const REFUTE_MARK = /^(REFUTER |VERDICT:|REFUTE-EXEMPT:)/m;

/** True when the task's notes hold a refute decision; undefined if unreadable. */
async function briefRefuted(run: MuRunner, ws: string, id: string): Promise<boolean | undefined> {
  const r = await run(["task", "notes", id, ...(ws ? ["-w", ws] : []), "--json"]);
  if (r.code !== 0) return undefined;
  try {
    const json = JSON.parse(r.stdout) as { items?: { content?: string }[] };
    return (json.items ?? []).some((n) => REFUTE_MARK.test(n.content ?? ""));
  } catch {
    return undefined;
  }
}

/** The refute-nudge text: name each task and the two ways out. */
export function refuteNudgeText(refs: string[]): string {
  return `[mu] dispatched ${refs.join(", ")} with an unrefuted brief: refute it (delegate, record) or note REFUTE-EXEMPT: <why>`;
}

export function registerRefuteNudge(
  pi: MuNudgeApi,
  run: MuRunner = defaultRunner(),
  nested: NestedCheck = notNested,
): void {
  if (!nudgeEnabled()) return;
  const armed = new Map<string, { ws: string; id: string }>();
  let fired = false;

  pi.on("input", () => {
    armed.clear();
    fired = false;
  });

  pi.on("tool_call", (event) => {
    const cmd = bashCommand(event);
    if (cmd === undefined) return;
    for (const t of dispatchedTasks(cmd)) {
      if (!t.id.startsWith("review_")) armed.set(`${t.ws}/${t.id}`, t);
    }
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (fired || armed.size === 0 || nested() || noUI(ctx)) return;
    if (outcomeOf(event) !== "completed") return;
    fired = true;
    const refs: string[] = [];
    for (const [ref, t] of armed) {
      if ((await briefRefuted(run, t.ws, t.id)) === false) refs.push(ref);
    }
    if (refs.length === 0) return;
    const logWs = [...armed.values()].find((t) => t.ws !== "")?.ws;
    await run([
      "log",
      ...(logWs ? ["-w", logWs] : []),
      "--kind",
      NUDGE_LOG_KIND,
      `refute: ${refs.join(", ")}`,
    ]);
    return {
      entries: [
        {
          type: "custom_message",
          customType: REFUTE_NUDGE_MESSAGE_TYPE,
          content: refuteNudgeText(refs),
          display: true,
        },
      ],
    };
  });
}
