// shellWord / shellQuote: the words mu prints in copy-paste lines must reach
// a POSIX shell as exactly the argv mu meant. Checked with a real `sh`, not a
// regex over the output.

import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { attachShellLine } from "../src/mux.js";
import { shellQuote, shellWord } from "../src/shell-quote.js";

/** One real shell parses a batch; NUL separates arguments, NUL + newline ends a row. */
function argvOf(lines: string[]): string[][] {
  const out = execFileSync(
    "sh",
    ["-ec", lines.map((line) => `printf '%s\\0' ${line}\nprintf '\\n'`).join("\n")],
    { encoding: "utf8" },
  );
  return out
    .split("\0\n")
    .slice(0, -1)
    .map((line) => line.split("\0"));
}

const HOSTILE = [
  "plain",
  "with space",
  "it's",
  "a;b",
  "$HOME",
  "`pwd`",
  "a&&b",
  "tab\there",
  "new\nline",
  "*",
  "~",
  "--flag=value with space",
  "ünï©ode",
  "",
];

const cases = HOSTILE.map((s, i) => [s, i] as const);

describe("shellWord", () => {
  let parsed: string[][];
  beforeAll(() => {
    parsed = argvOf(HOSTILE.map(shellWord));
  });
  it.each(cases)("%j reaches the shell as one word, unchanged", (s, i) => {
    expect(parsed[i]).toEqual([s]);
  });

  it("leaves a safe word bare (a hint stays readable)", () => {
    for (const s of ["worker-1", "auth", "7f0a-1", "/tmp/x.log", "a=b", "x@y:1,2"]) {
      expect(shellWord(s)).toBe(s);
    }
  });

  it("quotes everything else", () => {
    for (const s of ["a b", "a;b", "$x", "it's", "", "a|b", "a*"]) {
      expect(shellWord(s)).not.toBe(s);
      expect(shellWord(s)).toBe(shellQuote(s));
    }
  });
});

describe("shellQuote", () => {
  let parsed: string[][];
  beforeAll(() => {
    parsed = argvOf(HOSTILE.map(shellQuote));
  });
  it.each(cases)("%j round-trips through sh", (s, i) => {
    expect(parsed[i]).toEqual([s]);
  });
});

describe("attachShellLine uses shellWord (the line a user pastes)", () => {
  it("an argument that needs quoting survives; a safe one stays bare", () => {
    const line = attachShellLine([
      { command: "tmux", args: ["attach-session", "-t", "mu-it's a b"] },
    ]);
    expect(line).toBe(`tmux attach-session -t ${shellQuote("mu-it's a b")}`);
    expect(argvOf([line])).toEqual([["tmux", "attach-session", "-t", "mu-it's a b"]]);
    expect(attachShellLine([{ command: "tmux", args: ["attach-session", "-t", "mu-auth"] }])).toBe(
      "tmux attach-session -t mu-auth",
    );
  });
});
