// The link contract (plugins spec D7, D16): one suite, run against the
// built-in `template` link and the fake plugin's link through the link adapter
// (src/plugins/link.ts). Each implementation's host is this machine: the
// template link's exec template runs `{cmd}` under a home directory, and the
// fake plugin runs its scripts there too. The fetch round trip needs real git
// and lives in test/link-contract.integration.test.ts.
//
// The suite asserts the declared capabilities, a run's result, a timeout that
// answers with no exit code (and, where `remoteOnTimeout` is `stopped`, left
// nothing running), the hand-back, `admitted` before the command, `fits`, the
// fingerprint and the declared check phases.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import type { LinkCall } from "../src/host-link.js";
import { type HostView, resolveHost } from "../src/host-provider.js";
import { addHost, HOST_GRACE_MS, HostHandbackError } from "../src/hosts.js";
import { setPluginGraceForTests } from "../src/plugins/process.js";
import { narrowSeams } from "../src/plugins/protocol.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { fakePlugin, linkSeam, sshExample } from "./_plugin.js";

interface Impl {
  name: string;
  /** Make host `dev` on `db`, its scripts run under `home`; returns how to hand back. */
  setup(db: Db, dir: string, home: string): Promise<{ handBack(): void; fingerprint: string }>;
  call: LinkCall;
}

const IMPLS: Impl[] = [
  {
    name: "template",
    async setup(db, dir, home) {
      const flag = join(dir, "handback");
      const exec = `[ -f '${flag}' ] && {{ echo 'touch your key' >&2; exit 3; }}; cd '${home}' && cd {cwd} && /bin/sh -c {cmd}`;
      addHost(db, {
        name: "dev",
        shell: "true",
        exec,
        fetch: "true",
        repo: null,
        max_sessions: null,
      });
      return { handBack: () => writeFileSync(flag, ""), fingerprint: exec };
    },
    call: { holder: "contract" },
  },
  {
    name: "plugin",
    async setup(db, dir, home) {
      const f = fakePlugin(dir, { home });
      await addPlugin(db, "fake", f.argv);
      addHost(db, { name: "dev", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
      return {
        handBack: () => f.set({ faults: { "link.exec": ["human"] } }),
        fingerprint: "plugin:fake:fake-1",
      };
    },
    call: { holder: "contract" },
  },
  {
    name: "ssh",
    async setup(db, dir, home) {
      await addPlugin(db, "ssh", sshExample(dir, home));
      addHost(db, { name: "dev", plugin: "ssh", fetch: "true", repo: null, max_sessions: null });
      return {
        handBack: () => writeFileSync(join(dir, "handback"), ""),
        fingerprint: "plugin:ssh:ssh",
      };
    },
    call: { holder: "contract" },
  },
];

describe.each(IMPLS)("the link contract: $name", (impl) => {
  let dir: string;
  let home: string;
  let db: Db;
  let h: HostView;
  let handBack: () => void;
  let fingerprint: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mlc-"));
    home = join(dir, "home");
    mkdirSync(join(home, "sub"), { recursive: true });
    db = openDb({ path: join(dir, "mu.db") });
    ({ handBack, fingerprint } = await impl.setup(db, dir, home));
    h = resolveHost(db, "dev");
  });

  afterEach(async () => {
    await closePluginSessions();
    db.close();
    rmFixtureDir(dir);
  });

  const exec = (
    script: string,
    opts: { cwd?: string; timeoutMs?: number } = {},
    admitted?: (v: HostView) => void,
  ) =>
    h.link.exec(
      h,
      { script, cwd: opts.cwd ?? ".", timeoutMs: opts.timeoutMs ?? 5000 },
      impl.call,
      admitted,
    );

  it("declares legal capabilities", () => {
    const c = h.link.caps;
    // Every declared value is one the protocol admits (the template measures its exec instead).
    expect(narrowSeams({ link: { ...c, maxScriptBytes: c.maxScriptBytes ?? 1 } }).ok).toBe(true);
    expect(h.link.name).toBe({ template: "template", plugin: "fake", ssh: "ssh" }[impl.name]);
  });

  it("runs a POSIX sh script in the remote cwd: exit code, stdout and stderr whole", async () => {
    const r = await exec("pwd; echo out; echo err >&2; exit 7", { cwd: "sub" });
    expect(r.exitCode).toBe(7);
    expect(r.partial).toBe(false);
    expect(r.stdout.split("\n")[0]).toMatch(/\/home\/sub$/);
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
  });

  it("`.` is the login directory", async () => {
    const r = await exec("pwd");
    expect(r.stdout.trim()).toMatch(/\/home$/);
  });

  it("returns whole stdout (200 KB)", async () => {
    const r = await exec("i=0; while [ $i -lt 2000 ]; do printf '%0100d\\n' $i; i=$((i+1)); done");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l !== "")).toHaveLength(2000);
  });

  it("a timeout answers with no exit code, within the timeout and the grace", async () => {
    const pidFile = join(dir, "pid");
    const t0 = Date.now();
    const r = await exec(`echo $$ > '${pidFile}'; exec sleep 30`, { timeoutMs: 300 });
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(300 + HOST_GRACE_MS + 2000);
    if (h.link.caps.remoteOnTimeout === "stopped") {
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow(); // proven stopped: nothing left running
    }
  });

  it("a hand-back is HostHandbackError, never retried", async () => {
    handBack();
    await expect(exec("touch ran")).rejects.toBeInstanceOf(HostHandbackError);
    expect(existsSync(join(home, "ran"))).toBe(false);
  });

  it("`admitted` runs before the command; a throw runs nothing", async () => {
    let seen: string | undefined;
    await expect(
      exec("touch ran", {}, (v) => {
        seen = v.name;
        throw new Error("refused");
      }),
    ).rejects.toThrow(/refused/);
    expect(seen).toBe("dev");
    expect(existsSync(join(home, "ran"))).toBe(false);
  });

  it("fits a small script and refuses one past its limit, before anything runs", () => {
    const small = h.link.fits(h, "true", ".");
    expect(small.ok).toBe(true);
    expect(small.bytes).toBeGreaterThan(0);
    const big = h.link.fits(h, "x".repeat(small.limit + 1), ".");
    expect(big).toMatchObject({ ok: false, limit: small.limit });
  });

  it("the fingerprint is computed by mu and stable", () => {
    expect(h.link.fingerprint(h)).toBe(fingerprint);
    expect(h.link.fingerprint(resolveHost(db, "dev"))).toBe(fingerprint);
  });

  it("contributes steps for each declared check phase, and none for the others", async () => {
    const ctx = (phase: "template" | "reach" | "agent") => ({
      db,
      host: h,
      phase,
      timeoutMs: 5000,
    });
    for (const phase of ["template", "reach", "agent"] as const) {
      const steps = (await h.link.checkSteps?.(ctx(phase), impl.call)) ?? [];
      if (!h.link.caps.checks?.includes(phase)) {
        expect(steps, phase).toEqual([]);
        continue;
      }
      expect(steps.length, phase).toBeGreaterThan(0);
      expect(steps[0]?.ok).toBe(true);
      if (impl.name !== "template") {
        for (const s of steps) expect(s.step).toMatch(new RegExp(`^${h.link.name}:`));
      }
    }
  });
});

