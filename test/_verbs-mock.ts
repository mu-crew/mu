// Shared mock-tmux harness for verbs-* test files. Split out of
// test/verbs.test.ts under testreview_test_files_past_800loc to keep
// each split file focused on its verb without reproducing 180 LOC of
// scaffolding. The freshMockState() factory + mockTmux() executor pair
// model just enough of tmux's send/list/capture surface to drive the
// agent verbs through their happy + edge paths without a real tmux
// server (see test/tmux.integration.test.ts for the real-tmux suite).

import type { TmuxExecResult, TmuxExecutor } from "../src/tmux.js";

// ─── Mock tmux harness ─────────────────────────────────────────────────

export interface FakePane {
  windowId: string;
  paneId: string;
  command: string;
  scrollback?: string;
  /** A pane that kept its row after its command ended (remain-on-exit): set by a test to model the exit. */
  exit?: { code: number | null; signal: number | null };
  /** `#{pane_pid}`: the pane's first process. */
  pid?: number;
}

export interface MockState {
  /** Sessions that exist. */
  sessions: Set<string>;
  /** windows[session] -> [{id, name}] */
  windows: Map<string, { id: string; name: string }[]>;
  /** All panes by paneId. */
  panes: Map<string, FakePane>;
  /** Auto-incrementing ids. */
  nextWindowId: number;
  nextPaneId: number;
}

export function freshMockState(): MockState {
  return {
    sessions: new Set(),
    windows: new Map(),
    panes: new Map(),
    nextWindowId: 1,
    nextPaneId: 1,
  };
}

/** Session name from a `-t` session target. mu targets sessions exactly
 *  as `=<name>:` (see exactSessionTarget in src/mux/tmux.ts); like real
 *  tmux, the mock resolves only that form, so a regression to a bare,
 *  prefix-matching `-t <name>` fails the lookup. */
function sessionFromTarget(target: string | undefined): string {
  const m = /^=(.*):$/.exec(target ?? "");
  return m?.[1] ?? "";
}

