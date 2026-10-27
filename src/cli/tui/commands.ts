// What the dashboard may RUN or COPY, and nothing else. Pure of React.
//
//   - attach: `mux.attachCommands` gives ordered argv steps, not a launcher. They run
//     only on an explicit `a` (never on Enter, never on a poll), in order, with the
//     socket/session routing the backend put in the argv. A required step that fails
//     stops the rest; an optional one is reported and skipped. Any failure is a
//     REASON the caller shows next to the scrollback it falls back to.
//   - yank: the exact command, as an OSC 52 clipboard sequence (no clipboard
//     dependency). The command is also printed on screen, so a terminal that ignores
//     OSC 52 loses nothing. Control characters are refused: a pasted newline runs.

import { spawn } from "node:child_process";
import { activeMux, attachShellLine, type MuxCommand, tmuxAttachMode } from "../../mux.js";
import { shellWord } from "../../shell-quote.js";
import type { DrillTarget } from "./rows.js";

/** Which agent to attach to: its workstream, name and tab (window), as `mu agent spawn` reports them. */
export interface AttachSubject {
  workstream: string;
  name: string;
  tab: string | null;
}

export type AttachPlan =
  | {
      ok: true;
      /** Run these, in order (inside a client of the mux: the switch, else the blocking attach). */
      steps: readonly MuxCommand[];
      /** The line for a shell OUTSIDE any client; what `y` copies. */
      line: string;
      /** One line for the terminal before it is handed over: where to, and how to get back. */
      notice: string;
    }
  | { ok: false; reason: string; line: null };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Inside a client of the mux? `$TMUX` set (herdr decides itself). Whether that client is on
 *  mu's own server is the backend's call (`tmux.ts` `attachCommands`: switch or nest). */
export const insideClient = (): boolean => Boolean(process.env.TMUX);

/** How to get back from an attach, by backend and where the caller runs. */
function backHint(backend: string): { short: string; text: string } {
  if (backend !== "tmux") return { short: "", text: "" };
  switch (tmuxAttachMode()) {
    case "switch":
      return { short: "back: C-b L", text: "back: C-b L" };
    case "nested":
      return { short: "detach: C-b C-b d", text: "detach: C-b d (nested: C-b C-b d)" };
    case "plain":
      return { short: "detach: C-b d", text: "detach: C-b d (nested: C-b C-b d)" };
  }
}

/** The Agents footer's attach key, with how to come back. */
export async function attachKeyHint(): Promise<string> {
  try {
    const { short } = backHint((await activeMux()).name);
    return short === "" ? "a attach" : `a attach (${short})`;
  } catch {
    return "a attach";
  }
}

/** Ask the active backend for the attach steps; a backend that cannot (no mux, no workspace) is a reason. */
export async function planAttach(t: AttachSubject): Promise<AttachPlan> {
  try {
    const mux = await activeMux();
    const target = { session: `mu-${t.workstream}`, window: t.tab ?? t.name };
    const inside = insideClient();
    const steps = await mux.attachCommands({ ...target, inside });
    // The copied line is for a shell outside any client, whatever this one is inside of.
    const outside = await mux.attachCommands({ ...target, inside: false, outside: true });
    const { text } = backHint(mux.name);
    const notice = `attaching ${target.session}:${target.window}${text === "" ? "" : ` · ${text}`}`;
    return { ok: true, steps, line: attachShellLine(outside), notice };
  } catch (e) {
    return { ok: false, reason: message(e), line: null };
  }
}

export interface StepResult {
  /** Exit status; null when it never ran or died on a signal. */
  code: number | null;
  /** Why it never ran (spawn error, e.g. ENOENT). */
  error?: string;
  /** The tail of its stderr. */
  stderr: string;
}

/** Runs one argv with the terminal handed over (stdin/stdout inherited, stderr kept for the reason). */
export type StepRunner = (step: MuxCommand) => Promise<StepResult>;

export const spawnStep: StepRunner = (step) =>
  new Promise((resolve) => {
    let stderr = "";
    // A nested client is deliberate: tmux refuses an attach while `$TMUX` is set.
    const env = { ...process.env };
    if (step.nested === true) delete env.TMUX;
    const child = spawn(step.command, [...step.args], {
      stdio: ["inherit", "inherit", "pipe"],
      env,
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-400);
    });
    child.on("error", (e) => resolve({ code: null, error: e.message, stderr }));
    child.on("close", (code) => resolve({ code, stderr }));
  });

export interface AttachResult {
  ok: boolean;
  /** Set when `!ok`: which step failed and why. */
  reason?: string;
  /** Optional steps that failed (their own `reason` when they have one). */
  warnings: string[];
}

const wordsOf = (step: MuxCommand): string => [step.command, ...step.args].map(shellWord).join(" ");

/** The steps in order, with `attachShellLine`'s semantics: a required failure stops, an optional one does not. */
export async function runAttach(
  steps: readonly MuxCommand[],
  run: StepRunner,
): Promise<AttachResult> {
  const warnings: string[] = [];
  for (const step of steps) {
    let r: StepResult;
    try {
      r = await run(step);
    } catch (e) {
      r = { code: null, error: message(e), stderr: "" };
    }
    if (r.code === 0) continue;
    const why =
      r.error ?? `exit ${r.code ?? "?"}${r.stderr.trim() === "" ? "" : `: ${r.stderr.trim()}`}`;
    if (step.optional === true) {
      warnings.push(`${step.reason ?? wordsOf(step)} (${why})`);
      continue;
    }
    return { ok: false, reason: `${wordsOf(step)} failed (${why})`, warnings };
  }
  return { ok: true, warnings };
}

/** OSC 52 payloads past this are refused: terminals cap them, and a huge "command" is not one. */
export const YANK_MAX_BYTES = 1024;

// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the control-character guard
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The OSC 52 sequence that copies `command`, or why it will not be copied. */
export function yankSequence(
  command: string,
): { ok: true; sequence: string } | { ok: false; why: string } {
  if (CONTROL.test(command)) return { ok: false, why: "it has control characters" };
  if (Buffer.byteLength(command) > YANK_MAX_BYTES) return { ok: false, why: "it is too long" };
  return { ok: true, sequence: `\u001b]52;c;${Buffer.from(command).toString("base64")}\u0007` };
}

/** The `mu` command a drill's copy key yields (the exact line shown beside it). */
export function copyCommand(
  t: DrillTarget,
  opts: { all?: boolean; attachLine?: string | null } = {},
): string {
  switch (t.kind) {
    case "notes":
      return `mu task show ${shellWord(t.id)} -w ${shellWord(t.workstream)}${opts.all === true ? " --all" : ""}`;
    case "scrollback":
      return opts.attachLine ?? `mu agent read ${shellWord(t.name)} -w ${shellWord(t.workstream)}`;
    case "log":
      return `mu log --all --since ${Math.max(0, t.item.seq - 1)} -n 1`;
  }
}