// `push` (D7 G3) on the wire: a link that declares it loads and the adapter's caps carry it;
// one that does not (the template, the default fake) has none; a malformed one is refused at
// load. The adapter's `link.push` call and the provider-host base rule are P6d's.
describe("the link contract: push", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mlp-"));
    db = openDb({ path: join(dir, "mu.db") });
  });

  afterEach(async () => {
    await closePluginSessions();
    db.close();
    rmFixtureDir(dir);
  });

  it("a plugin link that declares push loads, and its caps say so", async () => {
    const f = fakePlugin(dir, { seams: linkSeam({ push: true }) });
    await addPlugin(db, "fake", f.argv);
    addHost(db, { name: "dev", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
    expect(resolveHost(db, "dev").link.caps.push).toBe(true);
  });

  it("the template link and a link without it declare no push", async () => {
    addHost(db, {
      name: "t",
      shell: "true",
      exec: "{cmd}",
      fetch: "true",
      repo: null,
      max_sessions: null,
    });
    expect(resolveHost(db, "t").link.caps.push).toBeUndefined();
    const f = fakePlugin(dir);
    await addPlugin(db, "fake", f.argv);
    addHost(db, { name: "dev", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
    expect(resolveHost(db, "dev").link.caps.push).toBeUndefined();
  });

  it("a push that is not a boolean is refused at load", async () => {
    const f = fakePlugin(dir, { seams: linkSeam({ push: "yes" }) });
    await expect(addPlugin(db, "fake", f.argv)).rejects.toThrow(/push: expected a boolean/);
  });
});

// The adapter's timeouts (D13): the plugin answers a timed-out run itself, at `timeoutMs`; mu's
// own timer allows one grace on top, so an answer at the deadline is a reply, not a kill. A
// link that declares `remoteOnTimeout: "stopping"` stops what it started within one grace after
// its reply: the adapter waits that grace out on a timed-out run, so the view's link is `stopped`.
describe("the link adapter: timeouts", () => {
  let dir: string;
  let db: Db;
  const GRACE = 1500;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mlt-"));
    db = openDb({ path: join(dir, "mu.db") });
    setPluginGraceForTests(GRACE);
  });

  afterEach(async () => {
    setPluginGraceForTests(undefined);
    await closePluginSessions();
    db.close();
    rmFixtureDir(dir);
  });

  async function plugin(config: Record<string, unknown>) {
    const f = fakePlugin(dir, { home: dir, ...config });
    await addPlugin(db, "fake", f.argv);
    addHost(db, { name: "dev", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
    return { f, h: resolveHost(db, "dev") };
  }

  it("an answer that comes at the plugin's deadline is a reply: mu's timer is timeoutMs plus one grace", async () => {
    const { f, h } = await plugin({ faults: { "link.exec": ["late"] }, lateMs: 500 });
    const r = await h.link.exec(
      h,
      { script: "echo hi", cwd: ".", timeoutMs: 300 },
      {
        holder: "t",
      },
    );
    expect(r).toMatchObject({ exitCode: 0, stdout: "hi\n" });
    expect(f.calls().map((c) => c.method)).not.toContain("$/cancel");
    const sent = f.calls().find((c) => c.method === "link.exec")?.params;
    expect(sent?.timeoutMs).toBe(300);
  });

  it('remoteOnTimeout "stopping" loads; a timed-out run returns once the grace has stopped it', async () => {
    const pidFile = join(dir, "pid");
    const { h } = await plugin({
      seams: linkSeam({ remoteOnTimeout: "stopping" }),
      stopLateMs: 400,
    });
    expect(h.link.caps.remoteOnTimeout).toBe("stopped");
    const t0 = Date.now();
    const r = await h.link.exec(
      h,
      { script: `echo $$ > '${pidFile}'; exec sleep 30`, cwd: ".", timeoutMs: 300 },
      { holder: "t" },
    );
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300 + GRACE);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
