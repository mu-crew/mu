// mu — `-` as a text argument: read the text from stdin.
//
// Prose (notes, briefs) breaks shell quoting: an apostrophe ends '...',
// and "..." expands $VAR and backticks. A quoted heredoc piped to `-`
// needs no quoting at all: `mu task note x - <<'EOF' ... EOF`.

import { UsageError } from "./handle.js";

/** The argument value that means "read the text from stdin". */
export const STDIN_ARG = "-";

type StdinReader = () => Promise<string>;

async function readProcessStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

let reader: StdinReader | null = null;

/** Test seam: replace the stdin reader (null restores process.stdin). */
export function setStdinReaderForTests(fn: StdinReader | null): void {
  reader = fn;
}

/** Read the text verbatim, minus all trailing newlines (as bash
 *  `$(...)` strips them); interior newlines are kept.
 *  Empty input is a UsageError: `-` with nothing piped is a mistake. */
export async function readStdinText(what: string): Promise<string> {
  const text = (await (reader ?? readProcessStdin)()).replace(/\n+$/, "");
  if (text.trim() === "") {
    throw new UsageError(`${what} is "-" but stdin was empty; pipe the text in: <<'EOF' ... EOF`);
  }
  return text;
}
