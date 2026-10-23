import { describe, expect, it } from "vitest";
import {
  parseSshArgs,
  remoteEnv,
  rewriteCommand,
  rewriteSock,
  shellArgs,
} from "../../tools/eval/ssh-args.ts";

const HOST = "/tmp/mu-eval-1-2-3/hosts/dev";

describe("parseSshArgs", () => {
  it("parses the exact command mu agent remote-env prints (options after the host)", () => {
    const inv = parseSshArgs([
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "StreamLocalBindUnlink=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "/a/l.sock:/tmp/mu-1000/eval/w1.sock",
      "dev",
      "-t",
      "cd x && pi",
    ]);
    expect(inv.host).toBe("dev");
    expect(inv.tty).toBe(true);
    expect(inv.forwards).toEqual([{ local: "/a/l.sock", remote: "/tmp/mu-1000/eval/w1.sock" }]);
    expect(inv.command).toBe("cd x && pi");
  });
  it("parses git's form", () => {
    const inv = parseSshArgs(["-o", "SendEnv=GIT_PROTOCOL", "dev", "git-upload-pack '~/ws/w1'"]);
    expect(inv).toEqual({
      host: "dev",
      tty: false,
      forwards: [],
      command: "git-upload-pack '~/ws/w1'",
    });
  });
  it("parses a bare remote tmux command", () => {
    const inv = parseSshArgs(["dev", "tmux new-session -d -s x 'pi'"]);
    expect(inv.host).toBe("dev");
    expect(inv.command).toBe("tmux new-session -d -s x 'pi'");
  });
  it("joins several command words with single spaces and keeps option-looking words", () => {
    expect(parseSshArgs(["dev", "ls", "-la", "/tmp"]).command).toBe("ls -la /tmp");
  });
  it("handles -- , clustered flags and attached values", () => {
    const inv = parseSshArgs(["-tn", "-p2222", "--", "dev", "true"]);
    expect(inv.host).toBe("dev");
    expect(inv.tty).toBe(true);
    expect(inv.command).toBe("true");
  });
  it("-T after -t turns the tty off; no command is null", () => {
    const inv = parseSshArgs(["-t", "-T", "dev"]);
    expect(inv.tty).toBe(false);
    expect(inv.command).toBeNull();
  });
});

describe("socket rewrite", () => {
  it("leaves EVAL_DB_PATH and cwd under /tmp/mu-eval-* alone", () => {
    const cmd =
      "cd /tmp/mu-eval-1-2-3/hosts/dev/home && EVAL_DB_PATH=/tmp/mu-eval-1-2-3/state/mu.db pi";
    expect(rewriteCommand(cmd, HOST)).toBe(cmd);
  });
  it("rewrites the MU_CTL_SOCK value only", () => {
    expect(rewriteCommand("MU_AGENT_NAME=w1 MU_CTL_SOCK=/tmp/mu-1000/eval/w1.sock pi", HOST)).toBe(
      `MU_AGENT_NAME=w1 MU_CTL_SOCK=${HOST}/tmp/mu-1000/eval/w1.sock pi`,
    );
  });
  it("does not touch a MU_CTL_SOCK value that is not a mu socket path", () => {
    expect(rewriteCommand("MU_CTL_SOCK=/var/x.sock pi", HOST)).toBe("MU_CTL_SOCK=/var/x.sock pi");
  });
  it("rewrites the remote half of -L only", () => {
    const inv = parseSshArgs(["-L", "/x/l.sock:/tmp/mu-1000/eval/w1.sock", "dev"]);
    const f = inv.forwards[0];
    expect(f?.local).toBe("/x/l.sock");
    expect(rewriteSock(f?.remote ?? "", HOST)).toBe(`${HOST}/tmp/mu-1000/eval/w1.sock`);
    expect(rewriteSock("/tmp/mu-eval-1-2-3/x.sock", HOST)).toBe("/tmp/mu-eval-1-2-3/x.sock");
  });
});

describe("shellArgs", () => {
  it("drops option words and keeps the command", () => {
    expect(shellArgs(["-ilc", "pi --approve"])).toEqual(["-c", "pi --approve"]);
    expect(shellArgs(["-i", "-l", "-c", "echo hi"])).toEqual(["-c", "echo hi"]);
    expect(shellArgs([])).toEqual([]);
  });
});

describe("remoteEnv", () => {
  const shimEnv = {
    PATH: "/sb/bin:/usr/bin",
    HOME: "/sb/home",
    MU_DB_PATH: "/sb/state/mu.db",
    MU_STATE_DIR: "/sb/state",
    MU_SYNC_DIR: "/sb/sync",
    MU_TMUX_SOCKET: "sock",
    MU_MUX: "tmux",
    MU_NUDGE: "0",
    TMUX: "/tmp/tmux-1/x,1,0",
    TMUX_PANE: "%1",
    XDG_STATE_HOME: "/sb/home/.local/state",
    XDG_CACHE_HOME: "/sb/home/.cache",
    EVAL_WORKER_DIR: "/sb/workers",
    PI_CODING_AGENT_DIR: "/sb/pi-agent",
    TERM: "xterm",
  };
  const env = remoteEnv(shimEnv, HOST, "dev", "sock-h-dev");
  it("drops orchestrator state and every MU_* variable", () => {
    for (const k of Object.keys(env)) expect(k.startsWith("MU_")).toBe(false);
    for (const k of ["TMUX", "TMUX_PANE", "XDG_STATE_HOME", "XDG_CACHE_HOME"])
      expect(env[k]).toBeUndefined();
  });
  it("keeps EVAL_*, PI_CODING_AGENT_DIR and TERM, and derives EVAL_DB_PATH", () => {
    expect(env.EVAL_WORKER_DIR).toBe("/sb/workers");
    expect(env.PI_CODING_AGENT_DIR).toBe("/sb/pi-agent");
    expect(env.TERM).toBe("xterm");
    expect(env.EVAL_DB_PATH).toBe("/sb/state/mu.db");
  });
  it("sets HOME, SHELL and a PATH with the host bin first", () => {
    expect(env.HOME).toBe(`${HOST}/home`);
    expect(env.SHELL).toBe(`${HOST}/bin/eval-shell`);
    expect(env.PATH).toBe(`${HOST}/bin:/sb/bin:/usr/bin`);
  });
});
