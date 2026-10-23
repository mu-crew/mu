// Real tmux: no tmux invocation from inside a sandbox may reach the default server.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSandbox, sh, tmuxSocketPath } from "../../tools/eval/sandbox.ts";
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
    // bare tmux sees only the sandbox's own (empty) default server, never the user's sessions
    const listed = await sh(sb, "tmux list-sessions -F '#{session_name}'", { allowFail: true });
    expect(listed.stdout.trim()).toBe("");
  });

  it("close kills the private servers (named and default-in-sandbox) and removes the dir", async () => {
    sb = await createSandbox(surface);
    await sh(sb, "tmux start-server \\; new-session -d -s bare");
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
});
