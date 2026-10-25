// The bounded --until-text grammar: accepted shapes, refused shapes, and a
// time budget for what the grammar lets through. No dependency, no hang.

import { describe, expect, it } from "vitest";
import {
  checkRegexGrammar,
  compileTextMatcher,
  WAIT_REGEX_MAX_LEN,
  WAIT_TEXT_MAX,
  WaitRegexError,
} from "../src/wait-regex.js";

describe("grammar", () => {
  it.each([
    "ALL GREEN",
    "^done$",
    "(foo|bar) ok",
    "\\d+ passed",
    "[a-z]{2,10}-ok",
    "a.*b",
    "(?:x|y)z",
  ])("accepts %s", (p) => {
    expect(() => checkRegexGrammar(p)).not.toThrow();
  });

  it.each([
    ["", /empty/],
    ["(", /unbalanced/],
    [")", /unbalanced/],
    ["(a+)+$", /repeated group/],
    ["(a*)*", /repeated group/],
    ["(a|aa)*", /repeated group/],
    ["(?:a+){2,}", /repeated group/],
    ["((a+)b)+", /repeated group/],
    ["(a)\\1", /backreference/],
    ["\\k<n>", /backreference/],
    ["(?=x)y", /lookaround/],
    ["(?<!x)y", /lookaround/],
    ["(?<n>x)", /lookaround/],
    ["a{2000}", /repeat count/],
    ["x".repeat(WAIT_REGEX_MAX_LEN + 1), /limit/],
    ["a\u0000b", /control/],
  ])("refuses %j", (p, why) => {
    expect(() => checkRegexGrammar(p)).toThrow(why);
    expect(() => checkRegexGrammar(p)).toThrow(WaitRegexError);
  });

  it("a quantifier inside a character class is a literal, not a repeat", () => {
    expect(() => checkRegexGrammar("([+*]+)+")).toThrow(/repeated group/);
    expect(() => checkRegexGrammar("([+*])+")).not.toThrow();
  });

  it("a syntactically invalid regex that passes the grammar is still refused", () => {
    expect(() => compileTextMatcher("[z-a]")).toThrow(/not a valid regular expression/);
  });
});

describe("matching", () => {
  it("matches and does not match", () => {
    const m = compileTextMatcher("ALL (GREEN|PASS)");
    expect(m.test("run 1\nALL GREEN\n")).toBe(true);
    expect(m.test("ALL RED")).toBe(false);
  });

  it("matches only the tail of a huge text", () => {
    const m = compileTextMatcher("^HEAD");
    expect(m.test(`HEAD${"x".repeat(WAIT_TEXT_MAX * 2)}`)).toBe(false);
    expect(compileTextMatcher("TAIL$").test(`${"x".repeat(WAIT_TEXT_MAX * 2)}TAIL`)).toBe(true);
  });

  it("a polynomial pattern the grammar allows ends in a typed error within the budget, not a hang", () => {
    const m = compileTextMatcher("a*a*a*a*a*a*a*a*a*b");
    const t0 = Date.now();
    let err: unknown;
    try {
      m.test("a".repeat(WAIT_TEXT_MAX));
    } catch (e) {
      err = e;
    }
    expect(Date.now() - t0).toBeLessThan(2000);
    if (err !== undefined) expect(err).toBeInstanceOf(WaitRegexError);
  });

  it("the matcher keeps working after a timeout", () => {
    const slow = compileTextMatcher("a*a*a*a*a*a*a*a*a*b");
    try {
      slow.test("a".repeat(WAIT_TEXT_MAX));
    } catch {}
    expect(compileTextMatcher("ok").test("ok")).toBe(true);
  });
});
