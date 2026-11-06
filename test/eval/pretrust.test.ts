// Pre-trust with the outside world (tmux, the harness, its trust records) replaced: the dialog
// sequence of claude and codex, the bounded wait, and which harnesses a case pre-trusts.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeTrusted,
  codexHooksTrusted,
  type PretrustIO,
  pretrust,
  pretrustOne,
  pretrustTargets,
  promptReady,
} from "../../tools/eval/pretrust.ts";
import type { Sandbox, Surface } from "../../tools/eval/types.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pretrust-"));
  dirs.push(d);
  return d;
};

const surface: Surface = {
  name: "s",
  root: "/s",
  cli: "/s/dist/cli.js",
  extension: "/s/e.js",
  skillDir: "/s/skills/mu",
};

function sandbox(dir = "/sb"): Sandbox {
  return {
    dir,
    env: {},
    binDir: join(dir, "bin"),
    repoDir: join(dir, "repo"),
    workerDir: join(dir, "workers"),
    tmuxSocket: "t",
    dbPath: join(dir, "mu.db"),
    surface,
    close: async () => {},
  };
}

const CLAUDE_TRUST = [
  " Accessing workspace:",
  "",
  " /sb/repo",
  "",
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");
const CLAUDE_READY = [
  " ✻ Welcome",
  "─────────────────────────",
  "❯ ",
  "─────────────────────────",
  "  ? for shortcuts",
].join("\n");
const CODEX_FOLDER = "  Do you trust the files in this folder?\n› 1. Yes, continue\n  2. No, quit";
const CODEX_HOOKS = [
  "  Hooks need review",
  "  Hooks can run outside the sandbox after you trust them.",
  "› 1. Review hooks",
  "  2. Trust all and continue",
  "  3. Continue without trusting (hooks won't run)",
].join("\n");
const CODEX_READY = "› Explain this codebase\n\n  100% context left · ? for shortcuts";
// What a codex launcher's pane shows before codex's TUI draws: the login shell's prompt (zsh, one
// line ending with ❯, or a two-line prompt whose second line is ❯), the launcher's banner, and a
// plugin install line per plugin, for well over 10 s on a first start.
const CODEX_LAUNCHING = [
  "tmp/mu-eval-k3/repo ❯ /tmp/mu-eval-k3/bin/codex",
  "  codex launcher 2.4 · checking plugins",
  "Installing review-kit@team-market ...",
  "Installing docs-search@team-market ...",
].join("\n");
const ZSH_TWO_LINE = [
  "tmp/mu-eval-k3/repo on main",
  "❯ ",
  "Installing review-kit@team-market ...",
].join("\n");
// codex's own screens after the launcher: folder trust, hook review, then its ready screen.
const CODEX_FOLDER_LAUNCHER = [
  "  You are in /tmp/mu-eval-k3/repo",
  "",
  "  Do you trust the contents of this directory?",
  "",
  "› 1. Trust and continue",
  "  2. Back to the launcher",
].join("\n");
const CODEX_READY_LIVE = [
  "╭──────────────────────────────────────────╮",
  "│ >_ Codex (v0.164.0)                      │",
  "│ directory: /tmp/mu-eval-k3/repo          │",
  "╰──────────────────────────────────────────╯",
  "",
  "› Ask Codex to do anything",
  "",
  "  ? for shortcuts",
].join("\n");

interface Fake {
  io: PretrustIO;
  opened: { dir: string; command: string }[];
  keys: string[];
  closed: string[];
  clock: () => number;
}

/**
 * A pane that shows `screens` in turn, one per capture (the last one stays); a trusting Enter
 * records the trust when `recordOn` says so; C-c ends the process.
 */
function fake(
  screens: string[],
  o: { trustedBefore?: boolean; recordOn?: (keys: string[]) => boolean; exitsAt?: number } = {},
): Fake {
  let t = 0;
  let shown = 0;
  let alive = true;
  let trusted = o.trustedBefore === true;
  const f: Fake = { io: {} as PretrustIO, opened: [], keys: [], closed: [], clock: () => t };
  f.io = {
    open: (_sb, dir, command) => {
      f.opened.push({ dir, command });
      return "%9";
    },
    capture: () => {
      const s = screens[Math.min(shown, screens.length - 1)] ?? "";
      shown++;
      return s;
    },
    keys: (_sb, _pane, k) => {
      f.keys.push(k);
      if (k === "C-c") alive = false;
      if (k === "Enter" && (o.recordOn?.(f.keys) ?? true)) trusted = true;
    },
    pid: () => (alive && (o.exitsAt === undefined || t < o.exitsAt) ? 42 : null),
    close: (_sb, pane) => {
      f.closed.push(pane);
    },
    trusted: () => trusted,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return f;
}

describe("pretrustOne", () => {
  it("claude: moves off 'No, exit', trusts the folder, waits for the prompt, quits without one", async () => {
    const sb = sandbox();
    const f = fake(["", CLAUDE_TRUST, CLAUDE_TRUST, "", CLAUDE_READY]);
    const note = await pretrustOne(sb, { harness: "claude", dir: sb.repoDir }, f.io);
    expect(note).toBeNull();
    expect(f.opened).toEqual([{ dir: "/sb/repo", command: "/sb/bin/claude" }]);
    // one answer for the dialog, even while it is still on screen; no text is ever typed
    expect(f.keys).toEqual(["Down", "Enter", "C-c", "C-c"]);
    expect(f.closed).toEqual(["%9"]);
  });

  it("codex: answers its folder trust, then its hook review with 'Trust all and continue'", async () => {
    const sb = sandbox();
    const f = fake([CODEX_FOLDER, CODEX_HOOKS, CODEX_READY], {
      // codex records the hook trust on the hook review's answer
      recordOn: (keys) => keys.includes("Down"),
    });
    const note = await pretrustOne(sb, { harness: "codex", dir: sb.repoDir }, f.io);
    expect(note).toBeNull();
    expect(f.opened[0]?.command).toBe("/sb/bin/codex");
    expect(f.keys).toEqual(["Enter", "Down", "Enter", "C-c", "C-c"]);
    expect(f.closed).toEqual(["%9"]);
  });

  it("codex behind a launcher: no quit while it installs plugins; both dialogs, then its ready screen", async () => {
    const sb = sandbox();
    const f = fake(
      [
        ...Array<string>(40).fill(CODEX_LAUNCHING),
        ...Array<string>(4).fill(ZSH_TWO_LINE),
        CODEX_FOLDER_LAUNCHER,
        CODEX_HOOKS,
        "",
        CODEX_READY_LIVE,
      ],
      { recordOn: (keys) => keys.includes("Down") },
    );
    const note = await pretrustOne(sb, { harness: "codex", dir: sb.repoDir }, f.io);
    expect(note).toBeNull();
    // "Trust and continue" is under the cursor; "Trust all and continue" is one down.
    expect(f.keys).toEqual(["Enter", "Down", "Enter", "C-c", "C-c"]);
  });

  it("starts nothing when the trust is already on record", async () => {
    const sb = sandbox();
    const f = fake([CLAUDE_READY], { trustedBefore: true });
    expect(await pretrustOne(sb, { harness: "claude", dir: sb.repoDir }, f.io)).toBeNull();
    expect(f.opened).toEqual([]);
  });

  it("times out with a note, quits and closes the pane, and never hangs", async () => {
    const sb = sandbox();
    const f = fake(["Signing in…"], { recordOn: () => false });
    const note = await pretrustOne(sb, { harness: "claude", dir: sb.repoDir }, f.io, 10_000);
    expect(note).toMatch(/pre-trust claude in the sandbox repo: trust not on record/);
    expect(note).toMatch(/timeout/);
    expect(f.keys).toEqual(["C-c", "C-c"]);
    expect(f.closed).toEqual(["%9"]);
    expect(f.clock()).toBeLessThan(10_000 + 6_000);
  });

  it("a timeout with the trust unknowable says it could not confirm", async () => {
    const sb = sandbox();
    const f = fake(["Signing in…"]);
    f.io.trusted = () => null;
    const note = await pretrustOne(sb, { harness: "codex", dir: sb.repoDir }, f.io, 5_000);
    expect(note).toMatch(/could not confirm \(no ready prompt within 5 s, 0 dialogs answered\)/);
  });

  it("a stuck harness that ignores C-c is killed with its pane after a bounded wait", async () => {
    const sb = sandbox();
    const f = fake(["Signing in…"], { recordOn: () => false });
    const keys = f.io.keys;
    f.io.keys = (s, p, k) => keys(s, p, k === "C-c" ? "noop" : k);
    const note = await pretrustOne(sb, { harness: "claude", dir: sb.repoDir }, f.io, 2_000);
    expect(note).not.toBeNull();
    expect(f.closed).toEqual(["%9"]);
    expect(f.clock()).toBeLessThan(2_000 + 6_000);
  });

  it("a harness that exits after trusting is confirmed by its record", async () => {
    const sb = sandbox();
    const f = fake([CLAUDE_TRUST, ""], { exitsAt: 1500 });
    expect(await pretrustOne(sb, { harness: "claude", dir: sb.repoDir }, f.io)).toBeNull();
    expect(f.keys).toEqual(["Down", "Enter"]);
  });

  it("a pane that cannot open is a note, and pretrust collects every note without throwing", async () => {
    const sb = sandbox();
    const f = fake([CLAUDE_READY], { recordOn: () => false });
    f.io.trusted = () => false;
    f.io.open = () => null;
    const notes = await pretrust(
      sb,
      [
        { harness: "claude", dir: sb.repoDir },
        { harness: "codex", dir: sb.repoDir },
      ],
      f.io,
    );
    expect(notes).toEqual([
      "pre-trust claude in the sandbox repo: could not open a pane",
      "pre-trust codex in the sandbox repo: could not open a pane",
    ]);
  });
});

describe("promptReady", () => {
  it("sees claude's and codex's input prompts, each by its own marks", () => {
    expect(promptReady(CLAUDE_READY, "claude")).toBe(true);
    expect(promptReady(CODEX_READY, "codex")).toBe(true);
    expect(promptReady(CODEX_READY_LIVE, "codex")).toBe(true);
    // claude's input box before its footer is drawn
    expect(
      promptReady('╭────────────╮\n│ > Try "fix lint errors" │\n╰────────────╯', "claude"),
    ).toBe(true);
    expect(promptReady("────────────\n❯ \n────────────", "claude")).toBe(true);
  });
  it("is not ready at the shell's prompt or a launcher's install lines, before the TUI draws", () => {
    for (const h of ["claude", "codex"] as const) {
      expect(promptReady(CODEX_LAUNCHING, h)).toBe(false);
      expect(promptReady(ZSH_TWO_LINE, h)).toBe(false);
      expect(promptReady("> ", h)).toBe(false);
    }
    // codex: its input line with no footer yet, or another harness's box, is not its ready screen
    expect(promptReady("› Ask Codex to do anything", "codex")).toBe(false);
    expect(promptReady("────────────\n❯ \n────────────", "codex")).toBe(false);
  });
  it("is not ready at a dialog, a selector or a blank screen", () => {
    for (const h of ["claude", "codex"] as const) {
      expect(promptReady(CLAUDE_TRUST, h)).toBe(false);
      expect(promptReady(CODEX_HOOKS, h)).toBe(false);
      expect(promptReady(CODEX_FOLDER_LAUNCHER, h)).toBe(false);
      expect(promptReady(" ❯ 1. Dark mode\n   2. Light mode\n Enter to confirm", h)).toBe(false);
      expect(promptReady("", h)).toBe(false);
    }
  });
});

describe("pretrustTargets", () => {
  const sb = sandbox();
  it("pre-trusts the AUT's harness and each harness the worker mix names", () => {
    expect(
      pretrustTargets(
        sb,
        { hookHarnesses: { workers: ["claude", "codex"] } },
        { aut: "pi", codexHooks: "codex-home" },
      ),
    ).toEqual([
      { harness: "claude", dir: "/sb/repo" },
      { harness: "codex", dir: "/sb/repo" },
    ]);
    expect(pretrustTargets(sb, {}, { aut: "codex", codexHooks: "codex-home" })).toEqual([
      { harness: "codex", dir: "/sb/repo" },
    ]);
  });
  it("codex only with a sandbox CODEX_HOME", () => {
    expect(
      pretrustTargets(
        sb,
        { hookHarnesses: { workers: ["codex (implementer)", "claude (reviewer)"] } },
        { aut: "codex", codexHooks: "global" },
      ),
    ).toEqual([{ harness: "claude", dir: "/sb/repo" }]);
  });
  it("claude also in each ssh host's clone", () => {
    const d = tmp();
    mkdirSync(join(d, "repo"));
    mkdirSync(join(d, "hosts", "dev", "home", "repo"), { recursive: true });
    const t = pretrustTargets(
      sandbox(d),
      { hookHarnesses: { workers: ["claude@dev"] } },
      { aut: "pi", codexHooks: "codex-home" },
    );
    expect(t).toEqual([
      { harness: "claude", dir: join(d, "repo") },
      { harness: "claude", dir: join(d, "hosts", "dev", "home", "repo") },
    ]);
  });
  it("nothing for a mix of other harnesses", () => {
    expect(
      pretrustTargets(
        sb,
        { hookHarnesses: { workers: ["pi", "cursor-agent", "muse"] } },
        { aut: "pi", codexHooks: "codex-home" },
      ),
    ).toEqual([]);
  });
});

describe("trust records (read only)", () => {
  it("claude: the folder itself accepted in ~/.claude.json, not an ancestor", () => {
    const d = tmp();
    const repo = join(d, "a", "repo");
    mkdirSync(repo, { recursive: true });
    const f = join(d, ".claude.json");
    expect(claudeTrusted(f, repo)).toBeNull();
    writeFileSync(f, JSON.stringify({ projects: {} }));
    expect(claudeTrusted(f, repo)).toBe(false);
    writeFileSync(
      f,
      JSON.stringify({ projects: { [claudeRealpath(repo)]: { hasTrustDialogAccepted: true } } }),
    );
    expect(claudeTrusted(f, repo)).toBe(true);
    writeFileSync(
      f,
      JSON.stringify({
        projects: { [claudeRealpath(join(d, "a"))]: { hasTrustDialogAccepted: true } },
      }),
    );
    expect(claudeTrusted(f, repo)).toBe(false);
  });

  it("codex: a trusted_hash for EVERY hook of the home's own hooks.json", () => {
    const home = tmp();
    expect(codexHooksTrusted(home)).toBeNull();
    writeFileSync(
      join(home, "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "murmur hook codex" }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "murmur hook codex" }] }],
          Stop: [
            {
              hooks: [
                { type: "command", command: "murmur hook codex" },
                { type: "command", command: "mu hook stop codex --timeout 600 || true" },
              ],
            },
          ],
        },
      }),
    );
    const key = (id: string, file = join(home, "hooks.json")) =>
      `[hooks.state."${file}:${id}"]\ntrusted_hash = "sha256:${id.length}"\n`;
    const write = (body: string) => writeFileSync(join(home, "config.toml"), body);
    expect(codexHooksTrusted(home)).toBeNull();
    write(key("stop:0:0", "/elsewhere/.codex/hooks.json"));
    expect(codexHooksTrusted(home)).toBe(false);
    // One trusted hook (what the old check passed on) is not enough: codex reviews the other three.
    write(`model = "m"\n\n[hooks.state]\n\n${key("session_start:0:0")}`);
    expect(codexHooksTrusted(home)).toBe(false);
    write([key("session_start:0:0"), key("user_prompt_submit:0:0"), key("stop:0:0")].join("\n"));
    expect(codexHooksTrusted(home)).toBe(false);
    // A table for the hook without its hash is no trust either.
    write(
      [
        key("session_start:0:0"),
        key("user_prompt_submit:0:0"),
        key("stop:0:0"),
        `[hooks.state."${join(home, "hooks.json")}:stop:0:1"]\nenabled = true\n`,
      ].join("\n"),
    );
    expect(codexHooksTrusted(home)).toBe(false);
    write(
      [
        `[projects."/tmp/r"]\ntrust_level = "trusted"\n`,
        key("session_start:0:0"),
        key("user_prompt_submit:0:0"),
        key("stop:0:0"),
        key("stop:0:1", join(realpathSync(home), "hooks.json")),
      ].join("\n"),
    );
    expect(codexHooksTrusted(home)).toBe(true);
  });
});

/** macOS: /var is /private/var; claude keys a project by its real path. */
const claudeRealpath = (p: string): string => realpathSync(p);
