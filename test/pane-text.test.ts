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

// Fixtures follow real captures (tmux capture-pane of live pi 0.x panes on
// 2026-11-10; claude's input box and hint rows from Claude Code 2.x).

/** pi's footer: the editor between two rules, then the cwd and stats rows. */
const PI_FOOTER = [
  "",
  "",
  "──────────────────────────────────────────────────────────────────────────────",
  "",
  "──────────────────────────────────────────────────────────────────────────────",
  "~/repo (main) • Review Wait",
  "↑182 ↓11k R5.8M W217k CH99.2% $2.467 7.8%/1.0M (auto)  claude-opus-5-5 • medium",
];

/** A pi pane: the worker's words, pi's transcript furniture, its footer. */
const PANE = [
  " Review the patch in src/wait.ts.",
  "",
  " $ git diff --stat HEAD~1",
  "",
  " ... (7 earlier lines, ctrl+o to expand)",
  "  src/wait.ts | 12 ++++++------",
  "",
  " Took 0.5s",
  "",
  "",
  " Thinking...",
  "",
  "",
  " The patch is sound. One nit: rename x to count.",
  " VERDICT: ok",
  "",
  " Files touched:",
  " /Users/me/repo/test/wait.test.ts",
  ...PI_FOOTER,
  "",
].join("\n");

const WORDS = [
  " Review the patch in src/wait.ts.",
  "",
  " $ git diff --stat HEAD~1",
  "",
  "  src/wait.ts | 12 ++++++------",
  "",
  " The patch is sound. One nit: rename x to count.",
  " VERDICT: ok",
  "",
  " Files touched:",
  " /Users/me/repo/test/wait.test.ts",
  "",
].join("\n");

/** claude's footer: the input box between two rules, then its hint row. */
const CLAUDE_FOOTER = [
  "",
  "✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)",
  "",
  "────────────────────────────────────────────────────────────────────────",
  "> ",
  "────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
];

/** The worker's answer in a claude pane: every reviewer case in prose and in fences. */
const CLAUDE_WORDS = [
  "> fix the flaky wait test",
  "",
  "⏺ The fix is in. Summary:",
  "",
  "  | file    | change |",
  "  |---------|--------|",
  "  | wait.ts | poll   |",
  "",
  "  ~~~yaml",
  "  ---",
  "  name: wait",
  "  ~~~",
  "",
  "  ```diff",
  "  -",
  "  +++",
  "  ```",
  "",
  "  /**",
  "   *",
  "   * Polls until the pane settles.",
  "   */",
  "  ||",
  "  ***",
  "  ---",
  "  -",
  "  +++",
  "  ~~~",
  "  ~~~",
  "  120 lines",
  "  Press q to stop the server, then re-run.",
  "  ↑ 3x faster after the fix",
  "",
].join("\n");

const CLAUDE_PANE = `${CLAUDE_WORDS}${CLAUDE_FOOTER.join("\n")}\n`;

