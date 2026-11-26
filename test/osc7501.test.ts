// OSC 7501: tmux/vtmux pane status, @mu_* spawn tags, state precedence,
// doctor row, and the delegates "waiting" sub-record.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  delegatesOsc,
  emitDelegatesStatus,
  setTtyWriterForTests,
} from "../extension/delegate-osc.js";
import { resetAgentStateCacheForTests } from "../src/agent-state.js";
import { readAgentStates } from "../src/channels/index.js";
import { murmurDoctorCheck } from "../src/doctor-summary.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import {
  paneStatus,
  resetTmuxExecutor,
  setSleepForTests,
  setTmuxExecutor,
  spawnAgent,
  type TmuxExecResult,
} from "../src/tmux.js";
import { withServerIdentity } from "./_verbs-mock.js";

const ok = (stdout = ""): TmuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
const status = (fields: string) => {
  setTmuxExecutor(async () => ok(`${fields}\n`));
  return paneStatus("%3");
};
// version|enabled|state|kind|id|root_state|time
const row = (o: { v?: string; on?: string; s?: string; k?: string; id?: string; r?: string }) =>
  `${o.v ?? "vtmux 1"}|${o.on ?? "on"}|${o.s ?? ""}|${o.k ?? ""}|${o.id ?? ""}|${o.r ?? ""}|1700`;

beforeEach(() => {
  setSleepForTests(async () => {});
  resetAgentStateCacheForTests();
});
afterEach(() => {
  resetTmuxExecutor();
  setMuxForTests(undefined);
  setTtyWriterForTests(() => {});
});

describe("tmux paneStatus (vtmux OSC 7501)", () => {
  it("asks for every field in one display-message", async () => {
    const calls: string[][] = [];
    setTmuxExecutor(async (args) => {
      calls.push([...args]);
      return ok(`${row({})}\n`);
    });
    await paneStatus("%3");
    expect(calls).toHaveLength(1);
    const fmt = calls[0]?.at(-1) ?? "";
    expect(calls[0]?.[0]).toBe("display-message");
    for (const f of [
      "vtmux_version",
      "vtmux-program-status",
      "pane_program_state",
      "pane_program_kind",
      "pane_program_id",
      "pane_program_root_state",
      "pane_program_state_time",
    ]) {
      expect(fmt).toContain(`#{${f}}`);
    }
  });

  it("maps root states like Rex", async () => {
    expect(await status(row({ s: "blocked", k: "permission" }))).toBe("needs_permission");
    expect(await status(row({ s: "blocked", k: "question" }))).toBe("needs_input");
    expect(await status(row({ s: "working", r: "working" }))).toBe("busy");
    for (const s of ["idle", "done", "error"]) {
      expect(await status(row({ s }))).toBe("needs_input");
    }
    expect(await status(row({}))).toBeUndefined();
  });

  it("ignores a child sub-tool record: the root state speaks, its kind is not used", async () => {
    expect(await status(row({ s: "blocked", k: "permission", id: "cargo", r: "idle" }))).toBe(
      "needs_input",
    );
    expect(await status(row({ s: "working", id: "cargo", r: "idle" }))).toBe("needs_input");
    expect(await status(row({ s: "working", id: "cargo", r: "working" }))).toBe("busy");
    expect(await status(row({ s: "working", id: "cargo", r: "" }))).toBeUndefined();
  });

  it("is undefined on plain tmux or with vtmux-program-status off", async () => {
    expect(await status(row({ v: "", s: "working" }))).toBeUndefined();
    expect(await status(row({ on: "off", s: "working" }))).toBeUndefined();
    expect(await status(row({ on: "", s: "working" }))).toBeUndefined();
  });

  it("is undefined when the pane is gone", async () => {
    setTmuxExecutor(async () => ({ stdout: "", stderr: "can't find pane: %3", exitCode: 1 }));
    expect(await paneStatus("%3")).toBeUndefined();
  });
});

