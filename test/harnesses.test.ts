// The harness table (spec D6): one frozen row per blessed harness, the facts U0
// observed, and `null` exactly where U0 left a fact unverified.

import { describe, expect, it } from "vitest";
import {
  HARNESS_TABLE,
  HARNESSES,
  type Harness,
  harnessFor,
  harnessHomePath,
  harnessOfCli,
  hookConfigLabel,
  hookConfigPath,
  isHarness,
  withSpawnPresets,
} from "../src/harnesses.js";

function deeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

describe("HARNESS_TABLE", () => {
  it("has one row per blessed harness, keyed by its own id", () => {
    expect(Object.keys(HARNESS_TABLE).sort()).toEqual([...HARNESSES].sort());
    for (const id of HARNESSES) expect(HARNESS_TABLE[id].id).toBe(id);
  });

  it("is frozen all the way down", () => {
    expect(deeplyFrozen(HARNESS_TABLE)).toBe(true);
    expect(() => {
      (HARNESS_TABLE.claude.events.turn_stopped as { name: string }[]).push({ name: "x" });
    }).toThrow();
  });

  it("pi stays on ctl; the other four default to the hooks channel", () => {
    expect(HARNESS_TABLE.pi.defaultChannel).toBe("ctl");
    for (const id of HARNESSES.filter((h) => h !== "pi")) {
      expect(HARNESS_TABLE[id].defaultChannel).toBe("hooks");
    }
  });

  it("every harness clears the input with C-u and interrupts with Escape (pi only on its hooks fallback)", () => {
    for (const id of HARNESSES) expect(HARNESS_TABLE[id].interruptKey).toBe("Escape");
    for (const id of HARNESSES) expect(HARNESS_TABLE[id].clearInputKey).toBe("C-u");
  });

  it("records the per-harness facts U0 observed", () => {
    expect(HARNESS_TABLE.claude.freshCommand).toBe("/clear");
    expect(HARNESS_TABLE["cursor-agent"].freshCommand).toBe("/new-chat");
    // claude's /clear fires SessionStart at once; codex and muse on the first prompt (D6).
    expect(HARNESS_TABLE.claude.freshSessionStart).toBe("immediate");
    expect(HARNESS_TABLE.codex.freshSessionStart).toBe("first-prompt");
    expect(HARNESS_TABLE.muse.freshSessionStart).toBe("first-prompt");
    expect(HARNESS_TABLE["cursor-agent"].freshSessionStart).toBeNull();
    // Only cursor-agent's text can arrive after its stop (afterAgentResponse).
    expect(HARNESSES.filter((h) => HARNESS_TABLE[h].textFollowsStop)).toEqual(["cursor-agent"]);
    expect(HARNESS_TABLE.codex.events.interrupted).toEqual([{ name: "Interrupt" }]);
    expect(HARNESS_TABLE.claude.events.interrupted).toEqual([]);
    expect(HARNESS_TABLE["cursor-agent"].events.permission_requested).toEqual([]);
    expect(HARNESS_TABLE.muse.hookEnv).toBe("allowlist");
    expect(HARNESS_TABLE.muse.canBlockOnStop).toBe(false);
    expect(HARNESS_TABLE["cursor-agent"].neverStore).toContain("CURSOR_ASKPASS_SECRET");
    expect(HARNESS_TABLE["cursor-agent"].sessionsBackedUp).toBe(false);
    expect(HARNESS_TABLE.codex.trustFlag.join(" ")).toContain("<realpath>");
  });

  it("leaves exactly the facts U0 did not verify unknown (null)", () => {
    const open: string[] = [];
    for (const id of HARNESSES) {
      const h = HARNESS_TABLE[id];
      if (h.events.turn_failed === null) open.push(`${id}.turn_failed`);
      if (h.sessions === null) open.push(`${id}.sessions`);
      if (h.skillLocation === null) open.push(`${id}.skillLocation`);
    }
    expect(open.sort()).toEqual(
      ["codex.turn_failed", "muse.turn_failed", "pi.turn_failed", "muse.sessions"].sort(),
    );
  });

  it("tells cursor-agent's stop outcomes apart by status", () => {
    const e = HARNESS_TABLE["cursor-agent"].events;
    expect(e.turn_stopped).toEqual([{ name: "stop", status: "completed" }]);
    expect(e.turn_failed).toEqual([{ name: "stop", status: "error" }]);
    expect(e.interrupted).toEqual([{ name: "stop", status: "aborted" }]);
  });

  it("maps each native event (with its qualifier) to at most one normalized event", () => {
    for (const id of HARNESSES) {
      const seen = new Map<string, string>();
      for (const [normalized, natives] of Object.entries(HARNESS_TABLE[id].events)) {
        for (const n of natives ?? []) {
          const key = `${n.name}|${n.status ?? ""}`;
          expect(seen.get(key), `${id} ${key}`).toBeUndefined();
          seen.set(key, normalized);
        }
      }
    }
  });

  it("carries murmur's argv-match fields: pi and cursor-agent run under an interpreter", () => {
    for (const id of HARNESSES) expect(HARNESS_TABLE[id].names).toContain(id);
    expect(HARNESS_TABLE.pi.packages).toEqual(["pi-coding-agent"]);
    expect(HARNESS_TABLE["cursor-agent"].packages).toEqual(["cursor-agent"]);
  });

  it("never points a skill at the shared ~/.agents/skills directory", () => {
    for (const id of HARNESSES)
      expect(HARNESS_TABLE[id].skillLocation ?? "").not.toContain(".agents");
  });
});

