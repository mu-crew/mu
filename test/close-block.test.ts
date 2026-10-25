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

  it("accepts CRLF line endings", () => {
    const r = parseCloseBlock(block("t1", "ok", "a\nb").replace(/\n/g, "\r\n"));
    expect(r).toEqual({ kind: "valid", task: "t1", evidence: "ok", report: "a\nb" });
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
