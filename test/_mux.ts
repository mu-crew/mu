// The mux test seam: pick a backend, get its executor stubbed, get one
// restore function back.
//
// ─── Why this exists ───────────────────────────────────────────────────
//
// Two backends means two executor seams (`setTmuxExecutor`,
// `setRexExecutor`) plus a backend selector (`setMuxForTests`). A test
// that wants Rex must call setMuxForTests + setRexExecutor TOGETHER and
// reset BOTH. Forgetting the reset leaks a stubbed executor into the next
// file in the fork; forgetting the selector runs the assertions against
// tmux while stubbing Rex, which passes for the wrong reason.
//
// `installMux()` collapses all of that into one call and one teardown.
// A test says which backend it is testing; the harness knows which
// executor that implies.
//
// ─── Which tier does my mux test belong to? ────────────────────────────
//
// See test/README.md § "Mux tests". Short version: if you call
// `installMux()` you are in the FAST tier and must stay pure. If you
// need a real multiplexer you are writing an `*.integration.test.ts`
// and must gate on `tmuxIntegrationAvailable()`.

import { paneRef, requireVerifiedPane, type VerifiedPaneRef } from "../src/mux/pane-ref.js";
import {
  type MuxBackend,
  type MuxBackendName,
  muxByName,
  setMuxForTests,
  setRexExecutor,
} from "../src/mux.js";
import { serverIdentity, setTmuxExecutor, tmux } from "../src/tmux.js";
import { FAKE_SERVER_IDENTITY, withServerIdentity } from "./_verbs-mock.js";

// ─── Shared executor shape ─────────────────────────────────────────────
//
// `TmuxExecResult` and `RexExecResult` are structurally identical, and
// so are the two executor types. One local alias lets the harness treat
// both backends uniformly instead of branching on types that are the
// same shape.

export interface MuxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type MuxExecutor = (args: readonly string[]) => Promise<MuxExecResult>;

/** A canned response: either a full exec result or just stdout (exit 0). */
export type MuxResponse = MuxExecResult | string;

/**
 * Prefix-matched routing table. The first entry whose key is a prefix of
 * the space-joined args vector wins, so `["list-panes -t x", …]` can be
 * narrower than `["list-panes", …]` when order says so. An empty-string
 * key matches everything (catch-all).
 */
export type MuxRoutes = ReadonlyArray<readonly [string, MuxResponse]>;

export interface MuxHarness {
  /** Every args vector the code under test passed to the backend, in order. */
  readonly calls: readonly (readonly string[])[];
  /** Args of call `n`, or undefined. Sugar over `calls[n]`. */
  argsOf(n: number): readonly string[] | undefined;
  /**
   * Restore the backend and executor that were active before this
   * install, so nested installs unwind LIFO. Call in afterEach.
   */
  restore(): void;
}

function respond(response: MuxResponse): MuxExecResult {
  return typeof response === "string"
    ? { stdout: response, stderr: "", exitCode: 0 }
    : { ...response };
}

/**
 * Install `backend` as the active mux AND stub its executor.
 *
 * ```ts
 * let mux: MuxHarness;
 * afterEach(() => mux.restore());
 *
 * it("lists panes", async () => {
 *   mux = installMux("tmux", [["list-panes", "@1|%1|pi\n@1|%2|pi\n"]]);
 *   expect(await listPanes("mu-topotest")).toHaveLength(2);
 *   expect(mux.argsOf(0)?.[0]).toBe("list-panes");
 * });
 * ```
 *
 * An unrouted call returns exit 1 with an `unrouted: <cmd>` stderr
 * rather than throwing, because that is what a real substrate failure
 * looks like to the code under test — and it names the missing route in
 * the assertion diff.
 *
 * Pass a function instead of a routing table when the test needs
 * arbitrary behaviour (throwing to prove no shell-out happens, counting,
 * stateful responses).
 */
export function installMux(
  backend: MuxBackendName,
  routes: MuxRoutes | MuxExecutor = [],
): MuxHarness {
  const calls: string[][] = [];
  const impl: MuxExecutor =
    typeof routes === "function"
      ? routes
      : async (args) => {
          const key = args.join(" ");
          for (const [prefix, response] of routes) {
            if (key.startsWith(prefix)) return respond(response);
          }
          return { stdout: "", stderr: `unrouted: ${key}`, exitCode: 1 };
        };

  const recording: MuxExecutor = async (args) => {
    calls.push([...args]);
    return await impl(args);
  };
  // A tmux row carries its server's identity: the fake answers for it, as tmux does.
  const executor: MuxExecutor = backend === "tmux" ? withServerIdentity(recording) : recording;

  const previousBackend = setMuxForTests(muxByName(backend));
  const setExecutor = { rex: setRexExecutor, tmux: setTmuxExecutor }[backend];
  const previousExecutor = setExecutor(executor);

  let restored = false;
  return {
    calls,
    argsOf: (n) => calls[n],
    restore() {
      // Idempotent: an afterEach that runs after an explicit in-test
      // restore() must not clobber the NEXT test's harness.
      if (restored) return;
      restored = true;
      // An outermost install saw `undefined`, so this re-arms detection.
      setMuxForTests(previousBackend);
      setExecutor(previousExecutor);
    },
  };
}