describe("paneText", () => {
  it("keeps a pi worker's words and drops pi's furniture and footer", () => {
    expect(paneText(PANE)).toBe(WORDS);
  });

  it("drops pi's busy editor border (`── ⠋ Working ───`) with the footer", () => {
    const busy = PANE.replace(/^─+$/m, `── ⠋ Working ${"─".repeat(64)}`);
    expect(busy).not.toBe(PANE);
    expect(paneText(busy)).toBe(WORDS);
  });

  // Review delegate_rv-land4_6d6286e3 (3): a pi worker's closing line sat in
  // the old fixed 6-row footer window and was dropped.
  it.each([
    "/Users/me/repo/test/wait.test.ts",
    "~/repo/src/wait.ts",
    "lease: renewed on every poll",
    "attach the log to the task",
    "stop: none needed",
    "detach is unchanged",
  ])("keeps a pi worker's last line above the editor: %s", (last) => {
    const pane = [" Done.", ` ${last}`, ...PI_FOOTER].join("\n");
    expect(paneText(pane)).toBe(` Done.\n ${last}\n`);
  });

  it("drops nothing at the bottom when there is no harness footer", () => {
    const pane = "answer\n~/repo (main)\nlease: w-1\n────────\n";
    expect(paneText(pane)).toBe("answer\n~/repo (main)\nlease: w-1\n");
  });

  it("keeps every word of a claude answer: tables, fences, YAML, diff, JSDoc, prose", () => {
    expect(paneText(CLAUDE_PANE)).toBe(CLAUDE_WORDS);
  });

  it("drops claude's older boxed input and `? for shortcuts` row", () => {
    const boxed = [
      "╭──────────────────────────────────╮",
      "│ >                                │",
      "╰──────────────────────────────────╯",
      "  ? for shortcuts",
    ];
    expect(paneText(`answer\n\n${boxed.join("\n")}\n`)).toBe("answer\n");
  });

  it.each([
    ["markdown table separator", "|------|--------|"],
    ["YAML document marker", "---"],
    ["diff bare minus", "-"],
    ["diff header", "+++"],
    ["tilde fence", "~~~"],
    ["JSDoc star", " *"],
    ["double bar", "||"],
    ["thematic break", "***"],
    ["setext underline", "===="],
    ["count in prose", "120 lines"],
    ["press-to-stop prose", "Press q to stop the server, then re-run."],
    ["arrow in prose", "↑ 3x faster after the fix"],
    ["ctrl+c in prose", "Hit ctrl+c to stop it, then rerun."],
    ["spinner-glyph prose", "✻ Working on the parser next, then tests."],
  ])("keeps a %s", (_what, row) => {
    expect(paneText(`answer\n${row}\n`)).toBe(`answer\n${row}\n`);
  });

  it.each([
    ["pi status line", "⠋ Thinking… (esc to interrupt)"],
    ["claude status line", "✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)"],
    ["spinner row", "✻ Working (12s)"],
    ["status hint", "  Running tools · esc to cancel"],
    ["box rule", "╭──────────────────────────────╮"],
    ["plain rule", "────────────────────────────────"],
    ["scroll marker", "↑ 12 more lines"],
    ["spelled scroll marker", "  … 3 more lines"],
    ["pi collapsed output", " ... (7 earlier lines, ctrl+o to expand)"],
    ["token counter", "↓ 1.2k tokens"],
    ["pi timing row", " Elapsed 19m 48s"],
  ])("drops a %s", (_what, row) => {
    expect(paneText(`answer\n${row}\n`)).toBe("answer\n");
  });

  it("keeps every row inside a code fence verbatim, rules and blank runs too", () => {
    const fence = ["```", "────────", "✻ Working (12s)", "", "", "↑ 12 more lines", "```"];
    expect(paneText(`answer\n${fence.join("\n")}\n`)).toBe(`answer\n${fence.join("\n")}\n`);
  });

  it("folds a blank run to one blank line and trims the edges", () => {
    expect(paneText("\n\n\na\n\n\n\nb\n\n\n")).toBe("a\n\nb\n");
  });

  it("strips ANSI and box sides but keeps the words inside", () => {
    expect(paneText("│ \x1b[31mred words\x1b[0m │\n")).toBe("red words\n");
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
    expect(r.stdout).toBe("\n Files touched:\n /Users/me/repo/test/wait.test.ts\n");
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

  it("--json --text -n counts text lines like plain --text; scrollback keeps raw rows", async () => {
    const r = await runCliJson(
      ["agent", "read", "worker-1", "-w", "auth", "--json", "--text", "-n", "3"],
      dbPath,
    );
    const out = r.data as { scrollback: string; text?: string };
    expect(out.text).toBe((await read("--text", "-n", "3")).stdout);
    const raw = await runCliJson(
      ["agent", "read", "worker-1", "-w", "auth", "--json", "-n", "3"],
      dbPath,
    );
    expect(out.scrollback).toBe((raw.data as { scrollback: string }).scrollback);
    expect(out.scrollback).toContain("~/repo (main)");
    expect(out.text).toBe("\n Files touched:\n /Users/me/repo/test/wait.test.ts\n");
  });

  it("show --text lists the words under its own heading; --json adds `text`", async () => {
    const r = await runCli(["agent", "show", "worker-1", "-w", "auth", "--text"], dbPath);
    expect(r.stdout).toContain("Recent text (last 20 lines, furniture dropped)");
    expect(r.stdout).toContain("   VERDICT: ok");
    expect(r.stdout).not.toContain("Took 0.5s");
    const raw = await runCli(["agent", "show", "worker-1", "-w", "auth"], dbPath);
    expect(raw.stdout).toContain("Recent scrollback (last 20 lines)");
    expect(raw.stdout).toContain("Took 0.5s");
    const j = await runCliJson(
      ["agent", "show", "worker-1", "-w", "auth", "--json", "--text"],
      dbPath,
    );
    const shown = j.data as { scrollback: string; text?: string };
    expect(shown.text).toBe(paneText(shown.scrollback));
    expect(shown.text).toContain(" VERDICT: ok");
  });
});
