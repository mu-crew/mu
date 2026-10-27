// A rounded frame with its title and count in the top border and an overflow
// note in the bottom border (3.x titled-box, without ink's border machinery):
//
//   ╭─ Agents · 3 ───────────╮
//   │ worker-1  busy         │
//   ╰─ +2 more ──────────────╯
//
// `frameLines` is pure text so a test can pin the geometry; `<Frame>` only
// hands each line to ink as one plain <Text>. Always `height` lines tall.

import { Box, Text } from "ink";
import type { ReactElement } from "react";
import stringWidth from "string-width";
import { cell, clean } from "./text.js";

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

/** A border line: `╭─ label ───╮`, the label cut to fit, the fill at least one dash. */
export function borderLine(width: number, left: string, right: string, label: string): string {
  if (width < 2) return "─".repeat(Math.max(0, width));
  const inner = width - 2;
  const text = clean(label);
  if (text === "") return left + "─".repeat(inner) + right;
  const room = Math.max(0, inner - 4); // "─ " + label + " " + at least one dash
  const shown = stringWidth(text) <= room ? text : cell(text, room).trimEnd();
  return `${left}─ ${shown} ${"─".repeat(Math.max(1, inner - 3 - stringWidth(shown)))}${right}`;
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
  /** One entry per body row; plain text. */
  body: ReadonlyArray<string>;
  borderColor?: string;
}

export function Frame({ body, borderColor = "gray", ...spec }: FrameProps): ReactElement | null {
  if (spec.height < FRAME_CHROME || spec.width < FRAME_SIDES) return null;
  const { top, rows, bottom } = frameParts(spec, body);
  return (
    <Box flexDirection="column" width={spec.width} height={spec.height} flexShrink={0}>
      <Text color={borderColor} wrap="truncate">
        {top}
      </Text>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-height frame, rows are positional
        <Text key={i} wrap="truncate">
          <Text color={borderColor}>│ </Text>
          {row}
          <Text color={borderColor}> │</Text>
        </Text>
      ))}
      <Text color={borderColor} wrap="truncate">
        {bottom}
      </Text>
    </Box>
  );
}
