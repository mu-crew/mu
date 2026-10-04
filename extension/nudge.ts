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
 * Its worker-side twin, the close nudge: a mu-spawned pi worker
 * ($MU_AGENT_NAME + $MU_WORKSTREAM) that settles while it still owns an
 * IN_PROGRESS task is told once to close it or say why not. Same
 * once-per-prompt rule and `MU_NUDGE=0` opt-out.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRunner, type MuRunner } from "./delegate.js";

export const NUDGE_MESSAGE_TYPE = "mu-keep-driving";
export const NUDGE_LOG_KIND = "nudge";
export const CLOSE_NUDGE_MESSAGE_TYPE = "mu-close-task";
const MARK_START = "<!-- mu:keep-driving -->";
const MARK_END = "<!-- /mu:keep-driving -->";
/** Tasks named in the wait hint; the rest are counted, not listed. */
const WAIT_HINT_MAX = 8;

/** The slice of pi's ExtensionAPI the nudge uses. */
export interface MuNudgeApi {
  on(
    event: "tool_call" | "agent_before_settle" | "input",
    handler: (event: unknown, ctx: unknown) => unknown,
  ): unknown;
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

/**
 * The workstreams a bash command dispatches mu work into, or undefined
 * when it dispatches nothing. Dispatch = `mu agent send|spawn`, or
 * `mu task claim ... --for`. `""` stands for the default workstream
 * (resolved by mu itself: $MU_SESSION, then tmux).
 */
export function dispatchedWorkstreams(command: string): string[] | undefined {
  const found = new Set<string>();
  // One mu invocation per shell segment.
  for (const seg of command.split(/&&|\|\||;|\n|\|/)) {
    const words = seg.trim().split(/\s+/);
    const at = words.findIndex((w) => w === "mu" || w.endsWith("/mu"));
    if (at < 0) continue;
    const [noun, verb] = [words[at + 1], words[at + 2]];
    const isSendSpawn = noun === "agent" && (verb === "send" || verb === "spawn");
    const isClaimFor = noun === "task" && verb === "claim" && words.includes("--for");
    if (!isSendSpawn && !isClaimFor) continue;
    let ws = "";
    for (let k = at + 3; k < words.length; k++) {
      const w = words[k] ?? "";
      if (w === "-w" || w === "--workstream") ws = unquote(words[k + 1] ?? "");
      else if (w.startsWith("--workstream=")) ws = unquote(w.slice("--workstream=".length));
    }
    if (ws === "" && isClaimFor) {
      const ref = words[at + 3] ?? "";
      if (ref.includes("/")) ws = unquote(ref.split("/")[0] ?? "");
    }
    if (ws !== "scratch") found.add(ws);
  }
  return found.size > 0 ? [...found] : undefined;
}

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
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
    if (fired || armed.size === 0) return;
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
): void {
  if (!nudgeEnabled(env)) return;
  const me = workerIdentity(env);
  if (me === undefined) return;
  let fired = false;

  pi.on("input", () => {
    fired = false;
  });

  pi.on("agent_before_settle", async (event) => {
    if (fired) return;
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
