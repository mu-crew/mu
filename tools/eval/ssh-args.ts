// Pure helpers of the ssh shim (fixtures.sshShim): argv parsing like OpenSSH, the socket-path
// rewrite, and the remote environment. No I/O, so vitest covers them.

export interface SshInvocation {
  host: string | null;
  /** -t seen (and not -T later). */
  tty: boolean;
  /** Unix-socket forwards from -L <local>:<remote>, as written (before the rewrite). */
  forwards: { local: string; remote: string }[];
  /** Remaining words joined by single spaces, as real ssh does; null when there is none. */
  command: string | null;
}

const VALUE_OPTS = new Set("oLpilFJESWRDbcmOQBewI".split(""));

/** Parse `ssh` argv. Options are accepted before and after the host; `--` ends them. */
export function parseSshArgs(argv: string[]): SshInvocation {
  let host: string | null = null;
  let tty = false;
  const forwards: SshInvocation["forwards"] = [];
  const words: string[] = [];
  let optsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    if (host !== null && words.length > 0) {
      words.push(w);
      continue;
    }
    if (!optsDone && w === "--") {
      optsDone = true;
      continue;
    }
    if (!optsDone && w.length > 1 && w.startsWith("-")) {
      for (let j = 1; j < w.length; j++) {
        const c = w.charAt(j);
        if (VALUE_OPTS.has(c)) {
          const value = j + 1 < w.length ? w.slice(j + 1) : (argv[++i] ?? "");
          if (c === "L") {
            const m = /^(\/[^:]*):(\/[^:]*)$/.exec(value);
            if (m?.[1] !== undefined && m[2] !== undefined)
              forwards.push({ local: m[1], remote: m[2] });
          }
          break;
        }
        if (c === "t") tty = true;
        else if (c === "T") tty = false;
      }
      continue;
    }
    if (host === null) host = w;
    else words.push(w);
  }
  return { host, tty, forwards, command: words.length > 0 ? words.join(" ") : null };
}

const MU_SOCK = /^\/tmp\/mu-\d/;

/** Prefix a mu socket path (/tmp/mu-<uid>/...) with the host root. Anything else is unchanged. */
export function rewriteSock(path: string, hostRoot: string): string {
  return MU_SOCK.test(path) ? `${hostRoot}${path}` : path;
}

/** Rewrite only the value of each MU_CTL_SOCK=<path> token (mu splices it unquoted). */
export function rewriteCommand(cmd: string, hostRoot: string): string {
  return cmd.replace(
    /(?<![A-Za-z0-9_])(MU_CTL_SOCK=["']?)(\/tmp\/mu-\d[^\s'"]*)/g,
    (_m, head: string, path: string) => `${head}${rewriteSock(path, hostRoot)}`,
  );
}

/** What `$SHELL -ilc "<cmd>"` becomes in the host's eval-shell: drop option words, keep the command. */
export function shellArgs(args: string[]): string[] {
  const last = args[args.length - 1];
  return last === undefined ? [] : ["-c", last];
}

/** Variables the "remote" host must not inherit from the orchestrator's sandbox. */
const DROPPED = new Set([
  "MU_DB_PATH",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
  "MU_TMUX_SOCKET",
  "MU_MUX",
  "TMUX",
  "TMUX_PANE",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "EVAL_SANDBOX_DIR",
]);

/**
 * The remote command's environment. Real ssh forwards no environment, and mu puts the identity
 * variables inline in the command, so every MU_* variable of the shim's env is dropped. EVAL_DB_PATH
 * (read-only task lookup for eval-worker), EVAL_WORKER_DIR and PI_CODING_AGENT_DIR stay.
 */
export function remoteEnv(
  shimEnv: Record<string, string | undefined>,
  hostRoot: string,
  host: string,
  hostTmuxSocket: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(shimEnv)) {
    if (v === undefined || DROPPED.has(k) || k.startsWith("MU_")) continue;
    env[k] = v;
  }
  const db = shimEnv.EVAL_DB_PATH ?? shimEnv.MU_DB_PATH;
  if (db !== undefined) env.EVAL_DB_PATH = db;
  env.HOME = `${hostRoot}/home`;
  env.SHELL = `${hostRoot}/bin/eval-shell`;
  env.EVAL_HOST = host;
  env.EVAL_HOST_TMUX_SOCKET = hostTmuxSocket;
  env.PATH = `${hostRoot}/bin:${shimEnv.PATH ?? ""}`;
  return env;
}
