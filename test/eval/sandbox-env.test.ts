import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeSandboxDir, sandboxEnv, tmuxSocketPath } from "../../tools/eval/sandbox.ts";
import type { Surface } from "../../tools/eval/types.ts";

const surface: Surface = {
  name: "s",
  root: "/s",
  cli: "/s/dist/cli.js",
  extension: "/s/dist/extension/mu-pi.js",
  skillDir: "/s/skills/mu",
};

const BASE: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  TERM: "xterm",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  USER: "me",
  SHELL: "/bin/zsh",
  PROVIDER_BASE_URL: "http://x",
  MU_DB_PATH: "/real/mu.db",
  MU_NUDGE: "0",
  MU_AGENT_NAME: "boss",
  TMUX: "/tmp/tmux-1/default,1,0",
  TMUX_PANE: "%1",
  HERDR_SESSION: "real",
  PI_CODING_AGENT_DIR: "/real/pi",
  SECRET_TOKEN: "nope",
  HOME: "/home/real",
};

describe("sandboxEnv", () => {
  const dir = "/tmp/mu-eval-1-2-abc";
  const env = sandboxEnv(dir, surface, "mu-eval-1-2-abc", BASE);

  it("drops MU_*, TMUX*, HERDR_*, PI_* and unlisted vars from base", () => {
    expect(env.MU_AGENT_NAME).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env.HERDR_SESSION).toBeUndefined();
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PROVIDER_BASE_URL).toBeUndefined();
    expect(env.MU_DB_PATH).toBe(`${dir}/state/mu.db`);
    expect(env.PI_CODING_AGENT_DIR).toBe(`${dir}/pi-agent`);
    expect(env.HOME).toBe(`${dir}/home`);
  });

  it("keeps the whitelist and sets every isolation var", () => {
    expect(env).toMatchObject({
      TERM: "xterm",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      USER: "me",
      SHELL: "/bin/zsh",
      XDG_STATE_HOME: `${dir}/home/.local/state`,
      XDG_CACHE_HOME: `${dir}/home/.cache`,
      MU_STATE_DIR: `${dir}/state`,
      MU_SYNC_DIR: `${dir}/sync`,
      MU_TMUX_SOCKET: "mu-eval-1-2-abc",
      MU_MUX: "tmux",
      GIT_AUTHOR_NAME: "eval",
      GIT_AUTHOR_EMAIL: "eval@example.invalid",
      GIT_COMMITTER_NAME: "eval",
      GIT_COMMITTER_EMAIL: "eval@example.invalid",
      EVAL_WORKER_DIR: `${dir}/workers`,
      PATH: `${dir}/bin:/usr/bin:/bin`,
    });
  });

  it("keeps only system dirs on PATH, so host tool installs and docs are out of reach", () => {
    const e = sandboxEnv(dir, surface, "s", {
      PATH: "/home/me/.local/bin:/home/me/.local/share/mise/installs/x/bin:/usr/local/bin:/usr/bin:/bin",
    });
    expect(e.PATH).toBe(`${dir}/bin:/usr/local/bin:/usr/bin:/bin`);
  });

  it("never sets MU_NUDGE (the AUT keeps its nudges)", () => {
    expect(env.MU_NUDGE).toBeUndefined();
  });

  it("keeps the DB outside the sync dir", () => {
    expect(env.MU_DB_PATH?.startsWith(`${env.MU_SYNC_DIR}/`)).toBe(false);
  });
});

describe("sandboxEnv tmux isolation", () => {
  it("points TMUX_TMPDIR inside the sandbox, so even bare tmux never sees the default server", () => {
    const dir = "/tmp/mu-eval-1-2-abc";
    const env = sandboxEnv(dir, surface, "mu-eval-1-2-abc", { ...BASE, TMUX_TMPDIR: "/real/tmp" });
    expect(env.TMUX_TMPDIR).toBe(`${dir}/tmux-tmp`);
    expect(tmuxSocketPath(dir, "mu-eval-1-2-abc")).toBe(
      `${dir}/tmux-tmp/tmux-${process.getuid?.() ?? 0}/mu-eval-1-2-abc`,
    );
  });
});

describe("sandboxEnv family", () => {
  it("sets EVAL_SURFACE_FAMILY from the surface, default 3x, never from the caller's env", () => {
    const dir = "/tmp/mu-eval-1-2-abc";
    const base = { ...BASE, EVAL_SURFACE_FAMILY: "next" };
    expect(sandboxEnv(dir, surface, "x", base).EVAL_SURFACE_FAMILY).toBe("3x");
    expect(sandboxEnv(dir, { ...surface, family: "next" }, "x", base).EVAL_SURFACE_FAMILY).toBe(
      "next",
    );
  });
});

describe("removeSandboxDir", () => {
  it("removes the dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-eval-rm-"));
    mkdirSync(join(dir, "murmur", "x"), { recursive: true });
    writeFileSync(join(dir, "murmur", "x", "f"), "1");
    removeSandboxDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  // root removes a read-only dir anyway
  it.skipIf(process.getuid?.() === 0)(
    "warns instead of throwing when the dir cannot be removed",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "mu-eval-rm-"));
      const dir = join(parent, "sb");
      mkdirSync(join(dir, "murmur"), { recursive: true });
      writeFileSync(join(dir, "murmur", "f"), "1");
      chmodSync(join(dir, "murmur"), 0o500);
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(() => removeSandboxDir(dir, 2, 0)).not.toThrow();
        expect(String(err.mock.calls[0]?.[0])).toContain(`left ${dir} behind`);
      } finally {
        err.mockRestore();
        chmodSync(join(dir, "murmur"), 0o700);
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
});
