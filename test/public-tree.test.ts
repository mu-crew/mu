import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Tracked files carry no real home path, and no term from the local term
// list (one term per line, `#` comments) at $MU_PUBLIC_TERMS, else
// ~/.config/mu/public-terms.txt. Not $XDG_CONFIG_HOME: test/_setup.ts points
// that at a scratch dir. Without the file only home paths are checked.

const ROOT = join(import.meta.dirname, "..");
const SELF = "test/public-tree.test.ts";

/** Placeholder user names that may appear in /Users/<name>/ or /home/<name>/. */
const PLACEHOLDER_USERS = new Set(["u", "someone", "x", "alice", "real", "me"]);

/** A home path at a path start: not `<sandbox>/home/...` or `/sb/home/...`. */
const HOME_PATH = /(?<![\w>.}-])\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g;

/** The local term list, matched case-insensitively. Empty when there is none. */
function localTerms(): string[] {
  const file = process.env.MU_PUBLIC_TERMS || join(homedir(), ".config", "mu", "public-terms.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** Lines matching one of these are not scanned. */
const ALLOWED_LINE = [
  /pi-meta/,
  /-sol\b/,
  /CLAUDE_LAUNCHER_SESSION_FILE/,
  /github\.com\/martintrojer/,
];
/** Files whose author lines name the real author on purpose. */
const ALLOWED_FILE = new Set([".mailmap"]);

function scanText(text: string, terms: readonly string[] = []): string[] {
  const hits: string[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (ALLOWED_LINE.some((re) => re.test(line))) continue;
    for (const m of line.matchAll(HOME_PATH)) {
      const user = m[1] ?? "";
      if (!PLACEHOLDER_USERS.has(user)) hits.push(`${i + 1}: home path ${m[0]}`);
    }
    const lower = line.toLowerCase();
    for (const term of terms) {
      if (lower.includes(term.toLowerCase())) hits.push(`${i + 1}: term ${term}`);
    }
  }
  return hits;
}

function trackedFiles(): string[] | undefined {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\0").filter((f) => f.length > 0);
  } catch {
    return undefined; // not a git checkout (a tarball): nothing to guard
  }
}

describe("public tree", () => {
  it("scanText flags a real home path and a listed term, not placeholders", () => {
    expect(scanText("- file: /Users/jdoe/.local/state/x.jsonl")).toHaveLength(1);
    expect(scanText("see /home/jdoe/src")).toHaveLength(1);
    expect(scanText("uses ACME hosts", ["acme"])).toHaveLength(1);
    expect(scanText("uses ACME hosts")).toEqual([]);
    expect(scanText("/Users/alice/x /home/me/ws <sandbox>/home/.local /sb/home/.local")).toEqual(
      [],
    );
    expect(scanText("- file: ~/.local/state/mu-next/x.jsonl")).toEqual([]);
  });

  it("tracked text files carry no real home path or listed term", () => {
    const files = trackedFiles();
    if (!files) return;
    const terms = localTerms();
    const failures: string[] = [];
    for (const file of files) {
      if (file === SELF || ALLOWED_FILE.has(file)) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(join(ROOT, file));
      } catch {
        continue; // deleted in the working tree
      }
      if (buf.includes(0)) continue; // binary
      for (const hit of scanText(buf.toString("utf8"), terms)) failures.push(`${file}:${hit}`);
    }
    expect(failures).toEqual([]);
  });
});
