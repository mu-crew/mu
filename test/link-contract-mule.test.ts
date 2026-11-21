// The link contract against mule's plugin (mule: src/bin/mu-plugin-mule.rs), through the same
// link adapter as test/link-contract.test.ts. Its own file: mule is an external binary, so the
// suite runs only when MULE_PLUGIN_BIN names a built `mu-plugin-mule` (with `mule` beside it) and
// tmux exists, and skips otherwise. The "remote" is this machine: a stand-in `ssh` on PATH
// answers `-O check` as a live master (or none, while `<dir>/master-down` exists) and runs the
// script under sh, as mule's own shim tests do.
//
//   MULE_PLUGIN_BIN=/abs/mule/target/debug/mu-plugin-mule npx vitest run test/link-contract-mule.test.ts

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { type HostView, resolveHost } from "../src/host-provider.js";
import { addHost, HostHandbackError } from "../src/hosts.js";
import { narrowSeams } from "../src/plugins/protocol.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";

const BIN = process.env.MULE_PLUGIN_BIN ?? "";
const have = BIN !== "" && existsSync(BIN) && spawnSync("tmux", ["-V"]).status === 0;

describe.skipIf(!have)("the link contract: mule", () => {
  let dir: string;
  let home: string;
  let db: Db;
  let h: HostView;
  const saved = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mlm-"));
    home = join(dir, "home");
    mkdirSync(join(home, "sub"), { recursive: true });
    mkdirSync(join(dir, "state"));
    const down = join(dir, "master-down");
    const shim = join(dir, "ssh");
    writeFileSync(
      shim,
      `#!/bin/sh
for arg; do if [ "$arg" = -O ]; then
  [ -e '${down}' ] && { echo 'Control socket connect: No such file or directory' >&2; exit 255; }
  echo 'Master running (pid=1)' >&2; exit 0; fi; done
[ -e '${down}' ] && exit 255
for last; do :; done
cd '${home}' && exec sh -c "$last"
`,
    );
    chmodSync(shim, 0o755);
    const config = join(dir, "config.toml");
    writeFileSync(
      config,
      `[hosts.shim]\ntarget = "shim"\nsocket = "${join(dir, "mule.sock")}"\ntmux_socket = "mlm-${process.pid}"\n`,
    );
    process.env.PATH = `${dir}:${saved.PATH}`;
    process.env.XDG_STATE_HOME = join(dir, "state");
    db = openDb({ path: join(dir, "mu.db") });
    await addPlugin(db, "mule", [BIN, "--config", config]);
    addHost(db, { name: "shim", plugin: "mule", fetch: "true", repo: null, max_sessions: null });
    h = resolveHost(db, "shim");
  });

  afterEach(async () => {
    await closePluginSessions();
    db.close();
    process.env.PATH = saved.PATH;
    if (saved.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved.XDG_STATE_HOME;
    spawnSync("tmux", ["-L", `mlm-${process.pid}`, "kill-server"]);
    rmFixtureDir(dir);
  });

  const exec = (script: string, opts: { cwd?: string; timeoutMs?: number } = {}) =>
    h.link.exec(
      h,
      { script, cwd: opts.cwd ?? ".", timeoutMs: opts.timeoutMs ?? 10_000 },
      { holder: "contract" },
    );

  it("declares exec only, self slots, provable quiescence", () => {
    const c = h.link.caps;
    expect(narrowSeams({ link: { ...c, maxScriptBytes: c.maxScriptBytes ?? 1 } }).ok).toBe(true);
    expect(h.link.name).toBe("mule");
    expect(c).toMatchObject({ slots: "self", quiescence: "provable" });
    // fetch: false, so a host on this plugin needs its own --fetch template.
    expect(() =>
      addHost(db, { name: "nofetch", plugin: "mule", repo: null, max_sessions: null }),
    ).toThrow(/fetch/);
    expect(c.push).toBeUndefined();
    // The instance names the backend (host targets, sockets, config), opaque: not the plugin.
    expect(h.link.fingerprint(h)).toMatch(/^plugin:mule:mule-[0-9a-f]{16}$/);
  });

  it("runs a script in the remote cwd: exit code, stdout and stderr", async () => {
    const r = await exec("pwd; echo out; echo err >&2; exit 7", { cwd: "sub" });
    expect(r.exitCode).toBe(7);
    expect(r.partial).toBe(false);
    expect(r.stdout.split("\n")[0]).toMatch(/\/home\/sub$/);
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
  });

  it("`.` is the login directory", async () => {
    expect((await exec("pwd")).stdout.trim()).toMatch(/\/home$/);
  });

  it("a command's own exit 3 is a command result (strict-codes: 8), never a hand-back", async () => {
    const r = await exec("echo hi; echo oops >&2; exit 3");
    expect(r).toMatchObject({ exitCode: 8, stdout: "hi\n" });
    expect(r.stderr).toContain("oops");
  });

  it("other codes pass through", async () => {
    expect((await exec("exit 8")).exitCode).toBe(8);
    expect((await exec("exit 1")).exitCode).toBe(1);
  });

  it("a timeout answers with no exit code, within the timeout and the grace", async () => {
    const t0 = Date.now();
    const r = await exec("exec sleep 30", { timeoutMs: 500 });
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500 + 5000);
    expect(h.link.caps.remoteOnTimeout).toBe("unknown");
  });

  it("no master is a hand-back, and the script never runs", async () => {
    writeFileSync(join(dir, "master-down"), "");
    await expect(exec("touch ran")).rejects.toBeInstanceOf(HostHandbackError);
    expect(existsSync(join(home, "ran"))).toBe(false);
  });

  it("the reach phase passes with a master and hands back without one", async () => {
    const ctx = { db, host: h, phase: "reach" as const, timeoutMs: 10_000 };
    const up = (await h.link.checkSteps?.(ctx, { holder: "contract" })) ?? [];
    expect(up.length).toBeGreaterThan(0);
    expect(up.every((s) => s.ok === true)).toBe(true);
    expect(up.some((s) => s.step.includes("tmux"))).toBe(true); // proven on the remote, no job dispatched
    writeFileSync(join(dir, "master-down"), "");
    const down = (await h.link.checkSteps?.(ctx, { holder: "contract" })) ?? [];
    expect(down.some((s) => s.step.includes("handback") && s.ok === false)).toBe(true);
    for (const phase of ["template", "agent"] as const) {
      expect(await h.link.checkSteps?.({ ...ctx, phase }, { holder: "contract" })).toEqual([]);
    }
  });
});