describe("harnessFor", () => {
  it("finds a blessed harness by its cli key and nothing else", () => {
    expect(harnessFor("cursor-agent")?.displayName).toBe("cursor-agent");
    expect(harnessFor("pi")?.defaultChannel).toBe("ctl");
    expect(harnessFor("sh")).toBeUndefined();
    expect(harnessFor("constructor")).toBeUndefined();
    expect(isHarness("codex")).toBe(true);
    expect(isHarness("toString")).toBe(false);
    expect(isHarness(7)).toBe(false);
  });
});

describe("harness from key (spec D17)", () => {
  it("argv0's basename first, then the key, then the key's prefix before - or _", () => {
    expect(harnessOfCli("big", "/opt/bin/codex.real --x")).toBe("codex");
    expect(harnessOfCli("claude-big")).toBe("claude");
    expect(harnessOfCli("muse_fast")).toBe("muse");
    expect(harnessOfCli("cursor-agent")).toBe("cursor-agent");
    expect(harnessOfCli("pi-meta")).toBe("pi");
    expect(harnessOfCli("aider")).toBeUndefined();
  });

  it("a fresh session reports itself at startup except in codex and muse (U0)", () => {
    expect(
      HARNESSES.filter((h) => HARNESS_TABLE[h].startupSessionStart === "first-prompt"),
    ).toEqual(["codex", "muse"]);
  });
});

