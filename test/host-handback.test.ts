// A host template's exit 3 is a hand-back (a human must act): `HostHandbackError`, thrown by
// `runLeasedTemplate` for exec and fetch. The callers' handling is pinned beside their own tests
// (host-check, remote-spawn, remote-collect, remote-gates); this file pins the throw site, the
// grace budget, the exit mapping and that mu's own remote scripts never exit 3.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import * as execFile from "../src/exec-file.js";
import {
  addHost,
  getHost,
  HOST_GRACE_MS,
  HostHandbackError,
  hostStarter,
  runHostTemplate,
  runLeasedTemplate,
  withHostChannel,
} from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";

vi.mock("../src/exec-file.js", async (orig) => {
  const real = await orig<typeof import("../src/exec-file.js")>();
  return { ...real, execGroupCapture: vi.fn(real.execGroupCapture) };
});

let dir: string;
let db: Db;

const add = (name: string, exec: string, fetch = "true") =>
  addHost(db, { name, shell: "s", exec, fetch, repo: null, max_sessions: 1 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-handback-"));
  db = openDb({ path: join(dir, "mu.db") });
  vi.mocked(execFile.execGroupCapture).mockClear();
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

describe("runLeasedTemplate", () => {
  it("exit 3 from exec throws HostHandbackError with the first line of stderr", async () => {
    add("dev", "printf '\\n  out first\\n'; printf '\\n touch your key \\nsecond\\n' >&2; exit 3");
    const err = await runHostTemplate(db, "dev", "exec", "h", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostHandbackError);
    expect(err).toMatchObject({
      host: "dev",
      field: "exec",
      detail: "touch your key",
      handback: true,
    });
    expect((err as Error).message).toContain("touch your key");
    expect((err as Error).message).not.toContain("\n");
  });

  it("exit 3 from fetch throws too; with an empty stderr the detail is the first stdout line", async () => {
    add("dev", "true", "echo 'tap the key'; exit 3");
    const err = await runHostTemplate(db, "dev", "fetch", "h", {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ field: "fetch", detail: "tap the key" });
  });

  it("any other exit (0, 2, 4, 255, a timeout) is returned, never thrown", async () => {
    for (const code of [0, 2, 4, 255]) {
      add(`h${code}`, `exit ${code}`);
      expect((await runHostTemplate(db, `h${code}`, "exec", "h", {})).exitCode).toBe(code);
    }
    add("slow", "sleep 5");
    expect(
      (await runHostTemplate(db, "slow", "exec", "h", {}, { timeoutMs: 100 })).exitCode,
    ).toBeNull();
  });

  it("is exit 5, label `human needed`, and the channel is freed", async () => {
    add("dev", "exit 3");
    const err = await runHostTemplate(db, "dev", "exec", "h", {}).catch((e: unknown) => e);
    expect(classifyError(err)).toEqual({ label: "human needed", exitCode: 5 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM host_channels").get()).toEqual({ c: 0 });
  });

  it("gives the process group HOST_GRACE_MS (5000), not execGroupCapture's 500", async () => {
    expect(HOST_GRACE_MS).toBe(5000);
    add("dev", "true");
    await withHostChannel(db, "dev", "h", (profile, lease) =>
      runLeasedTemplate(db, lease, getHost(db, "dev"), "exec", {}, 1000).then(() => profile),
    );
    const opts = vi.mocked(execFile.execGroupCapture).mock.calls.at(-1)?.[2];
    expect(opts?.graceMs).toBe(5000);
  });
});

describe("mu's own remote scripts never exit 3", () => {
  // Comments may name it; a script builder may not emit it (4 to 10 are free). A forwarded
  // `exit "$rc"` is accepted: it passes a user's 3 through.
  const code = (file: string): string =>
    readFileSync(join(__dirname, "..", "src", file), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
      .join("\n");

  it.each(["remote-agent.ts", "agents/gate.ts", "hosts.ts"])("%s has no literal `exit 3`", (f) => {
    expect(code(f)).not.toMatch(/\bexit\s+3\b/);
  });

  it("the scan sees a literal exit 3 when there is one", () => {
    expect("fail() { exit 3; }").toMatch(/\bexit\s+3\b/);
  });
});

describe("the ssh starter", () => {
  it("keeps ControlMaster=no and ControlPath=none on the shell template", () => {
    const { shell } = hostStarter("dev");
    expect(shell).toContain("-o ControlMaster=no");
    expect(shell).toContain("-o ControlPath=none");
  });
});