describe("spawn tagging", () => {
  it("sets @mu_* options on the new pane, once it exists", async () => {
    const calls: string[][] = [];
    setTmuxExecutor(
      withServerIdentity(async (args) => {
        calls.push([...args]);
        if (args[0] === "has-session") return { stdout: "", stderr: "no", exitCode: 1 };
        return args[0] === "new-session" ? ok("%7\n") : ok();
      }),
    );
    await spawnAgent({
      session: "mu-x",
      window: "w1",
      name: "w1",
      cli: "pi",
      command: "pi",
      commandSource: "cli-key",
      env: { MU_AGENT_NAME: "w1" },
      paneOptions: { "@mu_agent": "w1", "@mu_workstream": "ws", "@mu_role": "worker" },
    });
    const set = calls.filter((a) => a.includes("set-option") || a.join(" ").includes("set-option"));
    const flat = set.map((a) => a.join(" "));
    for (const [k, v] of [
      ["@mu_agent", "w1"],
      ["@mu_workstream", "ws"],
      ["@mu_role", "worker"],
    ]) {
      expect(flat.some((l) => l.includes(k as string) && l.includes(v as string))).toBe(true);
    }
    // env still carried
    expect(calls.find((a) => a[0] === "new-session")).toContain("MU_AGENT_NAME=w1");
  });

  it("a failing tag does not cost the pane", async () => {
    setTmuxExecutor(
      withServerIdentity(async (args) => {
        if (args[0] === "has-session") return { stdout: "", stderr: "no", exitCode: 1 };
        if (args.join(" ").includes("set-option"))
          return { stdout: "", stderr: "boom", exitCode: 1 };
        return args[0] === "new-session" ? ok("%7\n") : ok();
      }),
    );
    const id = await spawnAgent({
      session: "mu-x",
      window: "w1",
      name: "w1",
      cli: "pi",
      command: "pi",
      commandSource: "cli-key",
      env: {},
      paneOptions: { "@mu_agent": "w1" },
    });
    expect(id).toBe("%7");
  });
});

describe("state precedence on tmux", () => {
  const agent = { name: "w1", workstreamName: "ws", paneId: "%3" };

  it("vtmux's report beats murmur (no murmur hooks needed)", async () => {
    setMuxForTests(tmuxBackend);
    setTmuxExecutor(
      withServerIdentity(async (args) => {
        if (args[0] === "list-panes") return ok("%3|0|||\n");
        if (args[0] === "display-message") return ok(`${row({ s: "working", r: "working" })}\n`);
        return ok();
      }),
    );
    const r = (await readAgentStates([agent])).get("ws/w1");
    expect(r).toMatchObject({ state: "busy", source: "tmux", alive: true });
  });
});

describe("doctor row on vtmux", () => {
  it("is ok when vtmux-program-status is on, without murmur", () => {
    const c = murmurDoctorCheck("vtmux", { vtmuxProgramStatus: true });
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("vtmux");
  });
  it("warns when vtmux-program-status is off", () => {
    const c = murmurDoctorCheck("vtmux", { vtmuxProgramStatus: false });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("vtmux-program-status");
  });
});

describe("delegates waiting record", () => {
  it("encodes working with a base64 message, and clear at zero", () => {
    const b64 = Buffer.from("waiting on 2 delegates").toString("base64");
    expect(delegatesOsc(2)).toBe(`\x1b]7501;state=working:id=mu/delegates:msg=${b64}\x1b\\`);
    expect(delegatesOsc(0)).toBe("\x1b]7501;state=clear:id=mu/delegates\x1b\\");
  });

  it("goes to the tty writer, never stdout", () => {
    const seen: string[] = [];
    setTtyWriterForTests((d) => seen.push(d));
    emitDelegatesStatus(1);
    expect(seen).toEqual([delegatesOsc(1)]);
  });
});
