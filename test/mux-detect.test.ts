// Detection order for the mux backend: MU_MUX → ambient signal →
// availability → throw.
//
// These tests drive `detectMux()` rather than `activeMux()` because the
// latter memoizes per process; `activeMux` gets its own test below with
// an explicit reset.

import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeMux,
  attachShellLine,
  detectMux,
  type MuxBackend,
  muxByName,
  NoMultiplexerError,
  resetMux,
  resetRexExecutor,
  rexBackend,
  setMuxForTests,
  setRexExecutor,
  tmuxBackend,
} from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";

const MU_MUX = "MU_MUX";
/** The developer's own value: tests set and clear it, then put it back. */
const INHERITED_TERM_PROGRAM = process.env.TERM_PROGRAM;
const TMUX = "TMUX";

/** Make `rex version` succeed. */
function makeRexAvailable(): void {
  setRexExecutor(async () => ({ stdout: "rex 0.1.0", stderr: "", exitCode: 0 }));
}

/** Make `tmux -V` (and everything else) fail, so tmuxBackend.available()
 *  reports false without touching a real tmux server. */
function makeTmuxUnavailable(): void {
  setTmuxExecutor(async () => ({ stdout: "", stderr: "no server", exitCode: 1 }));
}

/** Make `tmux -V` succeed. */
function makeTmuxAvailable(): void {
  setTmuxExecutor(async () => ({ stdout: "tmux 3.4", stderr: "", exitCode: 0 }));
}

