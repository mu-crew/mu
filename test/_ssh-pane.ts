// Helpers for the ssh plugin's `pane` job kind (examples/plugins/mu-plugin-ssh): a stand-in
// `ssh` that runs the remote command locally, and a direct client of the plugin's wire.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { withHello } from "./_ctl-ext.js";
import { SSH_EXAMPLE } from "./_plugin.js";

export interface FakeSsh {
  /** `mu plugin add ssh --` argv: the example plugin and this stand-in as its ssh command. */
  argv: string[];
  /** The remote side's state directory (`$HOME/.local/state`: the plugin's namespace lives under it). */
  xdg: string;
  /** Every ssh invocation's arguments, in order. */
  invocations(): string[][];
  /** From now on ssh fails like an unreachable host (exit 255) until `up()`. */
  down(): void;
  up(): void;
  /** From now on the remote sessions run with this XDG_STATE_HOME. */
  xdgAt(path: string): void;
}

/**
 * A stand-in `ssh`: skips the options (all but `-t` take an argument), takes the destination and
 * runs the remote command with /bin/sh in `home`, as a child (killing the stand-in leaves it running). No pty and no hangup: a view that dies leaves
 * the remote process running, the case job.stop's proof exists for.
 */
export function fakeSsh(
  dir: string,
  home: string,
  opts: { foreground?: boolean; sh?: string; shell?: string } = {},
): FakeSsh {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const xdg = join(home, ".local", "state");
  const xdgFile = join(dir, "session-xdg");
  const log = join(dir, "ssh.log");
  const downFile = join(dir, "down");
  const fake = join(bin, "fake-ssh");
  writeFileSync(
    fake,
    `#!/bin/sh
{ for a in "$@"; do printf '%s\\n' "$a"; done; echo '--'; } >> '${log}'
while :; do case "$1" in -o|-p|-J|-L|-i|-F) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
[ "$1" = -t ] && shift
[ -f '${downFile}' ] && { echo 'ssh: connect to host box port 22: Connection refused' >&2; exit 255; }
export HOME='${home}' SHELL='${opts.shell ?? "/bin/sh"}'
# What a remote startup file may do: another XDG_STATE_HOME per session (see \`xdgAt\`).
[ -f '${xdgFile}' ] && export XDG_STATE_HOME="$(cat '${xdgFile}')"
cmd="$*"
${opts.sh ? `cmd="exec ${opts.sh} \${cmd#exec /bin/sh }"` : ""}
cd '${home}' || exit 1
${opts.foreground ? `exec /bin/sh -c "$cmd"` : `{ /bin/sh -c "$cmd" & wait $!; }`}
`,
  );
  chmodSync(fake, 0o755);
  return {
    argv: [SSH_EXAMPLE, fake],
    xdg,
    invocations() {
      let text = "";
      try {
        text = readFileSync(log, "utf8");
      } catch {}
      return text
        .split("--\n")
        .filter((s) => s !== "")
        .map((s) => s.split("\n").slice(0, -1));
    },
    down: () => writeFileSync(downFile, ""),
    up: () => rmSync(downFile, { force: true }),
    xdgAt: (path) => writeFileSync(xdgFile, path),
  };
}

/** A direct client of the plugin's wire: one request at a time, the reply or error returned. */
export class PluginWire {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private buffered = "";
  private waiting = new Map<number, (m: Record<string, unknown>) => void>();
  private n = 0;

  constructor(argv: string[]) {
    const [exe, ...rest] = argv;
    this.child = spawn(exe ?? "", rest, { stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffered += chunk;
      for (let nl = this.buffered.indexOf("\n"); nl !== -1; nl = this.buffered.indexOf("\n")) {
        const m = JSON.parse(this.buffered.slice(0, nl)) as { id: number };
        this.buffered = this.buffered.slice(nl + 1);
        this.waiting.get(m.id)?.(m as unknown as Record<string, unknown>);
      }
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.n;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** `job.*` params for host `box`, with the deadline a few seconds out. */
  static params(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      target: { host: { name: "box" } },
      deadline: Date.now() + 30_000,
      ...extra,
    };
  }

  close(): void {
    this.child.kill();
  }
}

/** A fake pi extension at `path` (the view's "forward"): idle, a send settles a run at once. */
export async function serveCtl(path: string, servers: Server[]): Promise<void> {
  let runs = 0;
  const accepted = new Set<string>();
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as Record<string, unknown>;
        if (req.op === "send") {
          runs += 1;
          accepted.add(String(req.msgId));
        }
        const idle = { v: 1, ok: true, state: "idle", since: 1, runs, pending: false };
        const reply =
          req.op === "status" && typeof req.msgId === "string"
            ? { ...idle, msg: { id: req.msgId, accepted: accepted.has(req.msgId), runs, at: 1 } }
            : idle;
        sock.end(encode(withHello(req, reply)));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}
