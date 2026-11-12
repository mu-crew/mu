#!/usr/bin/env node
// The "ssh" of the remote scenario (copied from test/remote-spawn.integration.test.ts):
// args are <local sock> <remote sock> <cwd> -- KEY='v'... <cmd>. Runs <cmd> with ONLY those
// vars and proxies the local ctl socket to the "remote" one. Not ssh; no network.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const [local, remote, cwd, , ...rest] = process.argv.slice(2);
const cmd = rest.pop();
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
for (const w of rest) {
  const i = w.indexOf("=");
  env[w.slice(0, i)] = w.slice(i + 1);
}
mkdirSync(path.dirname(local), { recursive: true });
rmSync(local, { force: true });
net
  .createServer((c) => {
    const up = net.connect(remote);
    up.on("error", () => c.destroy());
    c.on("error", () => up.destroy());
    c.pipe(up);
    up.pipe(c);
  })
  .listen(local);
const child = spawn("/bin/sh", ["-c", cmd], { cwd, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGHUP", "SIGTERM"]) process.on(sig, () => child.kill(sig));