export function mockTmux(state: MockState): { calls: string[][]; executor: TmuxExecutor } {
  const calls: string[][] = [];

  const executor: TmuxExecutor = async (args) => {
    calls.push([...args]);
    const verb = args[0];

    if (verb === "has-session") {
      const target = sessionFromTarget(args[2]);
      return state.sessions.has(target) ? ok() : fail(`can't find session: ${target}`);
    }

    if (verb === "new-session") {
      const sessionFlag = args.indexOf("-s");
      const sessionName = sessionFlag >= 0 ? args[sessionFlag + 1] : undefined;
      const nameFlag = args.indexOf("-n");
      const windowName = nameFlag >= 0 ? args[nameFlag + 1] : "main";
      if (!sessionName) return fail("session name required");
      if (state.sessions.has(sessionName)) return fail("duplicate session");
      state.sessions.add(sessionName);
      const windowId = `@${state.nextWindowId++}`;
      const paneId = `%${state.nextPaneId++}`;
      state.windows.set(sessionName, [{ id: windowId, name: windowName ?? "main" }]);
      state.panes.set(paneId, {
        windowId,
        paneId,
        command: args[args.length - 1] ?? "bash",
      });
      // -P -F captures pane id
      if (args.includes("-P")) return ok(`${paneId}\n`);
      return ok();
    }

    if (verb === "list-windows") {
      const targetFlag = args.indexOf("-t");
      const target = sessionFromTarget(targetFlag >= 0 ? args[targetFlag + 1] : undefined);
      const wins = state.windows.get(target) ?? [];
      return ok(wins.map((w) => `${w.id}|${w.name}`).join("\n") + (wins.length ? "\n" : ""));
    }

    if (verb === "new-window") {
      const tFlag = args.indexOf("-t");
      const sessionName = sessionFromTarget(tFlag >= 0 ? args[tFlag + 1] : undefined);
      const nFlag = args.indexOf("-n");
      const windowName = nFlag >= 0 ? args[nFlag + 1] : "window";
      if (!sessionName || !state.sessions.has(sessionName)) {
        return fail(`can't find session: ${sessionName}`);
      }
      const windowId = `@${state.nextWindowId++}`;
      const paneId = `%${state.nextPaneId++}`;
      state.windows.get(sessionName)?.push({ id: windowId, name: windowName ?? "window" });
      state.panes.set(paneId, {
        windowId,
        paneId,
        command: args[args.length - 1] ?? "bash",
      });
      return ok(`${paneId}\n`);
    }

    if (verb === "split-window") {
      // Resolve -t <session>:<window> like tmux: `=<session>` is exact; a
      // bare session that doesn't exist falls back to a unique prefix
      // match (the cross-workstream hazard). `@N` windows match by id
      // within that session, anything else by name.
      const tFlag = args.indexOf("-t");
      const target = tFlag >= 0 ? args[tFlag + 1] : "";
      if (!target?.includes(":")) return fail(`bad split target: ${target}`);
      const [sessionPart = "", windowPart = ""] = target.split(":");
      let session: string | undefined;
      if (sessionPart.startsWith("=")) {
        const exact = sessionPart.slice(1);
        session = state.sessions.has(exact) ? exact : undefined;
      } else if (state.sessions.has(sessionPart)) {
        session = sessionPart;
      } else {
        const prefixed = [...state.sessions].filter((s) => s.startsWith(sessionPart));
        session = prefixed.length === 1 ? prefixed[0] : undefined;
      }
      if (session === undefined) return fail(`can't find session: ${sessionPart}`);
      const win = state.windows
        .get(session)
        ?.find((w) => (windowPart.startsWith("@") ? w.id : w.name) === windowPart);
      if (!win) return fail(`can't find window: ${target}`);
      const paneId = `%${state.nextPaneId++}`;
      state.panes.set(paneId, {
        windowId: win.id,
        paneId,
        command: args[args.length - 1] ?? "bash",
      });
      return ok(`${paneId}\n`);
    }

    if (verb === "kill-pane") {
      const tFlag = args.indexOf("-t");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : undefined;
      if (!paneId) return fail("bad kill-pane");
      if (!state.panes.has(paneId)) return fail(`can't find pane: ${paneId}`);
      state.panes.delete(paneId);
      return ok();
    }

    if (verb === "list-panes" && args[1] === "-a") {
      return ok([...state.panes.values()].map((pane) => `${pane.paneId}|working|1000`).join("\n"));
    }

    if (verb === "list-panes" && args[1] === "-s") {
      const tFlag = args.indexOf("-t");
      const session = sessionFromTarget(tFlag >= 0 ? args[tFlag + 1] : undefined);
      const sessionWindowIds = new Set(state.windows.get(session)?.map((w) => w.id) ?? []);
      const lines: string[] = [];
      for (const pane of state.panes.values()) {
        if (sessionWindowIds.has(pane.windowId)) {
          lines.push(`${pane.windowId}|${pane.paneId}|${pane.command}`);
        }
      }
      return ok(lines.join("\n"));
    }

    if (verb === "capture-pane") {
      const tFlag = args.indexOf("-t");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : "";
      const pane = state.panes.get(paneId ?? "");
      if (!pane) return fail(`can't find pane: ${paneId}`);
      return ok(pane.scrollback ?? "");
    }

    if (verb === "display-message") {
      // Used by paneAlive() during the spawn liveness check.
      // `display-message -t <pane> -p '#{pane_id}'` echoes back the pane id
      // iff the pane exists; otherwise tmux exits non-zero.
      const tFlag = args.indexOf("-t");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : "";
      const pane = state.panes.get(paneId ?? "");
      if (!pane) return fail(`can't find pane: ${paneId}`);
      const fmt = args[args.indexOf("-p") + 1] ?? "";
      // The exit facts of a retained pane (`pane_dead`, `pane_dead_status`, `pane_dead_signal`).
      if (fmt.includes("pane_pid")) return ok(`${paneId}|${pane.pid ?? ""}\n`);
      if (fmt.includes("pane_dead")) {
        const e = pane.exit;
        return ok(`${paneId}|${e ? 1 : 0}|${e?.code ?? ""}|${e?.signal ?? ""}\n`);
      }
      return ok(`${paneId}\n`);
    }

    if (verb === "respawn-pane") {
      const tFlag = args.indexOf("-t");
      const pane = state.panes.get((tFlag >= 0 ? args[tFlag + 1] : "") ?? "");
      if (!pane) return fail("can't find pane");
      pane.command = args[args.length - 1] ?? pane.command;
      delete pane.exit;
      return ok();
    }

    if (verb === "set-option") return ok();
    if (verb === "copy-mode") return ok();
    if (verb === "set-buffer") return ok();
    if (verb === "paste-buffer") return ok();
    if (verb === "send-keys") return ok();

    return fail(`unmocked tmux call: ${args.join(" ")}`);
  };

  return { calls, executor: withServerIdentity(executor) };
}

