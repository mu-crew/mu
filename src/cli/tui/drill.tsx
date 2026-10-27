// The drills: one full-screen, read-only, scrollable body per Enter.
//   notes      a task's notes (the CLI's default selection; `A` = all), whole
//   scrollback an agent's pane tail (captured through the active mux)
//   log        one op of the canonical log, every field
// Keys are this component's alone while it is mounted (App's input is off), so a
// press is consumed once and Esc returns to the tab with its filters untouched.
// Plain text only: bodies are cleaned, then wrapped by visual width (never ANSI in <Text>);
// colour comes from theme roles as ink props.
// A load is guarded: a result that lands after Esc (or for an older `r`) is dropped.

import { Box, Text, useInput, useStdout, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { activeMux } from "../../mux.js";
import type { SelectedNotes } from "../../tasks.js";
import { copyCommand, planAttach, yankSequence } from "./commands.js";
import { Segs } from "./frame.js";
import { NAV_HINT, navKey } from "./nav.js";
import type { DrillTarget } from "./rows.js";
import type { DashboardRuntime } from "./runtime.js";
import { cell, clean, fitLine, type Line } from "./text.js";
import { style } from "./theme.js";

/** Lines of scrollback a drill captures (the tail; the pane has more). */
export const SCROLLBACK_LINES = 2000;
const END = Number.MAX_SAFE_INTEGER;

const segmenter = new Intl.Segmenter();

/**
 * `text` as screen lines of at most `width` columns: split on newlines, cleaned of
 * escapes and control characters, broken at the last space that fits (else
 * mid-word, by grapheme). Plain text out, so no line is ever re-measured with ANSI in it.
 */
export function wrap(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    let cur = "";
    let curW = 0;
    let breakAt = -1; // index in `cur` just after the last space that follows content
    let broke = false;
    for (const { segment } of segmenter.segment(clean(raw.replace(/\t/g, "    ")))) {
      const sw = stringWidth(segment);
      if (curW + sw > max) {
        if (segment === " ") {
          // The space itself overflows: the line ends cleanly here.
          out.push(cur.trimEnd());
          cur = "";
          curW = 0;
          breakAt = -1;
          broke = true;
          continue;
        }
        if (breakAt > 0) {
          out.push(cur.slice(0, breakAt).trimEnd());
          cur = cur.slice(breakAt);
        } else {
          if (cur !== "") out.push(cur);
          cur = "";
        }
        curW = stringWidth(cur);
        breakAt = -1;
        broke = true;
      }
      if (broke && cur === "" && segment === " ") continue; // no space opens a continuation
      cur += segment;
      curW += sw;
      if (segment === " " && cur.trim() !== "") breakAt = cur.length;
    }
    out.push(cur.trimEnd());
  }
  return out;
}

/** The first visible line of a scrolled body: `top` held inside `[0, count - height]`. */
export const clampTop = (top: number, count: number, height: number): number =>
  Math.max(0, Math.min(top, count - Math.max(1, height)));

/** The notes as one text: a header line per note (`*` = pinned content), then the whole content. */
export function notesText(sel: SelectedNotes): string {
  return sel.notes
    .map(
      (n) =>
        `#${n.n}  ${n.kind}${sel.pinned.includes(n.n) ? " *" : ""}  ${n.author ?? "-"}  ${n.createdAt}\n${n.content}\n`,
    )
    .join("\n");
}

export function titleOf(t: DrillTarget): string {
  switch (t.kind) {
    case "notes":
      return `Notes  ${t.workstream}/${t.id}  ${t.title}`;
    case "scrollback":
      return `Scrollback  ${t.workstream}/${t.name}  ${t.paneId}  (last ${SCROLLBACK_LINES} lines)`;
    case "log":
      return `Log  #${t.item.seq}`;
  }
}

function logText(t: Extract<DrillTarget, { kind: "log" }>): string {
  const i = t.item;
  return [
    t.item.rendered,
    "",
    `seq: ${i.seq}`,
    `time: ${i.created_at}`,
    `scope: ${t.item.scope ?? "-"}`,
    `actor: ${i.actor}`,
    `intent: ${i.intent ?? "-"}`,
    `op: ${i.op}`,
    `entity: ${i.entity}`,
    `key: ${i.key === "" ? "-" : i.key}`,
    `payload: ${i.payload}`,
    ...(i.cut !== undefined && i.cut > 0 ? [`(${i.cut} characters cut from this item)`] : []),
  ].join("\n");
}

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; text: string; notices: string[] };

/**
 * Copy a target's command with OSC 52 and say what happened: the command is always
 * in the message. A scrollback copies the attach line for a shell OUTSIDE any client
 * (its absence is said, then `mu agent read` is copied instead).
 */
export function useYank(): (target: DrillTarget, all?: boolean) => Promise<string> {
  const { stdout } = useStdout();
  return async (target, all = false) => {
    const plan = target.kind === "scrollback" ? await planAttach(target) : null;
    const command = copyCommand(target, { all, attachLine: plan?.line ?? null });
    const y = yankSequence(command);
    const why = plan !== null && !plan.ok ? `  (attach unavailable: ${plan.reason})` : "";
    if (!y.ok) return `not copied (${y.why}): ${command}${why}`;
    stdout.write(y.sequence);
    return `copied: ${command}${why}`;
  };
}