describe("withSpawnPresets (spec D6, D17)", () => {
  it("adds the row's auto-approve flags to a worker, and pi gets none", () => {
    expect(withSpawnPresets("claude", "claude", { approve: true })).toBe(
      "claude --permission-mode acceptEdits",
    );
    expect(withSpawnPresets("codex", "codex", { approve: true })).toBe(
      "codex -s workspace-write -a never",
    );
    expect(withSpawnPresets("cursor-agent", "cursor-agent", { approve: true })).toBe(
      "cursor-agent --sandbox enabled",
    );
    expect(withSpawnPresets("muse", "muse", { approve: true })).toBe("muse --approval-mode never");
    expect(withSpawnPresets("pi-meta --no-solo", "pi", { approve: true })).toBe(
      "pi-meta --no-solo",
    );
    expect(withSpawnPresets("aider", undefined, { approve: true, model: "x" })).toBe("aider");
  });

  it("adds no auto-approve flag to a command that already picks its approval or sandbox mode", () => {
    const keeps = (command: string, harness: Harness): void => {
      expect(withSpawnPresets(command, harness, { approve: true })).toBe(command);
    };
    keeps("codex -s read-only", "codex");
    keeps("codex -sread-only", "codex");
    keeps("codex --sandbox danger-full-access", "codex");
    keeps("codex --sandbox=read-only", "codex");
    keeps("codex --ask-for-approval=untrusted", "codex");
    keeps("codex --yolo", "codex");
    keeps("codex --full-auto", "codex");
    keeps("codex --dangerously-bypass-approvals-and-sandbox", "codex");
    keeps("claude --permission-mode plan", "claude");
    keeps("claude --permission-mode=plan", "claude");
    keeps("claude --dangerously-skip-permissions", "claude");
    keeps("cursor-agent --sandbox=disabled", "cursor-agent");
    keeps("cursor-agent --force", "cursor-agent");
    keeps("muse --yolo", "muse");
    keeps("muse --approval-mode=on-request", "muse");
    // Other options do not count: the model flag still gets the preset.
    expect(withSpawnPresets("codex --model gpt-5", "codex", { approve: true })).toBe(
      "codex --model gpt-5 -s workspace-write -a never",
    );
  });

  it("lists every auto-approve option among the row's approval options", () => {
    for (const h of HARNESSES) {
      const row = HARNESS_TABLE[h];
      for (const word of row.autoApproveFlags.filter((w) => w.startsWith("-"))) {
        expect(row.approvalOptions).toContain(word);
      }
    }
  });

  it("passes --model through the row's model flag, pi included", () => {
    expect(withSpawnPresets("pi", "pi", { approve: false, model: "sonnet:high" })).toBe(
      "pi --model sonnet:high",
    );
    expect(withSpawnPresets("codex", "codex", { approve: false, model: "gpt 5" })).toBe(
      "codex --model 'gpt 5'",
    );
  });

  it("fills the trust flag with the worktree's real path, as one shell word", () => {
    expect(withSpawnPresets("codex", "codex", { approve: false, trustPath: "/w/it's" })).toBe(
      `codex -c 'projects."/w/it'"'"'s".trust_level="trusted"'`,
    );
    expect(withSpawnPresets("muse", "muse", { approve: false, trustPath: "/w" })).toBe(
      "muse --trust-workspace",
    );
    expect(withSpawnPresets("claude", "claude", { approve: false, trustPath: "/w" })).toBe(
      "claude",
    );
    expect(withSpawnPresets("pi", "pi", { approve: false, trustPath: "/w" })).toBe("pi");
  });
});

describe("CLAUDE_CONFIG_DIR and CODEX_HOME move claude's and codex's config", () => {
  const env = { CLAUDE_CONFIG_DIR: "/c/claude", CODEX_HOME: "/c/codex" };
  it("hook files and skill dirs follow the variable; the others stay under home", () => {
    expect(hookConfigPath("claude", "/h", env)).toBe("/c/claude/settings.json");
    expect(hookConfigPath("codex", "/h", env)).toBe("/c/codex/hooks.json");
    expect(hookConfigPath("cursor-agent", "/h", env)).toBe("/h/.cursor/hooks.json");
    expect(hookConfigPath("muse", "/h", env)).toBe("/h/.config/muse/settings.json");
    expect(hookConfigPath("pi", "/h", env)).toBeUndefined();
    expect(harnessHomePath("codex", ".codex/skills", "/h", env)).toBe("/c/codex/skills");
    expect(harnessHomePath("claude", ".claude", "/h", env)).toBe("/c/claude");
    // only the directory the variable names moves
    expect(harnessHomePath("claude", ".claude.json", "/h", env)).toBe("/h/.claude.json");
    expect(harnessHomePath("claude", ".codex/skills", "/h", env)).toBe("/h/.codex/skills");
  });

  it("unset or empty is the home directory", () => {
    expect(hookConfigPath("claude", "/h", {})).toBe("/h/.claude/settings.json");
    expect(hookConfigPath("codex", "/h", { CODEX_HOME: "" })).toBe("/h/.codex/hooks.json");
  });

  it("messages name the variable", () => {
    // `${VAR:-~/dir}/file`, as a shell would spell it
    expect(hookConfigLabel("claude")).toMatch(
      /^\$\{CLAUDE_CONFIG_DIR:-~\/\.claude\}\/settings\.json$/,
    );
    expect(hookConfigLabel("codex")).toMatch(/^\$\{CODEX_HOME:-~\/\.codex\}\/hooks\.json$/);
    expect(hookConfigLabel("cursor-agent")).toBe("~/.cursor/hooks.json");
  });
});
