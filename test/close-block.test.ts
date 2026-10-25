// parseCloseBlock: the strict CLOSE grammar over the whole tail, pure.
// See src/close-block.ts. The block is the tail of the message, exactly:
//
//   CLOSE: task=<id> evidence="<escaped>"     (column 0, outside any fence)
//   REPORT:                                   (the next line)
//   <report: exact bytes to the end>
//
// Anything else applies nothing.

import { describe, expect, it } from "vitest";
import { parseCloseBlock } from "../src/close-block.js";

const H = (task = "t1", ev = "npm test: passed") => `CLOSE: task=${task} evidence="${ev}"`;
const block = (task = "t1", ev = "npm test: passed", report = "done") =>
  `${H(task, ev)}\nREPORT:\n${report}`;

type Want = { v: string; task?: string; evidence?: string } | "none" | "malformed";

/** The table: one row per adversarial input. `v` is the exact report. */
const CASES: [string, string, Want][] = [
  // --- fences: the tail is quoted, or it is not ---
  ["plain block after prose", `All done.\n\n${block()}`, { v: "done" }],
  ["block inside a CLOSED fence (nothing outside)", `\`\`\`text\n${block()}\n\`\`\``, "none"],
  ["nested longer fence quoting a block", `\`\`\`\`\n\`\`\`\n${block()}\n\`\`\`\n\`\`\`\``, "none"],
  ["shorter fence does not close a longer one", `\`\`\`\`\n\`\`\`\n${block()}`, "none"],
  ["mixed-kind fence does not close", `\`\`\`\n~~~\n${block()}`, "none"],
  ["~~~ open and ~~~ close, then a real block", `~~~\nx\n~~~\n${block()}`, { v: "done" }],
  ["info-bearing fence line does not close", `\`\`\`\n\`\`\`text\n${block()}`, "none"],
  ["3-space indented fence still opens", `   \`\`\`\n${block()}`, "none"],
  ["4-space indented fence is code, not a fence", `    \`\`\`\n${block()}`, { v: "done" }],
  [
    "unclosed fence before a block (f_close_quoted_fence)",
    `Reviewing:\n\`\`\`text\n${block()}`,
    "none",
  ],
  ["unclosed ~~~ fence before a block", `~~~\n${block()}`, "none"],
  ["unclosed fence before a malformed tail", "```\nCLOSE: task=t1 evidence=bad", "none"],
  [
    "completed quote, then the real block",
    `\`\`\`text\n${block("t9")}\n\`\`\`\n${block("t1", "ok", "real")}`,
    { v: "real", evidence: "ok" },
  ],
  // --- start line: column 0 only ---
  ["indented header", ` ${block()}`, "none"],
  ["mid-line header", `see ${block()}`, "none"],
  ["blockquoted block", '> CLOSE: task=t1 evidence="x"\n> REPORT:\n> r', "none"],
  ["blockquoted header only", `> ${H()}\nREPORT:\nr`, "none"],
  ["quoted template", 'CLOSE: task=<id> evidence="<command + result>"\nREPORT:\n<report>', "none"],
  ["lowercase marker", 'close: task=t1 evidence="x"\nREPORT:\nr', "none"],
  ["prose only", "done, nothing to close", "none"],
  ["empty", "", "none"],
  // --- earlier blocks are never considered ---
  [
    "two blocks: the final one wins",
    `${block("old", "x", "first")}\nprose\n${block("t2", "y", "last")}`,
    { v: "last", task: "t2", evidence: "y" },
  ],
  [
    "malformed final CLOSE after a valid pair (f_close_malformed_tail)",
    `${block()}\nCLOSE: task=t1 evidence=bad`,
    "malformed",
  ],
  [
    "malformed REPORT colon + body after a valid pair (f_close_malformed_tail_2)",
    `${block()}\n\nCLOSE: task=t1 evidence=bad\nREPORT\nnot a valid final block`,
    "malformed",
  ],
  [
    "blank line between CLOSE and REPORT after a valid pair",
    `${block()}\n\n${H()}\n\nREPORT:\nbody`,
    "malformed",
  ],
  [
    "valid final pair whose header is bad, earlier pair valid",
    `${block()}\nCLOSE: task=t1 evidence=bad\nREPORT:\nr`,
    "malformed",
  ],
  // --- exact markers ---
  ["REPORT without colon", `${H()}\nREPORT\nr`, "malformed"],
  ["REPORT indented", `${H()}\n REPORT:\nr`, "malformed"],
  ["REPORT with trailing space", `${H()}\nREPORT: \nr`, "malformed"],
  ["REPORT lowercase", `${H()}\nreport:\nr`, "malformed"],
  ["REPORT with text on the line", `${H()}\nREPORT: r`, "malformed"],
  ["text between header and REPORT", `${H()}\nnote\nREPORT:\nr`, "malformed"],
  ["CLOSE: alone, no REPORT", `prose\n${H()}`, "malformed"],
  ["header with trailing space", `${H()} \nREPORT:\nr`, "malformed"],
  ["header with trailing junk", `${H()} extra\nREPORT:\nr`, "malformed"],
  ["header with a doubled space", 'CLOSE:  task=t1 evidence="x"\nREPORT:\nr', "malformed"],
  ["fields out of order", 'CLOSE: evidence="x" task=t1\nREPORT:\nr', "malformed"],
  ["no task=", 'CLOSE: evidence="x"\nREPORT:\nr', "malformed"],
  ["unquoted evidence", "CLOSE: task=t1 evidence=ok\nREPORT:\nr", "malformed"],
  ["empty evidence", 'CLOSE: task=t1 evidence=""\nREPORT:\nr', "malformed"],
  ["blank evidence", 'CLOSE: task=t1 evidence="  "\nREPORT:\nr', "malformed"],
  ["invalid task id", 'CLOSE: task=T-1! evidence="x"\nREPORT:\nr', "malformed"],
  ["bare quote inside evidence", 'CLOSE: task=t1 evidence="said "hi" ok"\nREPORT:\nr', "malformed"],
  ["unterminated evidence", 'CLOSE: task=t1 evidence="oops\nREPORT:\nr', "malformed"],
  ["escaped closing quote", 'CLOSE: task=t1 evidence="oops\\"\nREPORT:\nr', "malformed"],
  ["empty report", `${H()}\nREPORT:\n\n  \n`, "malformed"],
  ["REPORT: as the last line", `${H()}\nREPORT:`, "malformed"],
  // --- the report: exact bytes ---
  ["report keeps leading blank lines", `${H()}\nREPORT:\n\n\nbody`, { v: "\n\nbody" }],
  ["report keeps leading indentation", `${H()}\nREPORT:\n    code\nnext`, { v: "    code\nnext" }],
  ["trailing spaces/TAB on a nonblank line", `${H()}\nREPORT:\nbody  \t`, { v: "body  \t" }],
  [
    "final whitespace-only line, no newline (f_close_report_tail_bytes)",
    `${H()}\nREPORT:\n    code\nnext\n \t`,
    { v: "    code\nnext\n \t" },
  ],
  [
    "trailing blank lines are kept, only the last newlines normalize",
    `${H()}\nREPORT:\n    code\nnext\n \t\n\n`,
    { v: "    code\nnext\n \t\n" },
  ],
  ["one trailing newline stays one", `${block()}\n`, { v: "done\n" }],
  ["many trailing newlines become one", `${block()}\n\n\n\n`, { v: "done\n" }],
  ["interior blank lines kept", `${H()}\nREPORT:\na\n\n  b\nc`, { v: "a\n\n  b\nc" }],
  [
    "CRLF throughout: bytes as sent, the final CRLF run becomes one LF",
    `${block("t1", "ok", "a\nb\n").replace(/\n/g, "\r\n")}\r\n`,
    { v: "a\r\nb\n", evidence: "ok" },
  ],
  [
    "CRLF fence then a block",
    `\`\`\`\r\nx\r\n\`\`\`\r\n${block("t1", "ok", "r").replace(/\n/g, "\r\n")}`,
    { v: "r", evidence: "ok" },
  ],
  [
    "a balanced fence inside the report is report bytes",
    `${H()}\nREPORT:\nsee\n\`\`\`\ncode\n\`\`\`\nend`,
    { v: "see\n```\ncode\n```\nend" },
  ],
  [
    "an unclosed fence inside the report quotes the tail: no block",
    `${H()}\nREPORT:\nsee\n\`\`\`\ncode`,
    "none",
  ],
  [
    "a quoted header inside a report fence is not a start",
    `${H()}\nREPORT:\n\`\`\`\n${H("t9")}\n\`\`\``,
    { v: `\`\`\`\n${H("t9")}\n\`\`\`` },
  ],
  [
    "a column-0 CLOSE: line in the report makes the tail not a block",
    `${H()}\nREPORT:\nI will end with\n${H("t9")}\nbut not yet`,
    "malformed",
  ],
  [
    "a template line in the report is inert",
    `${H()}\nREPORT:\nuse CLOSE: task=<id> evidence="x"`.replace("use ", ""),
    { v: 'CLOSE: task=<id> evidence="x"' },
  ],
];

