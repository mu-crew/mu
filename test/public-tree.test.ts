import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The repo is public. The public audit (ee966368, 623f999a, 8a69c900) removed
// real home paths and internal-infra names; a later commit from a pre-audit
// branch put one back. This guard fails the fast gate on a reintroduction.

const ROOT = join(import.meta.dirname, "..");
const SELF = "test/public-tree.test.ts";

/** Placeholder user names that may appear in /Users/<name>/ or /home/<name>/. */
const PLACEHOLDER_USERS = new Set(["u", "someone", "x", "alice", "real", "me"]);

/** A home path at a path start: not `<sandbox>/home/...` or `/sb/home/...`. */
const HOME_PATH = /(?<![\w>.}-])\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g;

/** Terms the audit removed. Matched case-insensitively. */
const MUST_GO = [
  "LAUNCHER",
  "llm-router",
  "openai-proxy",
  "log_shipper",
  "policy_plugin",
  "linuxpc",
  "devserver",
  "pi-dist",
  "Agent Launcher",
  "hacking/crew",
];

/**
 * Kept judgment calls from the audit: a line matching one of these is not
 * scanned. They contain no must-go term today; the list pins that they stay
 * allowed if one is ever written next to them.
 */
const ALLOWED_LINE = [
  /pi-meta/,
  /-sol\b/,
  /CLAUDE_LAUNCHER_SESSION_FILE/,
  /github\.com\/martintrojer/,
];
/** Files whose author lines name the real author on purpose. */
const ALLOWED_FILE = new Set([".mailmap"]);

function scanText(text: string): string[] {
  const hits: string[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (ALLOWED_LINE.some((re) => re.test(line))) continue;
    for (const m of line.matchAll(HOME_PATH)) {
      const user = m[1] ?? "";
      if (!PLACEHOLDER_USERS.has(user)) hits.push(`${i + 1}: home path ${m[0]}`);
    }
    const lower = line.toLowerCase();
    for (const term of MUST_GO) {
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
  it("scanText flags a real home path and a must-go term, not placeholders", () => {
    expect(scanText("- file: /Users/jdoe/.local/state/x.jsonl")).toHaveLength(1);
    expect(scanText("see /home/jdoe/src")).toHaveLength(1);
    expect(scanText("uses DEVSERVER hosts")).toHaveLength(1);
    expect(scanText("/Users/alice/x /home/me/ws <sandbox>/home/.local /sb/home/.local")).toEqual(
      [],
    );
    expect(scanText("- file: ~/.local/state/mu-next/x.jsonl")).toEqual([]);
  });

  it("tracked text files carry no real home path or audit must-go term", () => {
    const files = trackedFiles();
    if (!files) return;
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
      for (const hit of scanText(buf.toString("utf8"))) failures.push(`${file}:${hit}`);
    }
    expect(failures).toEqual([]);
  });
});
