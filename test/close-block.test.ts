// parseCloseBlock: the CLOSE block grammar, pure. See src/close-block.ts.

import { describe, expect, it } from "vitest";
import { parseCloseBlock } from "../src/close-block.js";

const block = (task = "t1", ev = "npm test: 12 passed", report = "did it") =>
  `CLOSE: task=${task} evidence="${ev}"\nREPORT:\n${report}`;

describe("parseCloseBlock: the final tail", () => {
  it("parses a plain block after prose", () => {
    expect(parseCloseBlock(`All done.\n\n${block()}`)).toEqual({
      kind: "valid",
      task: "t1",
      evidence: "npm test: 12 passed",
      report: "did it",
    });
  });

  it("keeps a multi-line report whole and trims trailing blanks", () => {
    const r = parseCloseBlock(`${block("t1", "ok", "line1\n\n  line2\nline3")}\n\n\n`);
    expect(r).toMatchObject({ kind: "valid", report: "line1\n\n  line2\nline3" });
  });

  it("accepts CRLF line endings and stores the report bytes as sent", () => {
    const r = parseCloseBlock(block("t1", "ok", "a\nb").replace(/\n/g, "\r\n"));
    expect(r).toEqual({ kind: "valid", task: "t1", evidence: "ok", report: "a\r\nb" });
  });

  it("chooses the FINAL block when several exist", () => {
    const r = parseCloseBlock(
      `${block("old", "x", "first")}\nmore prose\n${block("t2", "y", "last")}`,
    );
    expect(r).toMatchObject({ kind: "valid", task: "t2", report: "last" });
  });

  it("a report may quote a CLOSE line that is not followed by REPORT:", () => {
    const r = parseCloseBlock(
      block("t1", "ok", 'I will end with\nCLOSE: task=t9 evidence="x"\nbut not yet'),
    );
    expect(r).toMatchObject({ kind: "valid", task: "t1" });
  });

  it("a quoted template (task=<id>) is not a block", () => {
    expect(
      parseCloseBlock('CLOSE: task=<id> evidence="<command + result>"\nREPORT:\n<report>'),
    ).toEqual({
      kind: "none",
    });
  });

  it("a block quoted inside an unclosed code fence is ignored (the closing fence is the tail)", () => {
    const quoted = `The contract:\n\`\`\`text\n${block("t1", "ok", "x")}\n\`\`\``;
    expect(parseCloseBlock(quoted)).toEqual({ kind: "none" });
  });

  it("prose only: none", () => {
    expect(parseCloseBlock("done, nothing to close")).toEqual({ kind: "none" });
    expect(parseCloseBlock("")).toEqual({ kind: "none" });
  });

  it("an indented or mid-line CLOSE: is not a block start", () => {
    expect(parseCloseBlock(` ${block()}`)).toEqual({ kind: "none" });
    expect(parseCloseBlock(`see ${block()}`)).toEqual({ kind: "none" });
  });
});

describe("parseCloseBlock: evidence escapes", () => {
  it('unescapes \\" \\\\ and \\n; any other backslash is literal', () => {
    const r = parseCloseBlock(block("t1", String.raw`said \"hi\" C:\\tmp a\nb \d`, "r"));
    expect(r).toMatchObject({ kind: "valid", evidence: 'said "hi" C:\\tmp a\nb \\d' });
  });

  it("an unescaped quote inside the evidence is malformed", () => {
    expect(parseCloseBlock(block("t1", 'said "hi" ok', "r"))).toEqual({ kind: "malformed" });
  });

  it("an unterminated evidence is malformed", () => {
    expect(parseCloseBlock('CLOSE: task=t1 evidence="oops\nREPORT:\nr')).toEqual({
      kind: "malformed",
    });
    expect(parseCloseBlock(`CLOSE: task=t1 evidence="oops\\"\nREPORT:\nr`)).toEqual({
      kind: "malformed",
    });
  });
});

describe("parseCloseBlock: malformed final block", () => {
  it.each([
    ["no task=", 'CLOSE: evidence="x"\nREPORT:\nr'],
    ["unquoted evidence", "CLOSE: task=t1 evidence=ok\nREPORT:\nr"],
    ["empty evidence", 'CLOSE: task=t1 evidence=""\nREPORT:\nr'],
    ["blank evidence", 'CLOSE: task=t1 evidence="  "\nREPORT:\nr'],
    ["invalid task id", 'CLOSE: task=T-1! evidence="x"\nREPORT:\nr'],
    ["empty report", 'CLOSE: task=t1 evidence="x"\nREPORT:\n\n  \n'],
    ["trailing junk after the closing quote", 'CLOSE: task=t1 evidence="x" extra\nREPORT:\nr'],
    ["CLOSE: with no REPORT:", 'prose\nCLOSE: task=t1 evidence="x"'],
  ])("%s", (_n, text) => {
    expect(parseCloseBlock(text)).toEqual({ kind: "malformed" });
  });

  it("a malformed FINAL block is not rescued by an earlier valid one", () => {
    expect(parseCloseBlock(`${block("t1")}\nCLOSE: task=t1 evidence=bad\nREPORT:\nr`)).toEqual({
      kind: "malformed",
    });
  });
});

