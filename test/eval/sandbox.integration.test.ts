// Real tmux: no tmux invocation from inside a sandbox may reach the default server.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSandbox,
  realTmux,
  resolveRealTmux,
  sh,
  tmuxSocketPath,
} from "../../tools/eval/sandbox.ts";
import type { Sandbox, Surface } from "../../tools/eval/types.ts";

const surface: Surface = {
  name: "s",
  root: "/s",
  cli: "/s/dist/cli.js",
  extension: "/s/dist/extension/mu-pi.js",
  skillDir: "/s/skills/mu",
};

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("sandbox without tmux", () => {
  it("imports without tmux on PATH, and createSandbox rejects before touching disk", () => {
    const mod = join(import.meta.dirname, "..", "..", "tools", "eval", "sandbox.ts");
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(mod)});
try { await m.createSandbox(${JSON.stringify(surface)}); console.log("no-throw"); } catch (e) { console.log(String(e.message)); }`,
      ],
      { env: { PATH: "/nonexistent" }, encoding: "utf8", timeout: 20_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tmux not found on PATH");
  });
});

describe.skipIf(!hasTmux())("sandbox tmux isolation", () => {
  let sb: Sandbox | undefined;
  afterEach(async () => {
    try {
      await sb?.close();
    } catch {}
    sb = undefined;
  });

  it("bare tmux, absolute-path tmux and env-scrubbed tmux all resolve under the sandbox dir", async () => {
    sb = await createSandbox(surface);
    // start-server + display-message only ever touch the server they land on (the sandbox's own)
    const probe = "start-server \\; display-message -p '#{socket_path}'";
    const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    for (const cmd of [
      `tmux ${probe}`,
      `${realTmux} ${probe}`,
      `env -u MU_TMUX_SOCKET tmux ${probe}`,
      `tmux -L ${sb.tmuxSocket} ${probe}`,
    ]) {
      const r = await sh(sb, cmd, { allowFail: true });
      expect(r.stdout.trim().startsWith(`${sb.dir}/`), `${cmd} -> ${r.stdout}${r.stderr}`).toBe(
        true,
      );
    }
    // bare tmux lists only the run's own server, never the user's sessions
    const listed = await sh(sb, "tmux list-sessions -F '#{session_name}'");
    expect(listed.stdout.trim()).toBe("eval-boot");
    // the shim, not the host tmux, is what bare `tmux` resolves to
    expect((await sh(sb, "command -v tmux")).stdout.trim()).toBe(`${sb.binDir}/tmux`);
    // absolute-path tmux with no -L lands on the sandbox's own default server: empty, not the user's
    const abs = await sh(sb, `${realTmux} list-sessions -F '#{session_name}'`, { allowFail: true });
    expect(abs.stdout.trim()).toBe("");
  });

  it("tmux display -p '#{socket_path}' inside the sandbox is under the sandbox dir", async () => {
    sb = await createSandbox(surface);
    const sock = tmuxSocketPath(sb.dir, sb.tmuxSocket);
    // bare tmux (shim -> run socket)
    const bare = (await sh(sb, "tmux display -p '#{socket_path}'")).stdout.trim();
    expect(bare).toBe(sock);
    // host tmux by absolute path, no -L: sandbox default socket, still under the sandbox dir
    const abs = (
      await sh(sb, `${realTmux()} start-server \\; display -p '#{socket_path}'`)
    ).stdout.trim();
    expect(abs.startsWith(`${sb.dir}/`), abs).toBe(true);
    // never the user's default socket
    expect(abs).not.toContain("/tmp/tmux-");
    expect(bare).not.toBe(abs);
  });

  it("resolveRealTmux throws promptly when tmux is not on PATH, never returns a bare name", () => {
    expect(() => resolveRealTmux("/nonexistent:relative/dir")).toThrow(/tmux not found/);
    expect(isAbsolute(resolveRealTmux())).toBe(true);
  });

  it("close kills the private servers (named and default-in-sandbox) and removes the dir", async () => {
    sb = await createSandbox(surface);
    await sh(sb, `${realTmux()} start-server \\; new-session -d -s bare`);
    const paths = [tmuxSocketPath(sb.dir, sb.tmuxSocket), tmuxSocketPath(sb.dir, "default")];
    for (const p of paths) expect(existsSync(p)).toBe(true);
    const dir = sb.dir;
    await sb.close();
    sb = undefined;
    expect(existsSync(dir)).toBe(false);
    for (const p of paths) {
      expect(() => execFileSync("tmux", ["-S", p, "ls"], { stdio: "ignore" })).toThrow();
    }
  });

  it.each([
    ["an unhandled rejection", "Promise.reject(new Error('boom'))"],
    ["an uncaught exception", "setTimeout(() => { throw new Error('boom'); }, 0)"],
    ["a plain exit with the sandbox still open", "process.exit(0)"],
  ])(
    "%s still removes the sandbox dir and kills its tmux server",
    async (_n, crash) => {
      const dir = mkdtempSync(join(tmpdir(), "mu-eval-crash-"));
      try {
        const script = join(dir, "crash.ts");
        const mod = join(import.meta.dirname, "..", "..", "tools", "eval", "sandbox.ts");
        writeFileSync(
          script,
          `import { execFileSync } from "node:child_process";
import { realTmux, createSandbox, tmuxSocketPath } from ${JSON.stringify(mod)};
const sb = await createSandbox(${JSON.stringify(surface)});
const sock = tmuxSocketPath(sb.dir, sb.tmuxSocket);
const pid = Number(execFileSync(realTmux(), ["-S", sock, "display", "-p", "#{pid}"], { encoding: "utf8" }));
console.log(JSON.stringify({ dir: sb.dir, sock, pid }));
${crash};
await new Promise((r) => setTimeout(r, 5000));
`,
        );
        const r = spawnSync("node", [script], { encoding: "utf8", timeout: 60_000 });
        const info = JSON.parse(r.stdout.trim().split("\n")[0] ?? "{}") as {
          dir: string;
          sock: string;
          pid: number;
        };
        expect(info.dir).toBeTruthy();
        expect(info.pid).toBeGreaterThan(1);
        try {
          expect(existsSync(info.dir)).toBe(false);
          // The exact server process must die (the socket vanishing proves nothing: rmSync unlinks it).
          let alive = true;
          for (let i = 0; i < 20 && alive; i++) {
            try {
              process.kill(info.pid, 0);
              await new Promise((r) => setTimeout(r, 50));
            } catch {
              alive = false;
            }
          }
          expect(alive, `tmux server ${info.pid} survived`).toBe(false);
        } finally {
          try {
            process.kill(info.pid, "SIGKILL");
          } catch {
            // already dead
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