/**
 * Install a backend whose every method rejects, modelling a box with no
 * reachable multiplexer. `reject` supplies the error (typically
 * `NoMultiplexerError`), so call-site tests can prove load-bearing
 * paths propagate and best-effort paths degrade.
 */
export function installUnreachableMux(
  backend: MuxBackendName,
  reject: () => Error,
): { restore(): void } {
  const real = muxByName(backend);
  const boom = async (): Promise<never> => {
    throw reject();
  };
  const stub: Record<string, unknown> = { name: backend };
  for (const [key, value] of Object.entries(real)) {
    // Methods reject; capability flags (carrierViews) keep their value.
    stub[key] = typeof value === "function" ? boom : value;
  }
  const previousBackend = setMuxForTests(stub as unknown as MuxBackend);
  return {
    restore() {
      setMuxForTests(previousBackend);
    },
  };
}

/**
 * A box with NO multiplexer, through the real detection path: no backend
 * is installed, and both executors fail like a missing binary, so
 * `activeMux()` itself throws `NoMultiplexerError`. (`installUnreachableMux`
 * installs a backend, so detection never runs; it models a dead server.)
 * The caller must have `$TMUX`, `$TMUX_PANE`, `$MU_MUX` unset.
 */
export function installNoMux(): { restore(): void } {
  const gone: MuxExecutor = async () => ({ stdout: "", stderr: "not found", exitCode: 127 });
  const previousBackend = setMuxForTests(undefined);
  const previousTmux = setTmuxExecutor(gone);
  const previousRex = setRexExecutor(gone);
  return {
    restore() {
      setMuxForTests(previousBackend);
      setTmuxExecutor(previousTmux);
      setRexExecutor(previousRex);
    },
  };
}

// ─── Integration-tier gates ────────────────────────────────────────────

/**
 * tmux integration tests run whenever the suite has a real tmux server to
 * drive. Isolation is STRUCTURAL: `test/_global-teardown.ts` starts a private
 * `-L <socket>` server and publishes it as `MU_TMUX_SOCKET`, so the user's
 * sessions are invisible and suite residue dies with `kill-server`. Neither
 * needs the shell to be inside tmux. If setup couldn't start the private
 * server, skip instead of falling back to the user's `$TMUX`.
 */
export function tmuxIntegrationAvailable(): boolean {
  return Boolean(process.env.MU_TMUX_SOCKET);
}

export const fakePane = (paneId: string): VerifiedPaneRef =>
  requireVerifiedPane(paneRef(paneId, FAKE_SERVER_IDENTITY));

function requirePrivateTmux(): void {
  if (!process.env.MU_TMUX_SOCKET?.startsWith("mu-test-")) {
    throw new Error("test fixture requires a private MU_TMUX_SOCKET");
  }
}

/** Only for tests that create and own the private pane, not for a persisted row. */
export async function privatePane(paneId: string): Promise<VerifiedPaneRef> {
  requirePrivateTmux();
  return requireVerifiedPane(paneRef(paneId, await serverIdentity()));
}

/** Clean up a test fixture by name on the suite's private socket. */
export async function killPrivateSession(session: string): Promise<void> {
  requirePrivateTmux();
  await tmux(["kill-session", "-t", `=${session}:`]).catch(() => {});
}

// ─── A Rex block that takes sends ──────────────────────────────────────

/** A valid Rex pane id (a block handle). */
export const REX_PANE = "block:01a1a0d4-b59b-7416-9cdb-67e9cd36dd6b";

/**
 * A Rex executor whose every block resolves and takes a paste and a write:
 * the `mux` channel's send to a non-pi agent. `sent` collects each pasted text.
 */
export function rexSendExecutor(sent: string[] = []): MuxExecutor {
  return async (args) => {
    const input = JSON.parse(args[3] ?? "{}") as {
      queries?: string[];
      method?: string;
      event?: { payload?: { text?: string } };
    };
    if (args[2] === "block.event") sent.push(input.event?.payload?.text ?? "");
    const reply =
      args[2] === "target.resolve"
        ? {
            results: (input.queries ?? [REX_PANE]).map((query) => ({
              query,
              status: "resolved",
              target: {
                kind: "block",
                session_id: "session:s",
                window_id: "window:w",
                block_id: query,
              },
            })),
          }
        : input.method === "modes"
          ? { modes: [{ name: "bracketed_paste", number: 2004, set: true }] }
          : input.method === "write"
            ? { bytes_written: 1 }
            : {};
    return { stdout: JSON.stringify(reply), stderr: "", exitCode: 0 };
  };
}