describe("parseCloseBlock: round 2 (final literal block only)", () => {
  it("f_close_malformed_tail: a malformed final CLOSE after a valid pair applies nothing", () => {
    const t =
      'CLOSE: task=t1 evidence="npm test: passed"\nREPORT:\ndone\nCLOSE: task=t1 evidence=bad';
    expect(parseCloseBlock(t)).toEqual({ kind: "malformed" });
    expect(parseCloseBlock(`${t}\n\n  \n`)).toEqual({ kind: "malformed" });
  });

  it("a malformed final pair after a valid pair is malformed, not the earlier block", () => {
    const t = `${block("t1")}\nCLOSE: task=t1 evidence=bad\nREPORT:\nr`;
    expect(parseCloseBlock(t)).toEqual({ kind: "malformed" });
  });

  it("f_close_quoted_fence: a block inside an UNCLOSED fence is quoted", () => {
    const t =
      'Reviewing this brief:\n```text\nCLOSE: task=t1 evidence="npm test: passed"\nREPORT:\ndone';
    expect(parseCloseBlock(t)).toEqual({ kind: "none" });
    expect(parseCloseBlock(t.replace("```text", "~~~"))).toEqual({ kind: "none" });
    expect(parseCloseBlock(t.replace("```text", "````"))).toEqual({ kind: "none" });
  });

  it("a malformed CLOSE tail inside an unclosed fence is quoted too", () => {
    expect(parseCloseBlock("```\nCLOSE: task=t1 evidence=bad")).toEqual({ kind: "none" });
  });

  it("a block after a COMPLETED quote still works", () => {
    const t = `Quote:\n\`\`\`text\n${block("t9", "x", "y")}\n\`\`\`\n${block("t1", "ok", "real")}`;
    expect(parseCloseBlock(t)).toMatchObject({ kind: "valid", task: "t1", report: "real" });
  });

  it("fence rules: a shorter or other-kind fence line does not close; a longer one does", () => {
    const quoted = (open: string, mid: string) => `${open}\n${mid}\n${block("t1")}`;
    expect(parseCloseBlock(quoted("````", "```"))).toEqual({ kind: "none" });
    expect(parseCloseBlock(quoted("```", "~~~"))).toEqual({ kind: "none" });
    expect(parseCloseBlock(quoted("```", "````"))).toMatchObject({ kind: "valid" });
    expect(parseCloseBlock(quoted("~~~", "~~~~"))).toMatchObject({ kind: "valid" });
  });

  it("f_close_report_whitespace: the report keeps leading indentation and blank lines", () => {
    expect(parseCloseBlock('CLOSE: task=t1 evidence="x"\nREPORT:\n    code\nnext')).toMatchObject({
      report: "    code\nnext",
    });
    expect(parseCloseBlock('CLOSE: task=t1 evidence="x"\nREPORT:\n\n  a  \n\n\n')).toMatchObject({
      report: "\n  a  ",
    });
  });
});

// Fuzz: random prefix lines (prose, fence lines, quoted contracts, old
// blocks) + a final block. An independent oracle tracks only ``` and ~~~
// fences of length 3 (open on the first, close on the same kind).
describe("parseCloseBlock: fuzz over fence and header placement", () => {
  let seed = 0x5eed;
  const rnd = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
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
  ] as const;

  /** Is a fence open after these lines? Oracle: ``` / ~~~ (up to 3 spaces, optional info on open only). */
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

  it("the final block counts only outside a fence; a malformed one never falls back", () => {
    for (let n = 0; n < 3000; n++) {
      const prefix = Array.from({ length: rnd(7) }, () => pieces[rnd(pieces.length)] as string);
      const fin = finals[rnd(finals.length)] as (typeof finals)[number];
      const trail = ["", "\n", "\n\n  \n"][rnd(3)] as string;
      const text = [...prefix, fin.text].join("\n") + trail;
      const got = parseCloseBlock(text);
      const where = JSON.stringify(text);
      if (fenceOpenAfter(prefix)) {
        // The final block's header sits inside a fence (unclosed to there).
        expect(got, where).toEqual({ kind: "none" });
      } else if (fin.kind === "valid") {
        expect(got, where).toEqual({
          kind: "valid",
          task: "t1",
          evidence: "ok",
          report: "  r1\nr2",
        });
      } else {
        expect(got, where).toEqual({ kind: "malformed" });
      }
    }
  });

  it("never throws and a valid result is the literal tail of the message", () => {
    for (let n = 0; n < 3000; n++) {
      const text = Array.from({ length: rnd(9) }, () => pieces[rnd(pieces.length)] as string).join(
        ["\n", "\r\n"][rnd(2)] as string,
      );
      const got = parseCloseBlock(text);
      if (got.kind !== "valid") continue;
      expect(text.replace(/\s+$/, "").endsWith(got.report.replace(/\s+$/, "")), text).toBe(true);
    }
  });
});
