import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  passesFilter,
  STATUS_BY_KEY,
  StatusFilterStrip,
  statusForToggleKey,
  substateToggleForKey,
  toggleStatusSet,
  useStatusFilter,
} from "../src/cli/tui/use-status-filter.js";
import { GLYPH } from "../src/glyphs.js";
import { TASK_STATUSES } from "../src/tasks/status.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function renderToString(node: unknown): string {
  function walk(n: unknown): string {
    if (n === null || n === undefined) return "";
    if (typeof n === "string") return n;
    if (typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(walk).join("");
    if (typeof n === "object" && n !== null && "props" in n) {
      return walk((n as { props: { children?: unknown } }).props.children);
    }
    return "";
  }
  return walk(node);
}

describe("useStatusFilter helpers", () => {
  it("exports the hook", () => {
    expect(typeof useStatusFilter).toBe("function");
  });

  it("default status set is all-on", () => {
    const statuses = new Set(TASK_STATUSES);
    expect([...statuses]).toEqual(["OPEN", "IN_PROGRESS", "CLOSED"]);
  });

  it("toggle removes an enabled status then adds it back", () => {
    const all = new Set(TASK_STATUSES);
    const withoutClosed = toggleStatusSet(all, "CLOSED");
    expect(withoutClosed.has("CLOSED")).toBe(false);
    expect(all.has("CLOSED")).toBe(true);

    const withClosed = toggleStatusSet(withoutClosed, "CLOSED");
    expect(withClosed.has("CLOSED")).toBe(true);
  });

  it("fresh all-on set models popup reopen reset", () => {
    const filtered = toggleStatusSet(new Set(TASK_STATUSES), "CLOSED");
    expect(filtered.has("CLOSED")).toBe(false);
    expect(new Set(TASK_STATUSES).has("CLOSED")).toBe(true);
  });

  it("maps mnemonic keys to statuses", () => {
    expect(STATUS_BY_KEY).toEqual({
      o: "OPEN",
      i: "IN_PROGRESS",
      c: "CLOSED",
    });
    expect(statusForToggleKey("o", {})).toBe("OPEN");
    expect(statusForToggleKey("O", {})).toBe("OPEN");
    expect(statusForToggleKey("d", { ctrl: true })).toBeUndefined();
  });
});

describe("StatusFilterStrip", () => {
  it("renders every status with all indicators enabled by default", () => {
    const text = stripAnsi(renderToString(StatusFilterStrip({ statuses: new Set(TASK_STATUSES) })));

    expect(text).toContain("filters: ");
    expect(text).toContain(`[O]pen ${GLYPH.on}`);
    expect(text).toContain(`[I]n_progress ${GLYPH.on}`);
    expect(text).toContain(`[C]losed ${GLYPH.on}`);
  });

  it("renders disabled statuses with open-circle indicators", () => {
    const statuses = new Set(TASK_STATUSES);
    statuses.delete("CLOSED");

    const text = stripAnsi(renderToString(StatusFilterStrip({ statuses })));

    expect(text).toContain(`[C]losed ${GLYPH.off}`);
    expect(text).toContain(`[O]pen ${GLYPH.on}`);
  });

  it("uses colorStatus for status letters", () => {
    const src = readFileSync("./src/cli/tui/use-status-filter.tsx", "utf-8");
    expect(src).toContain("colorStatus(status)");
  });
});

describe("passesFilter (substate toggles)", () => {
  const all = { statuses: new Set(TASK_STATUSES), showParked: true, showNotDone: true };

  it("everything visible by default", () => {
    expect(passesFilter({ status: "OPEN", substate: "parked" }, all)).toBe(true);
    expect(passesFilter({ status: "CLOSED", substate: "wontfix" }, all)).toBe(true);
  });

  it("showParked=false hides OPEN/parked only", () => {
    const f = { ...all, showParked: false };
    expect(passesFilter({ status: "OPEN", substate: "parked" }, f)).toBe(false);
    expect(passesFilter({ status: "OPEN", substate: "todo" }, f)).toBe(true);
  });

  it("showNotDone=false hides CLOSED/* except done", () => {
    const f = { ...all, showNotDone: false };
    expect(passesFilter({ status: "CLOSED", substate: "rejected" }, f)).toBe(false);
    expect(passesFilter({ status: "CLOSED", substate: "wontfix" }, f)).toBe(false);
    expect(passesFilter({ status: "CLOSED", substate: "superseded" }, f)).toBe(false);
    expect(passesFilter({ status: "CLOSED", substate: "done" }, f)).toBe(true);
  });

  it("status toggle still wins", () => {
    const f = { ...all, statuses: new Set(["OPEN", "IN_PROGRESS"] as const) };
    expect(passesFilter({ status: "CLOSED", substate: "done" }, f)).toBe(false);
  });

  it("p and w are the substate toggle keys", () => {
    expect(substateToggleForKey("p", {})).toBe("parked");
    expect(substateToggleForKey("W", {})).toBe("notDone");
    expect(substateToggleForKey("p", { ctrl: true })).toBeUndefined();
    expect(substateToggleForKey("o", {})).toBeUndefined();
  });

  it("the strip renders the parked and not-done toggles", () => {
    const text = stripAnsi(
      renderToString(
        StatusFilterStrip({
          statuses: new Set(TASK_STATUSES),
          showParked: false,
          showNotDone: true,
        }),
      ),
    );
    expect(text).toContain(`[P]arked ${GLYPH.off}`);
    expect(text).toContain(`[W]on't do ${GLYPH.on}`);
  });
});
