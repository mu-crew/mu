// A rounded frame with its title and count in the top border and an overflow
// note in the bottom border (3.x titled-box, without ink's border machinery):
//
//   ╭─ Agents · 3 ───────────╮
//   │ worker-1  busy         │
//   ╰─ +2 more ──────────────╯
//
// `frameLines` is pure text so a test can pin the geometry; `<Frame>` draws the
// same lines in theme roles (gray border, bold cyan title, dim subtitle and
// bottom note; the cursor row solid inverse). Always `height` lines tall.

import { Box, Text } from "ink";
import type { ReactElement } from "react";
import stringWidth from "string-width";
import { cell, clean, fitLine, type Line } from "./text.js";
import { type Seg, style } from "./theme.js";

/** Border rows a frame adds around its body (top + bottom). */
export const FRAME_CHROME = 2;
/** Columns it adds on each row (border + one space of padding, both sides). */
export const FRAME_SIDES = 4;

export interface FrameSpec {
  /** Outer width in columns. */
  width: number;
  /** Outer height in lines: body rows are `height - FRAME_CHROME`. */
  height: number;
  title: string;
  /** Dim text after the title, e.g. a count. */
  subtitle?: string;
  /** Inside the bottom border, e.g. `+N more` or `12/197`. */
  bottom?: string;
}

/** A border line split around its label: `╭─ ` + label + ` ───╮`. */
function borderParts(
  width: number,
  left: string,
  right: string,
  label: string,
): { head: string; shown: string; tail: string } {
  if (width < 2) return { head: "─".repeat(Math.max(0, width)), shown: "", tail: "" };
  const inner = width - 2;
  const text = clean(label);
  if (text === "") return { head: left + "─".repeat(inner) + right, shown: "", tail: "" };
  const room = Math.max(0, inner - 4); // "─ " + label + " " + at least one dash
  const shown = stringWidth(text) <= room ? text : cell(text, room).trimEnd();
  const fill = "─".repeat(Math.max(1, inner - 3 - stringWidth(shown)));
  return { head: `${left}─ `, shown, tail: ` ${fill}${right}` };
}

/** A border line: `╭─ label ───╮`, the label cut to fit, the fill at least one dash. */
export function borderLine(width: number, left: string, right: string, label: string): string {
  const { head, shown, tail } = borderParts(width, left, right, label);
  return head + shown + tail;
}

/** The three parts of a frame; `rows` are the bodies between the side borders. */
export function frameParts(
  spec: FrameSpec,
  body: ReadonlyArray<string>,
): { top: string; rows: string[]; bottom: string } {
  const label = spec.subtitle ? `${spec.title} · ${spec.subtitle}` : spec.title;
  const rows = Math.max(0, spec.height - FRAME_CHROME);
  const room = Math.max(0, spec.width - FRAME_SIDES);
  return {
    top: borderLine(spec.width, "╭", "╮", label),
    rows: Array.from({ length: rows }, (_, i) => cell(body[i] ?? "", room)),
    bottom: borderLine(spec.width, "╰", "╯", spec.bottom ?? ""),
  };
}

/** The frame as exactly `height` lines of exactly `width` columns; `body` is cut or padded to fit. */
export function frameLines(spec: FrameSpec, body: ReadonlyArray<string>): string[] {
  if (spec.height < FRAME_CHROME || spec.width < FRAME_SIDES) return [];
  const { top, rows, bottom } = frameParts(spec, body);
  return [top, ...rows.map((r) => `│ ${r} │`), bottom];
}

export interface FrameProps extends FrameSpec {
  /** One entry per body row: plain text, or a line in theme roles. */
  body: ReadonlyArray<string | Line>;
  /** Body row drawn solid inverse (the cursor), its roles dropped as in 3.x. */
  selected?: number;
}

/** Runs of one line as ink <Text>s, each in its role. */
export function Segs({ line }: { line: ReadonlyArray<Seg> }): ReactElement {
  return (
    <>
      {line.map((seg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs of one line are positional
        <Text key={i} {...style(seg.role)}>
          {seg.text}
        </Text>
      ))}
    </>
  );
}

/** A border line in roles: the title bold cyan, ` · ` border, the rest (count, `+N more`) dim. */
function borderSegs(
  width: number,
  left: string,
  right: string,
  title: string,
  rest: string,
): Seg[] {
  const label = title !== "" && rest !== "" ? `${title} · ${rest}` : title || rest;
  const { head, shown, tail } = borderParts(width, left, right, label);
  const t = title === "" ? 0 : Math.min(shown.length, clean(title).length);
  const sep = title !== "" && rest !== "" ? shown.slice(t, t + 3) : "";
  const parts: Seg[] = [
    { text: head, role: "border" },
    { text: shown.slice(0, t), role: "title" },
    { text: sep, role: "border" },
    { text: shown.slice(t + sep.length), role: "muted" },
    { text: tail, role: "border" },
  ];
  return parts.filter((p) => p.text !== "");
}

export function Frame({ body, selected, ...spec }: FrameProps): ReactElement | null {
  if (spec.height < FRAME_CHROME || spec.width < FRAME_SIDES) return null;
  const rows = Math.max(0, spec.height - FRAME_CHROME);
  const room = Math.max(0, spec.width - FRAME_SIDES);
  const lineOf = (b: string | Line | undefined): Line =>
    typeof b === "string" ? [{ text: b }] : (b ?? []);
  return (
    <Box flexDirection="column" width={spec.width} height={spec.height} flexShrink={0}>
      <Text wrap="truncate">
        <Segs line={borderSegs(spec.width, "╭", "╮", spec.title, spec.subtitle ?? "")} />
      </Text>
      {Array.from({ length: rows }, (_, i) => {
        const fitted = fitLine(lineOf(body[i]), room);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-height frame, rows are positional
          <Text key={i} wrap="truncate">
            <Text {...style("border")}>│ </Text>
            {i === selected ? (
              <Text inverse>{fitted.map((s) => s.text).join("")}</Text>
            ) : (
              <Segs line={fitted} />
            )}
            <Text {...style("border")}> │</Text>
          </Text>
        );
      })}
      <Text wrap="truncate">
        <Segs line={borderSegs(spec.width, "╰", "╯", "", spec.bottom ?? "")} />
      </Text>
    </Box>
  );
}