describe("parseCloseBlock: adversarial table", () => {
  it.each(CASES)("%s", (_name, text, want) => {
    const got = parseCloseBlock(text);
    if (want === "none" || want === "malformed") {
      expect(got.kind).toBe(want);
      expect(got).toHaveProperty("reason");
      expect((got as { reason: string }).reason).toMatch(/^[^\n]+$/);
      return;
    }
    expect(got).toEqual({
      kind: "valid",
      task: want.task ?? "t1",
      evidence: want.evidence ?? (text.includes("npm test: passed") ? "npm test: passed" : "x"),
      report: want.v,
    });
  });
});

describe("parseCloseBlock: evidence escapes", () => {
  it('unescapes \\" \\\\ and \\n; any other backslash is literal', () => {
    const r = parseCloseBlock(block("t1", String.raw`said \"hi\" C:\\tmp a\nb \d`, "r"));
    expect(r).toMatchObject({ kind: "valid", evidence: 'said "hi" C:\\tmp a\nb \\d' });
  });
});

// ---- fuzz ------------------------------------------------------------

let seed = 0x5eed;
const rnd = (n: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return Math.floor((seed / 2 ** 32) * n);
};
const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;

describe("parseCloseBlock: fuzz, fence placement", () => {
  const pieces = [
    "prose",
    "",
    "```",
    "~~~",
    "```text",
    "  ```",
    'CLOSE: task=old evidence="x"',
    "CLOSE: task=old evidence=bad",
    'CLOSE: task=<id> evidence="<x>"',
    "REPORT:",
    'CLOSE: task=old evidence="x"\nREPORT:\nold report',
    "    indented",
  ];
  const finals = [
    { text: 'CLOSE: task=t1 evidence="ok"\nREPORT:\n  r1\nr2', kind: "valid" },
    { text: "CLOSE: task=t1 evidence=bad", kind: "malformed" },
    { text: 'CLOSE: task=t1 evidence="ok"\nREPORT:\n \n', kind: "malformed" },
    { text: 'CLOSE: task=t1 evidence="ok"\nREPORT\nbody', kind: "malformed" },
    { text: 'CLOSE: task=t1 evidence="ok"\n\nREPORT:\nbody', kind: "malformed" },
  ] as const;

  /** Oracle: is a ``` / ~~~ fence open after these lines (info text only on the opener)? */
  function fenceOpenAfter(lines: string[]): boolean {
    let open: string | undefined;
    for (const l of lines.flatMap((x) => x.split("\n"))) {
      const m = /^ {0,3}(```|~~~)(.*)$/.exec(l);
      if (!m) continue;
      const ch = (m[1] as string)[0] as string;
      if (open === undefined) open = ch;
      else if (open === ch && (m[2] ?? "") === "") open = undefined;
    }
    return open !== undefined;
  }

  it("the final tail counts only outside a fence; a malformed one never falls back", () => {
    for (let n = 0; n < 4000; n++) {
      const prefix = Array.from({ length: rnd(7) }, () => pick(pieces));
      const fin = pick(finals);
      const trail = pick(["", "\n", "\n\n  \n"]);
      const text = [...prefix, fin.text].join("\n") + trail;
      const got = parseCloseBlock(text);
      const where = JSON.stringify(text);
      if (fenceOpenAfter(prefix)) {
        expect(got.kind, where).toBe("none");
      } else if (fin.kind === "valid") {
        const report = { "": "  r1\nr2", "\n": "  r1\nr2\n", "\n\n  \n": "  r1\nr2\n\n  \n" }[
          trail
        ];
        expect(got, where).toEqual({ kind: "valid", task: "t1", evidence: "ok", report });
      } else {
        expect(got.kind, where).toBe("malformed");
      }
    }
  });
});

describe("parseCloseBlock: fuzz, fence-free tail against a regex oracle", () => {
  const lines = [
    'CLOSE: task=t1 evidence="ok"',
    'CLOSE: task=t2 evidence="a \\"q\\" b"',
    'CLOSE: task=t1 evidence="bare "q" x"',
    'CLOSE: task=t1  evidence="ok"',
    'CLOSE: task=t1 evidence="ok" ',
    "CLOSE: task=t1",
    'CLOSE: task=<id> evidence="x"',
    "REPORT:",
    "REPORT",
    " REPORT:",
    "REPORT: ",
    "report:",
    "",
    "  ",
    "\t",
    "    code",
    "prose",
    "trailing  ",
    "> quoted",
  ];

  const reportLines = ["", "  ", "\t", "    code", "prose", "trailing  ", "> quoted", "REPORT:"];

  /** Independent statement of the grammar for messages with no fence lines. */
  function oracle(text: string): "none" | "malformed" | { task: string; report: string } {
    const body = text.replace(/(?:\r?\n)+$/, "");
    if (body.trim() === "") return "none";
    const ls = body.split("\n").map((l) => l.replace(/\r$/, ""));
    let at = -1;
    ls.forEach((l, i) => {
      if (l.startsWith("CLOSE:") && !/^CLOSE:[ \t]+task=<[^>\s]*>/.test(l)) at = i;
    });
    if (at < 0) return "none";
    const m = /^CLOSE: task=(\S+) evidence="(.*)"$/.exec(ls[at] as string);
    if (!m || !/^[a-z0-9_][a-z0-9_-]*$/i.test(m[1] as string)) return "malformed";
    // evidence: no bare quote, no dangling backslash, not blank
    const ev = m[2] as string;
    if (/(^|[^\\])(\\\\)*"/.test(ev) || /(^|[^\\])(\\\\)*\\$/.test(ev)) return "malformed";
    if (ev.replace(/\\[n"\\]/g, "x").trim() === "") return "malformed";
    if (ls[at + 1] !== "REPORT:") return "malformed";
    const rest = body
      .split("\n")
      .slice(at + 2)
      .join("\n");
    if (rest.trim() === "") return "malformed";
    const term = /(\r?\n)+$/.exec(text);
    const last = term ? "\n" : "";
    return { task: m[1] as string, report: rest + last };
  }

  it("matches the oracle on random line soups, LF and CRLF, with trailing newlines", () => {
    let valid = 0;
    for (let n = 0; n < 6000; n++) {
      const nl = pick(["\n", "\r\n"]);
      const pre = Array.from({ length: rnd(4) }, () => pick(lines));
      // Half the time end with a real block so the valid path is exercised.
      const tail =
        rnd(2) === 0
          ? [
              'CLOSE: task=t1 evidence="ok"',
              "REPORT:",
              ...Array.from({ length: 1 + rnd(4) }, () => pick(rnd(5) === 0 ? lines : reportLines)),
            ]
          : Array.from({ length: rnd(4) }, () => pick(lines));
      const text = [...pre, ...tail].join(nl) + pick(["", nl, nl + nl]);
      const got = parseCloseBlock(text);
      const want = oracle(text);
      const where = JSON.stringify(text);
      if (want === "none" || want === "malformed") {
        expect(got.kind, where).toBe(want);
      } else {
        valid++;
        expect(got, where).toMatchObject({ kind: "valid", task: want.task, report: want.report });
      }
    }
    expect(valid).toBeGreaterThan(200);
  });

  it("never throws on arbitrary bytes, and a valid report is a literal slice of the message", () => {
    const alphabet = [
      '"',
      "\\",
      "\n",
      "\r",
      " ",
      "\t",
      "`",
      "~",
      "CLOSE:",
      "REPORT:",
      " task=t1",
      ' evidence="',
      "x",
    ];
    for (let n = 0; n < 6000; n++) {
      const text = Array.from({ length: rnd(30) }, () => pick(alphabet)).join("");
      const got = parseCloseBlock(text);
      if (got.kind !== "valid") continue;
      const bare = got.report.replace(/(?:\r?\n)+$/, "");
      expect(
        text.replace(/(?:\r?\n)+$/, "").endsWith(`REPORT:\n${bare}`) ||
          text.replace(/(?:\r?\n)+$/, "").endsWith(`REPORT:\r\n${bare}`),
        JSON.stringify(text),
      ).toBe(true);
    }
  });
});
