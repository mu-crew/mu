// The host provider seam (spec 2026-11-09-mu-plugins.md, D6, unit P3):
// `resolveHost` turns a host name into its view (link, provider, job kind,
// profile), and the built-in `static` provider answers `up` with no round trip
// and refuses what only a provider host does. The import guard is
// test/host-imports.test.ts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  admittedView,
  type Call,
  findHost,
  type HostView,
  hostIdentity,
  requireProfile,
  resolveHost,
  StaticHostError,
  staticProvider,
} from "../src/host-provider.js";
import { addHost, getHost, HostNotFoundError, HostProfileError } from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

const call = (): Call => ({ deadline: Date.now() + 1000, signal: new AbortController().signal });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhp-"));
  db = openDb({ path: join(dir, "mu.db") });
  addHost(db, {
    name: "dev",
    shell: "ssh dev",
    exec: "ssh dev {cmd}",
    fetch: "git fetch dev",
    repo: "/srv/repo",
    max_sessions: null,
  });
  addHost(db, {
    name: "farm",
    shell: "carrier --job-file {job_file} -L {local_sock}:{remote_sock} -- env {env} sh -c {cmd}",
    exec: "ssh farm {cmd}",
    fetch: "git fetch farm",
    repo: null,
    max_sessions: 2,
    transport: "lease",
    stop: "ssh farm stop {job}",
  });
});

afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

describe("resolveHost", () => {
  it("a session profile: the template link, the static provider, the pane kind, the profile", () => {
    const h = resolveHost(db, "dev");
    expect(h.name).toBe("dev");
    expect(h.link.name).toBe("template");
    expect(h.provider).toBe(staticProvider);
    expect(h.jobKind.name).toBe("pane");
    expect(h.profile).toEqual(getHost(db, "dev"));
    expect(h.record).toBeUndefined();
    expect(h.link.fingerprint(h)).toBe("ssh dev {cmd}");
  });

  it("a lease profile's jobs run as the lease kind", () => {
    const h = resolveHost(db, "farm");
    expect(h.jobKind.name).toBe("lease");
    expect(h.jobKind.caps).toEqual({
      view: "bound",
      handle: "file",
      checks: ["template", "agent"],
    });
  });

  it("an unknown name throws HostNotFoundError; findHost answers undefined", () => {
    expect(() => resolveHost(db, "nope")).toThrow(HostNotFoundError);
    expect(findHost(db, "nope")).toBeUndefined();
    expect(findHost(db, "dev")?.profile?.name).toBe("dev");
  });

  it("findHost lets any other error through", () => {
    db.close();
    expect(() => findHost(db, "dev")).toThrow(/not open/);
    db = openDb({ path: join(dir, "mu.db") });
  });

  it("hostIdentity is the link's fingerprint, read alone", () => {
    const h = resolveHost(db, "farm");
    expect(hostIdentity(db, "farm")).toBe(h.link.fingerprint(h));
    expect(hostIdentity(db, "nope")).toBeUndefined();
  });

  it("an admitted snapshot is viewed as given, never re-read", () => {
    const snap = { ...getHost(db, "dev"), repo: "/admitted" };
    expect(admittedView(db, snap).profile).toBe(snap);
  });

  it("requireProfile refuses a view with no profile (a provider host's)", () => {
    const h = resolveHost(db, "dev");
    expect(requireProfile(h)).toBe(h.profile);
    const { profile: _, ...record } = h;
    const provider: HostView = record;
    expect(() => requireProfile(provider)).toThrow(HostProfileError);
    expect(() => requireProfile(provider)).toThrow(/dev is a provider host/);
  });
});

describe("the static provider", () => {
  it("status answers up with the handle, without touching the DB", async () => {
    db.close(); // a round trip would throw
    await expect(staticProvider.status("dev", call())).resolves.toEqual({
      state: "up",
      handle: "dev",
    });
    db = openDb({ path: join(dir, "mu.db") });
  });

  it("acquire, lookup and release refuse: static hosts are added and removed", async () => {
    const refusals = [
      staticProvider.acquire({}, "k1", call()),
      staticProvider.lookup("k1", { fence: true }, call()),
      staticProvider.release("dev", "k2", call()),
    ];
    for (const [i, p] of refusals.entries()) {
      await expect(p).rejects.toBeInstanceOf(StaticHostError);
      await expect(p).rejects.toThrow(
        new RegExp(
          `static provider cannot ${["acquire", "lookup", "release"][i]}: .*mu host add/rm`,
        ),
      );
    }
    // A HostProfileError: `handle()` maps it to exit 2.
    expect(new StaticHostError("acquire")).toBeInstanceOf(HostProfileError);
    expect(staticProvider.name).toBe("static");
  });
});
