// The one list-navigation key map, shared by every list (tabs, the Overview's
// Attention cursor) and every drill body (notes, scrollback, log entry), so a
// key moves the same way everywhere. Pure: the caller applies the result to a
// cursor (lists) or a scroll offset (drills).
//
//   j / ↓   k / ↑         one row
//   Ctrl-d  Ctrl-u        half a page
//   PgDn    PgUp          a page (drills: space too)
//   g g     g     Home    top (`gg` is two tops, so vim hands work)
//   G       End           bottom

import type { Key } from "ink";

export type NavMove = { to: "top" } | { to: "bottom" } | { by: number };

/** What `input`/`key` does in a list or body showing `page` rows; null = not a navigation key. */
export function navKey(input: string, key: Key, page: number, space = false): NavMove | null {
  const full = Math.max(1, page);
  const half = Math.max(1, Math.floor(full / 2));
  if (key.ctrl && input === "d") return { by: half };
  if (key.ctrl && input === "u") return { by: -half };
  if (key.ctrl || key.meta) return null;
  if (key.downArrow || input === "j") return { by: 1 };
  if (key.upArrow || input === "k") return { by: -1 };
  if (key.pageDown || (space && input === " ")) return { by: full };
  if (key.pageUp) return { by: -full };
  if (input === "g" || key.home) return { to: "top" };
  if (input === "G" || key.end) return { to: "bottom" };
  return null;
}

/** The hint text for these keys. */
export const NAV_HINT = "j/k ^d/^u g/G";