export const ok = (stdout = ""): TmuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
export const fail = (stderr: string, exitCode = 1): TmuxExecResult => ({
  stdout: "",
  stderr,
  exitCode,
});

// Mutate $MU_PI_COMMAND for the duration of `fn` and restore it after.
// `delete process.env[<runtime key>]` is the project-wide pattern (see
// test/tmux.test.ts) — Biome flags the literal-key forms but accepts the
// computed form via a const variable, and assigning `undefined` would
// silently coerce to the string "undefined".
export async function withMuPiCommand(value: string | undefined, fn: () => unknown): Promise<void> {
  const key = "MU_PI_COMMAND";
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

export async function withMuSpawnLivenessMs(
  value: string | undefined,
  fn: () => unknown,
): Promise<void> {
  const key = "MU_SPAWN_LIVENESS_MS";
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

// ─── Server identity, as tmux reports it ───────────────────────────────

/** The fake server's `#{pid}|#{start_time}`. */
export const FAKE_SERVER_IDENTITY = "4242|1700000000";

/** Split a tmux command string the way tmux reads it (single and double quotes, adjacent pieces join). */
function tmuxWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && ch === "\\" && line.charAt(i + 1) === "n") {
        word += "\n";
        i++;
      } else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/**
 * Make a mocked tmux executor speak what the real server does about its identity: pane creation
 * answers `#{pane_id}|#{pid}|#{start_time}`, `list-sessions` names the server, and a guarded
 * command (`if-shell -F '#{==:#{pid}|#{start_time},ID}' <command> <else>`) runs its command only
 * when ID is this fake server. The inner executor sees the plain, unguarded command, so a test's
 * call log reads as it did before rows carried an identity.
 */
export function withServerIdentity(
  inner: TmuxExecutor,
  identity: string = FAKE_SERVER_IDENTITY,
): TmuxExecutor {
  return async (args) => {
    if (args[0] === "if-shell" && args[1] === "-F") {
      const format = args[2] === "-t" ? 4 : 2;
      const want = /#\{==:#\{pid\}\|#\{start_time\},(\d+\|\d+)\}/.exec(args[format] ?? "")?.[1];
      if (want !== identity) {
        return { stdout: "", stderr: "'exit 97' returned 97", exitCode: 97 };
      }
      return withServerIdentity(inner, identity)(tmuxWords(args[format + 1] ?? ""));
    }
    if (args[0] === "list-sessions" && args.some((a) => a.includes("#{pid}"))) {
      const result = await inner(args);
      if (
        (result.exitCode === 0 && result.stdout === "") ||
        /unmocked|unrouted/.test(result.stderr)
      ) {
        return ok(`${identity}\n`);
      }
      return result;
    }
    const result = await inner(args);
    const born = ["new-session", "new-window", "split-window"].includes(args[0] ?? "");
    const format = args[args.indexOf("-F") + 1] ?? "";
    if (
      born &&
      format.includes("#{pid}") &&
      result.exitCode === 0 &&
      /^%\d+$/.test(result.stdout.trim())
    ) {
      return { ...result, stdout: `${result.stdout.trim()}|${identity}\n` };
    }
    return result;
  };
}