describe("detectMux", () => {
  beforeEach(() => {
    delete process.env[MU_MUX];
    delete process.env[TMUX];
    delete process.env.TMUX_PANE;
    setRexExecutor(async () => ({ stdout: "", stderr: "not found", exitCode: 127 }));
    resetMux();
  });

  afterEach(() => {
    delete process.env[MU_MUX];
    delete process.env[TMUX];
    delete process.env.TMUX_PANE;
    resetTmuxExecutor();
    resetRexExecutor();
    delete process.env.REX_SESSION;
    if (INHERITED_TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = INHERITED_TERM_PROGRAM;
    resetMux();
  });

  it("MU_MUX overrides everything, including a hostile environment", async () => {
    // No $TMUX, and tmux -V fails: without the override this would throw.
    makeTmuxUnavailable();
    process.env[MU_MUX] = "tmux";
    expect((await detectMux()).name).toBe("tmux");
  });

  it("an unknown MU_MUX value throws instead of falling through", async () => {
    // A typo'd backend name must fail loud. Silently running on tmux
    // would make `MU_MUX=tmx mu ...` look like it worked.
    process.env[MU_MUX] = "nope";
    await expect(detectMux()).rejects.toThrow(/unknown mux backend: nope/);
  });

  it("an empty MU_MUX is ignored, not treated as a backend name", async () => {
    // `MU_MUX= mu ...` in a shell script should behave like unset.
    process.env[MU_MUX] = "";
    process.env[TMUX] = "/tmp/tmux-1000/default,1,0";
    expect((await detectMux()).name).toBe("tmux");
  });

  it("$TMUX selects tmux without shelling out to check availability", async () => {
    // Caller is already inside a tmux pane; the ambient signal is
    // conclusive, so no `tmux -V` probe should be needed. Prove it by
    // making every tmux call fail.
    makeTmuxUnavailable();
    process.env[TMUX] = "/tmp/tmux-1000/default,1,0";
    expect((await detectMux()).name).toBe("tmux");
  });

  it("$TMUX_PANE alone also selects tmux", async () => {
    // tmux sets both vars, but sudo -E / direnv / ssh SendEnv setups can
    // pass one and drop the other. Either proves we are in a tmux pane.
    // Regression: checking only $TMUX made identity resolution throw
    // NoMultiplexerError for a worker whose $TMUX had been stripped.
    makeTmuxUnavailable();
    process.env.TMUX_PANE = "%42";
    try {
      expect((await detectMux()).name).toBe("tmux");
    } finally {
      delete process.env.TMUX_PANE;
    }
  });

  it("falls back to availability when no ambient signal is present", async () => {
    // A plain shell outside any pane: mu can still create a detached
    // session, so a working tmux binary is enough.
    makeTmuxAvailable();
    expect((await detectMux()).name).toBe("tmux");
  });

  it("throws NoMultiplexerError when nothing is available", async () => {
    makeTmuxUnavailable();
    await expect(detectMux()).rejects.toBeInstanceOf(NoMultiplexerError);
  });

  it("NoMultiplexerError names what it tried, so the message is actionable", async () => {
    makeTmuxUnavailable();
    await expect(detectMux()).rejects.toThrow(/tried: tmux, rex/);
  });

  it("a Rex terminal selects rex without shelling out", async () => {
    makeTmuxAvailable();
    setRexExecutor(async () => {
      throw new Error("the ambient signal is conclusive; no probe expected");
    });
    process.env.REX_SESSION = "session:01a1a0d3-ec66-7aa6-9558-c70476578a93";
    process.env.TERM_PROGRAM = "rex";
    expect((await detectMux()).name).toBe("rex");
  });

  it("tmux run inside a Rex terminal wins over Rex", async () => {
    // tmux inherits $REX_SESSION from the Rex pane it was started in.
    makeTmuxAvailable();
    process.env.REX_SESSION = "session:01a1a0d3-ec66-7aa6-9558-c70476578a93";
    process.env.TERM_PROGRAM = "rex";
    process.env[TMUX] = "/tmp/tmux-1000/default,1,0";
    expect((await detectMux()).name).toBe("tmux");
  });

  it("a stale $REX_SESSION outside a Rex terminal does not select rex", async () => {
    makeTmuxAvailable();
    process.env.REX_SESSION = "session:01a1a0d3-ec66-7aa6-9558-c70476578a93";
    process.env.TERM_PROGRAM = "iTerm.app";
    expect((await detectMux()).name).toBe("tmux");
  });

  it("MU_MUX=rex selects the rex backend", async () => {
    process.env[MU_MUX] = "rex";
    expect(await detectMux()).toBe(rexBackend);
  });

  it("MU_MUX=herdr fails loud: herdr is retired, never a silent fallback", async () => {
    makeTmuxAvailable();
    process.env[MU_MUX] = "herdr";
    await expect(detectMux()).rejects.toThrow(/mu 6 no longer drives herdr/);
  });

  it("$HERDR_ENV=1 no longer selects anything: tmux by availability", async () => {
    makeTmuxAvailable();
    process.env.HERDR_ENV = "1";
    try {
      expect((await detectMux()).name).toBe("tmux");
    } finally {
      delete process.env.HERDR_ENV;
    }
  });

  it("falls back to Rex availability when tmux is absent", async () => {
    makeTmuxUnavailable();
    makeRexAvailable();
    expect((await detectMux()).name).toBe("rex");
  });

  it("tmux wins a pure availability tie, since it is the incumbent", async () => {
    makeTmuxAvailable();
    makeRexAvailable();
    expect((await detectMux()).name).toBe("tmux");
  });
});

describe("muxByName", () => {
  it("resolves a known backend", () => {
    expect(muxByName("tmux")).toBe(tmuxBackend);
    expect(muxByName("rex")).toBe(rexBackend);
  });

  it("throws on an unknown backend", () => {
    // Cast: the point is to guard the RUNTIME path, which is reachable
    // from the MU_MUX env var and therefore not protected by the type.
    expect(() => muxByName("zellij" as "tmux")).toThrow(/unknown mux backend/);
  });
});

describe("activeMux memoization", () => {
  beforeEach(() => {
    // A real Rex install would otherwise answer `rex version` here.
    setRexExecutor(async () => ({ stdout: "", stderr: "not found", exitCode: 127 }));
  });
  afterEach(() => {
    delete process.env[TMUX];
    resetTmuxExecutor();
    resetRexExecutor();
    resetMux();
  });

  it("detects once and reuses the result", async () => {
    let probes = 0;
    setTmuxExecutor(async () => {
      probes += 1;
      return { stdout: "tmux 3.4", stderr: "", exitCode: 0 };
    });
    delete process.env[TMUX];
    resetMux();

    const first = await activeMux();
    const second = await activeMux();

    expect(second).toBe(first);
    // One `tmux -V` for the first call, none for the second.
    expect(probes).toBe(1);
  });

  it("resetMux forces re-detection", async () => {
    makeTmuxAvailable();
    delete process.env[TMUX];
    resetMux();

    await activeMux();
    resetMux();
    // If the cache had survived, a now-unavailable tmux would still
    // resolve; it must throw instead.
    makeTmuxUnavailable();
    await expect(activeMux()).rejects.toBeInstanceOf(NoMultiplexerError);
  });

  it("setMuxForTests installs a backend and returns the previous one", async () => {
    resetMux();
    const fake = { ...tmuxBackend, name: "tmux" } as MuxBackend;
    const previous = setMuxForTests(fake);
    expect(await activeMux()).toBe(fake);
    setMuxForTests(previous);
  });
});

describe("tmuxBackend conforms to the MuxBackend contract", () => {
  afterEach(() => {
    resetTmuxExecutor();
  });

  it("owns pane-id validation, so no global regex is needed", () => {
    // The whole point of Q2: shape is the BACKEND's business. tmux ids
    // are %N; a Rex block or a retired herdr id must not validate here.
    expect(tmuxBackend.isValidPaneId("%15")).toBe(true);
    expect(tmuxBackend.isValidPaneId("w1:p1")).toBe(false);
    expect(tmuxBackend.isValidPaneId("block:01a1a0d4-b59b-7416-9cdb-67e9cd36dd6b")).toBe(false);
    expect(tmuxBackend.isValidPaneId("0")).toBe(false);
  });

  it("available() reports false when the binary cannot run", async () => {
    makeTmuxUnavailable();
    expect(await tmuxBackend.available()).toBe(false);
  });

  it("available() reports true when tmux -V succeeds", async () => {
    makeTmuxAvailable();
    expect(await tmuxBackend.available()).toBe(true);
  });
});

describe("attachCommands + attachShellLine", () => {
  // The suite runs on a private socket; these cases are about the default one.
  let savedSocket: string | undefined;
  beforeEach(() => {
    savedSocket = process.env.MU_TMUX_SOCKET;
    const key = "MU_TMUX_SOCKET";
    delete process.env[key];
  });
  afterEach(() => {
    if (savedSocket !== undefined) process.env.MU_TMUX_SOCKET = savedSocket;
  });

  // src/cli/agents.ts prints the joined line and the TUI runs the steps.
  // Both come from the BACKEND: a Rex user handed `tmux attach` is
  // worse off than one handed nothing.
  it("inside a client, switches rather than attaching a second one", async () => {
    const target = { session: "mu-auth", inside: true };
    const steps = await tmuxBackend.attachCommands(target);
    expect(steps).toEqual([{ command: "tmux", args: ["switch-client", "-t", "=mu-auth:"] }]);
    expect(attachShellLine(steps)).toBe("tmux switch-client -t =mu-auth:");
  });

  it("refuses an agent window without its pane", async () => {
    await expect(
      tmuxBackend.attachCommands({ session: "mu-auth", window: "worker-1" }),
    ).rejects.toThrow(/needs a pane/);
  });

  it("a session-only target attaches to the session", async () => {
    // `mu workstream init` has no agent yet, so there is no window.
    expect(await tmuxBackend.attachCommands({ session: "mu-auth" })).toHaveLength(1);
  });

  describe("optional steps, executed under /bin/sh", () => {
    const run = (steps: Parameters<typeof attachShellLine>[0]): { code: number; out: string } => {
      const r = spawnSync("/bin/sh", ["-c", attachShellLine(steps)], { encoding: "utf8" });
      return { code: r.status ?? -1, out: r.stdout };
    };
    const ok = { command: "true", args: [] as string[] };
    const bad = { command: "false", args: [] as string[] };
    const after = { command: "printf", args: ["AFTER"] };

    it("a failing optional LAST step does not fail the line", () => {
      expect(run([ok, { ...bad, optional: true, reason: "decorative" }]).code).toBe(0);
    });

    it("a failed required step stops everything after it, optional or not", () => {
      expect(run([bad, { ...ok, optional: true }, after])).toEqual({ code: 1, out: "" });
      expect(run([bad, { ...bad, optional: true }, after])).toEqual({ code: 1, out: "" });
    });

    it("required ok, optional failing, required next: the next step still runs", () => {
      expect(run([ok, { ...bad, optional: true }, after])).toEqual({ code: 0, out: "AFTER" });
    });

    it("a failing optional FIRST step does not stop what follows", () => {
      expect(run([{ ...bad, optional: true }, after])).toEqual({ code: 0, out: "AFTER" });
    });

    it("a required failure after an optional step still fails the line", () => {
      expect(run([{ ...bad, optional: true }, bad]).code).toBe(1);
    });
  });

  it("quotes tokens that are not plain, and joins required steps with &&", () => {
    expect(
      attachShellLine([
        { command: "rex", args: ["-S", "my work"] },
        { command: "rex", args: [] },
      ]),
    ).toBe("rex -S 'my work' && rex");
  });
});

describe("tmuxBackend.healthCheck", () => {
  afterEach(() => {
    resetTmuxExecutor();
    delete process.env[TMUX];
    delete process.env.TMUX_PANE;
  });

  it("reports the version and the ambient env facts tmux owns", async () => {
    makeTmuxAvailable();
    process.env[TMUX] = "/tmp/tmux-1000/default,1,0";
    process.env.TMUX_PANE = "%7";

    const health = await tmuxBackend.healthCheck();

    expect(health.name).toBe("tmux");
    expect(health.ok).toBe(true);
    expect(health.version).toBe("tmux 3.4");
    // DATA, not prose: `mu doctor` owns every string the user sees, so
    // a second backend with different env vars needs no doctor change.
    expect(health.env).toEqual([
      { name: "$TMUX", value: "/tmp/tmux-1000/default,1,0" },
      { name: "$TMUX_PANE", value: "%7" },
    ]);
  });

  it("reports ok:false with a remediation instead of throwing", async () => {
    // doctor's job is REPORTING a broken substrate. A throw here would
    // make `mu doctor` useless on exactly the box that needs it.
    makeTmuxUnavailable();
    const health = await tmuxBackend.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.version).toBeNull();
    expect(health.remediation.length).toBeGreaterThan(0);
  });

  it("reports unset env facts as null, not the empty string", async () => {
    makeTmuxAvailable();
    const health = await tmuxBackend.healthCheck();
    expect(health.env.every((f) => f.value === null)).toBe(true);
  });
});
