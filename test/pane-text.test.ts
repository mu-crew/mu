// `mu agent read --text` / `mu agent show --text`: the worker's words out of
// a captured pane, screen furniture dropped (docs/eval/hill-r2/c4.md, the C4
// tournament winner). The default output stays the raw capture, byte for byte.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { paneText, tailText } from "../src/pane-text.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

/** A harness screen: the worker's words between its furniture. */
const PANE = [
  "\x1b[1m> review the patch\x1b[0m",
  "",
  "",
  "",
  "╭──────────────────────────────╮",
  "│ The patch is sound.          │",
  "│ One nit: rename x to count.  │",
  "╰──────────────────────────────╯",
  "↑ 12 more lines",
  "  … 3 more lines",
  "────────────────────────────────",
  "VERDICT: ok",
  "Tests pass on main.",
  "⠋ Thinking… (esc to interrupt)",
  "✻ Working (12s)",
  "",
  "↓ 1.2k tokens",
  "~/src/mu (main)",
  "lease: w-1 attach: mu agent attach w-1",
  "",
].join("\n");

const WORDS = [
  "> review the patch",
  "",
  "The patch is sound.",
  "One nit: rename x to count.",
  "VERDICT: ok",
  "Tests pass on main.",
  "",
].join("\n");

describe("paneText", () => {
  it("keeps the worker's words and drops the furniture", () => {
    expect(paneText(PANE)).toBe(WORDS);
  });

  it.each([
    ["status line", "⠋ Thinking… (esc to interrupt)"],
    ["spinner row", "✻ Working (12s)"],
    ["status hint", "  Running tools · esc to cancel"],
    ["box rule", "╭──────────────────────────────╮"],
    ["plain rule", "────────────────────────────────"],
    ["scroll marker", "↑ 12 more lines"],
    ["spelled scroll marker", "  … 3 more lines"],
    ["token counter", "↓ 1.2k tokens"],
    ["cwd footer", "~/src/mu (main)"],
    ["lease footer", "lease: w-1 attach: mu agent attach w-1"],
  ])("drops a %s", (_what, row) => {
    expect(paneText(`answer\n${row}\n`)).toBe("answer\n");
  });

  it("folds a blank run to one blank line and trims the edges", () => {
    expect(paneText("\n\n\na\n\n\n\nb\n\n\n")).toBe("a\n\nb\n");
  });

  it("strips ANSI and box sides but keeps the words inside", () => {
    expect(paneText("│ \x1b[31mred words\x1b[0m │\n")).toBe("red words\n");
  });

  it("keeps a word line that looks like a footer above the footer rows", () => {
    const rows = ["lease: the word in prose", "a", "b", "c", "d", "e", "f"];
    expect(paneText(rows.join("\n"))).toBe(`${rows.join("\n")}\n`);
  });

  it("is empty for a pane of furniture only", () => {
    expect(paneText("\n────\n⠋ Thinking (esc to interrupt)\n\n")).toBe("");
  });
});

describe("tailText", () => {
  it("keeps the last n lines; undefined and 0 keep all", () => {
    expect(tailText("a\nb\nc\n", 2)).toBe("b\nc\n");
    expect(tailText("a\nb\nc\n", undefined)).toBe("a\nb\nc\n");
    expect(tailText("a\nb\nc\n", 0)).toBe("a\nb\nc\n");
    expect(tailText("", 3)).toBe("");
  });
});

describe("mu agent read / show --text", () => {
  let dir: string;
  let dbPath: string;
  let db: Db;
  let mux: MuxHarness | undefined;
  let captures: string[][];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-ptext-"));
    dbPath = join(dir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "claude" });
    captures = [];
    // A pane that honours `-S -N` the way tmux does: the last N rows.
    mux = installMux("tmux", async (args) => {
      if (args[0] !== "capture-pane") return { stdout: "", stderr: "", exitCode: 0 };
      captures.push([...args]);
      const s = args[args.indexOf("-S") + 1] ?? "-";
      const rows = PANE.split("\n");
      const stdout = s === "-" ? PANE : `${rows.slice(Number(s) - 1).join("\n")}`;
      return { stdout, stderr: "", exitCode: 0 };
    });
  });

  afterEach(() => {
    mux?.restore();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const read = (...extra: string[]) =>
    runCli(["agent", "read", "worker-1", "-w", "auth", ...extra], dbPath);

  it("default output is the raw capture, byte for byte", async () => {
    const r = await read();
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe(PANE);
  });

  it("--text prints only the words", async () => {
    const r = await read("--text");
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe(WORDS);
  });

  it("-n with --text counts text lines, read from the full scrollback", async () => {
    const r = await read("--text", "-n", "3");
    expect(r.stdout).toBe("One nit: rename x to count.\nVERDICT: ok\nTests pass on main.\n");
    expect(captures.at(-1)?.slice(-4)).toEqual(["-S", "-", "-E", "-"]);
  });

  it("--json --text adds `text` beside the raw scrollback; --json alone has none", async () => {
    const r = await runCliJson(
      ["agent", "read", "worker-1", "-w", "auth", "--json", "--text"],
      dbPath,
    );
    const out = r.data as { scrollback: string; text?: string };
    expect(out.scrollback).toBe(PANE);
    expect(out.text).toBe(WORDS);
    const plain = await runCliJson(["agent", "read", "worker-1", "-w", "auth", "--json"], dbPath);
    expect(plain.data).not.toHaveProperty("text");
  });

  it("show --text lists the words under its own heading; --json adds `text`", async () => {
    const r = await runCli(["agent", "show", "worker-1", "-w", "auth", "--text"], dbPath);
    expect(r.stdout).toContain("Recent text (last 20 lines, furniture dropped)");
    expect(r.stdout).toContain("  VERDICT: ok");
    expect(r.stdout).not.toContain("esc to interrupt");
    const raw = await runCli(["agent", "show", "worker-1", "-w", "auth"], dbPath);
    expect(raw.stdout).toContain("Recent scrollback (last 20 lines)");
    expect(raw.stdout).toContain("esc to interrupt");
    const j = await runCliJson(
      ["agent", "show", "worker-1", "-w", "auth", "--json", "--text"],
      dbPath,
    );
    expect((j.data as { text?: string }).text).toBe(WORDS);
  });
});
