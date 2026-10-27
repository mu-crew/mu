// mu — the bounded regex behind `mu wait --until-text`.
//
// A JavaScript RegExp can run for minutes on a pathological pattern
// (`(a+)+$`), and length limits do not change that. Two guards, no
// dependency:
//
//   1. A grammar. Only literals, classes, `.`, anchors, groups,
//      alternation and quantifiers are accepted. Backreferences, lookaround,
//      named groups and counts over 1000 are refused, and so is a quantified
//      group whose body holds a quantifier or an alternation (`(a+)+`,
//      `(a|aa)*`): the shapes that backtrack exponentially.
//   2. A budget. The match runs in a `node:vm` context with a hard timeout,
//      on at most the last WAIT_TEXT_MAX characters. What the grammar misses
//      (polynomial `a*a*a*b`) ends in a typed error, never a hang.
//
// The text matched is a ctl `lastText`, a task report, or (non-pi agents)
// captured pane text (wait-ctl.ts, wait.ts); the caller passes it already
// bounded or we tail it.

import { createContext, Script } from "node:vm";

export const WAIT_REGEX_MAX_LEN = 200;
/** Only this many trailing characters of a text are matched. */
export const WAIT_TEXT_MAX = 8192;
export const WAIT_REGEX_TIMEOUT_MS = 50;
const MAX_COUNT = 1000;

/** The pattern is refused (grammar, size, syntax) or its match ran out of budget. */
export class WaitRegexError extends Error {
  override readonly name = "WaitRegexError";
}

export interface TextMatcher {
  readonly source: string;
  /** Does the (tail of the) text match? Throws WaitRegexError past the time budget. */
  test(text: string): boolean;
}

interface Group {
  quant: boolean;
  alt: boolean;
}

/** The quantifier at `i` (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`): its length and counts, or undefined. */
function quantifierAt(src: string, i: number): { len: number; counts: number[] } | undefined {
  const c = src[i];
  if (c === "*" || c === "+" || c === "?") return { len: 1, counts: [] };
  if (c !== "{") return undefined;
  const m = /^\{(\d+)(?:,(\d*))?\}/.exec(src.slice(i, i + 24));
  if (m === null) return undefined;
  const counts = [Number(m[1])];
  if (m[2] !== undefined && m[2] !== "") counts.push(Number(m[2]));
  return { len: m[0].length, counts };
}

function refuse(why: string): never {
  throw new WaitRegexError(`--until-text: ${why}`);
}

/** Throws WaitRegexError unless `src` is inside the accepted grammar. */
export function checkRegexGrammar(src: string): void {
  if (src === "") refuse("the pattern is empty");
  if (src.length > WAIT_REGEX_MAX_LEN) {
    refuse(`the pattern is ${src.length} characters; the limit is ${WAIT_REGEX_MAX_LEN}`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (/[\u0000-\u001f\u007f]/.test(src)) refuse("the pattern has control characters");
  const stack: Group[] = [];
  let top: Group = { quant: false, alt: false };
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      if (/[1-9k]/.test(n)) refuse("backreferences are not supported");
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      if (src[i + 1] === "?") {
        if (src[i + 2] !== ":") refuse("lookaround and named groups are not supported");
        i += 2;
      }
      stack.push(top);
      top = { quant: false, alt: false };
      continue;
    }
    if (c === ")") {
      const parent = stack.pop();
      if (parent === undefined) refuse("unbalanced `)`");
      const q = quantifierAt(src, i + 1);
      if (q !== undefined && (top.quant || top.alt)) {
        refuse("a repeated group may not contain a repeat or an alternation");
      }
      parent.quant ||= top.quant || q !== undefined;
      parent.alt ||= top.alt;
      top = parent;
      continue;
    }
    if (c === "|") {
      top.alt = true;
      continue;
    }
    const q = quantifierAt(src, i);
    if (q !== undefined) {
      if (q.counts.some((n) => n > MAX_COUNT)) refuse(`a repeat count is over ${MAX_COUNT}`);
      top.quant = true;
      i += q.len - 1;
    }
  }
  if (stack.length > 0) refuse("unbalanced `(`");
}

const SCRIPT = new Script("new RegExp(src).test(text)");

/** Validate `src` and return a matcher with the time and size budget applied. */
export function compileTextMatcher(src: string): TextMatcher {
  checkRegexGrammar(src);
  try {
    new RegExp(src);
  } catch (e) {
    refuse(`not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
  }
  const ctx = createContext({ src, text: "" });
  return {
    source: src,
    test(text: string): boolean {
      ctx.text = text.length > WAIT_TEXT_MAX ? text.slice(-WAIT_TEXT_MAX) : text;
      try {
        return SCRIPT.runInContext(ctx, { timeout: WAIT_REGEX_TIMEOUT_MS }) === true;
      } catch (e) {
        throw new WaitRegexError(
          `--until-text: matching exceeded ${WAIT_REGEX_TIMEOUT_MS} ms (${e instanceof Error ? e.message : String(e)}); use a simpler pattern`,
        );
      }
    },
  };
}
