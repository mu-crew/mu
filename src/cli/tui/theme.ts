// The dashboard's one palette: named roles -> ink <Text> props, taken from the 3.x
// TUI (v3.13.3: titled-box, list-row, inkColorForPair, format.ts STATUS_COLORS,
// log card, tab strip, drill). Views name a ROLE, never a colour: a re-colour is
// one line here.
//
// NO_COLOR (https://no-color.org/, any defined value, as src/output.ts reads it)
// drops every colour. Ink's chalk does not read it (only FORCE_COLOR and the TTY),
// so the check lives here. Bold, dim and inverse stay: they are not colour, and the
// cursor row and the selected tab must still show.
//
// No state glyphs: 3.x drew Nerd Font codepoints with no ASCII fallback
// (src/glyphs.ts "Requires a Nerd Font"), and Nerd Fonts are not universal.

import { DEFAULT_SUBSTATE, isTaskStatus } from "../../tasks/status.js";

export interface TextStyle {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

const STYLES = {
  /** Plain text (titles in lists, prose). */
  text: {},
  /** Frame borders (rounded, gray). */
  border: { color: "gray" },
  /** A frame's title, the selected tab and workstream. */
  title: { color: "cyan", bold: true },
  /** Secondary text: subtitles, `+N more`, owners, times, hosts, hint, filter, next. */
  muted: { dimColor: true },
  /** A row's id or name. */
  id: { bold: true },
  /** Emphasis without colour: a drill's pinned notice (an attach failure). */
  strong: { bold: true },
  /** A log line's verb. */
  verb: { color: "cyan" },
  /** A drill's title line. */
  heading: { color: "magenta", bold: true },
  /** Task OPEN (ready). */
  open: { color: "cyan" },
  /** Task OPEN/parked and OPEN/triage: out of the ready set. */
  parked: { color: "gray" },
  /** Task IN_PROGRESS. */
  progress: { color: "yellow" },
  /** Task CLOSED/done. */
  done: { color: "green" },
  /** Task CLOSED as anything but done (wontfix, duplicate, superseded). */
  undone: { color: "red" },
  /** Agent busy. */
  busy: { color: "cyan" },
  /** Agent waiting on a permission dialog. */
  permission: { color: "magenta" },
  /** "all quiet". */
  good: { color: "green" },
  /** Needs a look: an attention item, a stalled tool, a sync warning. */
  warn: { color: "yellow" },
  /** Broken: a dead agent, an error. */
  bad: { color: "red" },
} as const satisfies Record<string, TextStyle>;

export type Role = keyof typeof STYLES;

/** A run of text drawn in one role; a line is a list of them. */
export interface Seg {
  text: string;
  role?: Role;
}

/** Colour is on unless NO_COLOR is set (read per call so a test can flip it). */
const colorOn = (): boolean => process.env.NO_COLOR === undefined;

/** The ink props for `role`, without colour under NO_COLOR. */
export function style(role: Role = "text"): TextStyle {
  const s: TextStyle = STYLES[role];
  if (colorOn() || s.color === undefined) return s;
  const { color: _, ...rest } = s;
  return rest;
}

/** A task's (status, substate) pair, as 3.x's inkColorForPair. */
export function statusRole(status: string, substate: string): Role {
  if (status === "OPEN") return substate === "parked" || substate === "triage" ? "parked" : "open";
  if (status === "IN_PROGRESS") return "progress";
  if (status === "CLOSED") {
    const dflt = isTaskStatus(status) ? DEFAULT_SUBSTATE[status] : "done";
    return substate === "" || substate === dflt ? "done" : "undone";
  }
  return "text";
}

/** An agent's state (a `RuntimeState`), as 3.x's STATUS_COLORS: idle and unknown are muted. */
export function agentStateRole(state: string | null | undefined): Role {
  if (state === "busy") return "busy";
  if (state === "needs_permission") return "permission";
  return "muted";
}

/** A note's kind (`NOTE_KINDS`): the brief and the report stand out, a verdict needs a look. */
export function noteKindRole(kind: string): Role {
  if (kind === "brief") return "title";
  if (kind === "report" || kind === "close") return "good";
  if (kind === "verdict") return "warn";
  return "id";
}