export interface DrillProps {
  target: DrillTarget;
  runtime: DashboardRuntime;
  /** Lines pinned under the title, outside the scrolled body (an attach failure and the outside-client line). */
  notice: readonly string[];
  /** The dashboard's attention strip, shown under the title (null: none). */
  strip?: Line | null;
  /** True while the terminal belongs to an attach: a key is ignored (the hook stays active). */
  busy: { readonly current: boolean };
  onClose(): void;
  onAttach(target: Extract<DrillTarget, { kind: "scrollback" }>): void;
}

export function Drill({
  target,
  runtime,
  notice,
  strip = null,
  busy,
  onClose,
  onAttach,
}: DrillProps) {
  const { columns, rows } = useWindowSize();
  const yank = useYank();
  const [all, setAll] = useState(false);
  const [reload, setReload] = useState(0);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [flash, setFlash] = useState<string | null>(null);
  const [top, setTop] = useState(target.kind === "scrollback" ? END : 0);
  const topSeen = useRef(0);

  // One guarded load per (target, all, reload): the cleanup drops a late result.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` only re-runs the effect
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    const done = (l: Load): void => {
      if (live) setLoad(l);
    };
    try {
      if (target.kind === "notes") {
        const sel = runtime.notes(target.workstream, target.id, all);
        done({
          state: "ready",
          text: sel.notes.length === 0 ? "(no notes)" : notesText(sel),
          notices:
            sel.more > 0
              ? [`${sel.more} of ${sel.total} notes not shown: A shows them all (oldest first)`]
              : [],
        });
      } else if (target.kind === "log") {
        done({ state: "ready", text: logText(target), notices: [] });
      } else {
        void (async () => {
          try {
            const mux = await activeMux();
            const text = await mux.capture(target.paneId, { lines: SCROLLBACK_LINES });
            done({ state: "ready", text: text.replace(/\s+$/, ""), notices: [] });
          } catch (e) {
            done({ state: "error", message: e instanceof Error ? e.message : String(e) });
          }
        })();
      }
    } catch (e) {
      done({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
    return () => {
      live = false;
    };
  }, [target, runtime, all, reload]);

  const lines = useMemo(() => {
    const above = [...notice, ...(flash === null ? [] : [flash])];
    const head = [...(load.state === "ready" ? load.notices : []), ...above].flatMap((l) =>
      wrap(l, columns),
    );
    const body =
      load.state === "loading"
        ? ["loading…"]
        : load.state === "error"
          ? wrap(`error: ${load.message}`, columns)
          : wrap(load.text, columns);
    return { head, body };
  }, [load, notice, flash, columns]);

  // The head (notices, attach failure, yank confirmation) is pinned under the title, never part of
  // the scrolled body: a long scrollback opens at its END and must not push the reason out of view.
  // It takes at most half of the room, so the body always keeps some rows.
  // The strip (title + strip + hint + one body row) needs 4 rows; shorter screens drop it.
  const showStrip = strip !== null && rows >= 4;
  const room = Math.max(0, rows - 1 - (rows >= 3 ? 1 : 0) - (showStrip ? 1 : 0));
  const pinned = lines.head.slice(0, Math.floor(room / 2));
  const height = room - pinned.length;
  const first = clampTop(top, lines.body.length, height);
  topSeen.current = first;
  const hint =
    target.kind === "notes"
      ? `${NAV_HINT} scroll  A all notes  r reload  y copy cmd  Esc back`
      : target.kind === "scrollback"
        ? `${NAV_HINT} scroll  r reload  a attach  y copy cmd  Esc back`
        : `${NAV_HINT} scroll  y copy cmd  Esc back`;

  useInput((input, key) => {
    if (busy.current) return;
    setFlash(null);
    const at = topSeen.current;
    if (key.escape || input === "q") return onClose();
    const nav = navKey(input, key, height, true);
    if (nav !== null) setTop("by" in nav ? Math.max(0, at + nav.by) : nav.to === "top" ? 0 : END);
    else if (input === "r") setReload((n) => n + 1);
    else if (input === "A" && target.kind === "notes") setAll((a) => !a);
    else if (input === "a" && target.kind === "scrollback") onAttach(target);
    else if (input === "y") void yank(target, all).then(setFlash);
  });

  const visible = lines.body.slice(first, first + height);
  const where =
    lines.body.length === 0
      ? ""
      : `${first + 1}-${Math.min(lines.body.length, first + height)}/${lines.body.length}  `;
  return (
    // Exactly `rows` lines: a short body is followed by the spacer, so the hint stays on the last row.
    <Box flexDirection="column" height={rows}>
      <Text wrap="truncate" {...style("heading")}>
        {cell(titleOf(target), columns)}
      </Text>
      {showStrip ? (
        <Text wrap="truncate">
          <Segs line={fitLine(strip, columns)} />
        </Text>
      ) : null}
      {pinned.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity; the index IS the position
        <Text key={`p${i}`} wrap="truncate" {...style("strong")}>
          {cell(l, columns)}
        </Text>
      ))}
      {visible.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity; the index IS the position
        <Text key={first + i} wrap="truncate" {...style(load.state === "error" ? "bad" : "text")}>
          {cell(l, columns)}
        </Text>
      ))}
      <Box flexGrow={1} />
      {rows >= 3 ? (
        <Text wrap="truncate" {...style("muted")}>
          {cell(`${where}${hint}`, columns)}
        </Text>
      ) : null}
    </Box>
  );
}
