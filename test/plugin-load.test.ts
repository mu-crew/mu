// The load and trust rules (plugins spec D13, D4 load-time rules, D14 Trust):
// a bad declaration is refused at load with `PluginRefusedError` (exit 4), and
// mu refuses to run a file it cannot trust. Each rule against the fake plugin.

import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import { startPlugin } from "../src/plugins/client.js";
import { PluginRefusedError } from "../src/plugins/errors.js";
import {
  addPlugin,
  closePluginSessions,
  pluginSession,
  trustProblems,
} from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { fakePlugin, linkSeam } from "./_plugin.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpld-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(async () => {
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

const KEY = { lookup: false, fenceKey: false };
const JOB = {
  kind: "cloud",
  view: "detached",
  handle: "reply",
  start: { lookup: true, fenceKey: true },
};
const CHANNEL_CAPS = {
  fence: "none",
  receipt: "exact",
  steer: "none",
  interrupt: "exact",
  fresh: "none",
  answer: false,
  command: false,
  watch: "stream",
  settleText: "tied",
};

async function refusal(
  config: Record<string, unknown>,
  needs?: Array<"link" | "job">,
): Promise<string> {
  const f = fakePlugin(dir, config);
  const err = await startPlugin("fake", f.argv, { graceMs: 200, ...(needs ? { needs } : {}) }).then(
    async (s) => {
      await s.shutdown();
      return undefined;
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginRefusedError);
  expect(classifyError(err).exitCode).toBe(4);
  return (err as Error).message;
}

describe("load rules", () => {
  it("the fake's default declaration loads", async () => {
    const f = fakePlugin(dir);
    const s = await startPlugin("fake", f.argv, { graceMs: 200 });
    expect(Object.keys(s.init.seams)).toEqual(["link"]);
    await s.shutdown();
  });

  it("a schema digest that is not the published file's", async () => {
    expect(await refusal({ schema: `sha256:${"0".repeat(64)}` })).toMatch(
      /schema digest .* is not/,
    );
  });

  it("a plugin that names itself otherwise than its registration", async () => {
    expect(await refusal({ name: "other" })).toMatch(/names itself "other", registered as "fake"/);
  });

  it("a seam the caller needs but the plugin lacks", async () => {
    expect(await refusal({}, ["job"])).toMatch(/implements no job seam/);
  });

  it("no seam at all", async () => {
    expect(await refusal({ seams: {} })).toMatch(/declares no seam/);
  });

  it("a missing mandatory capability (the link's maxScriptBytes)", async () => {
    const link = { ...(linkSeam().link as Record<string, unknown>) };
    delete link.maxScriptBytes;
    expect(await refusal({ seams: { link } })).toMatch(/handshake is invalid: .*maxScriptBytes/);
  });

  it("a capability mu does not know", async () => {
    expect(await refusal({ seams: linkSeam({ teleport: true }) })).toMatch(
      /link\.teleport: expected no such field/,
    );
  });

  it("an unknown seam", async () => {
    expect(await refusal({ seams: { ...linkSeam(), mux: {} } })).toMatch(/seams\.mux/);
  });

  it("a host seam without the link and job seams", async () => {
    expect(
      await refusal({ seams: { host: { acquire: { lookup: true, fenceKey: true } } } }),
    ).toMatch(/host seam needs the link and job seams/);
  });

  it("host.acquire with neither lookup nor exact dedupe", async () => {
    const seams = { host: { acquire: KEY }, ...linkSeam(), job: JOB };
    expect(await refusal({ seams })).toMatch(
      /host\.acquire declares neither lookup nor exact dedupe/,
    );
  });

  it('job.start with handle "reply" and neither lookup nor exact dedupe', async () => {
    expect(await refusal({ seams: { ...linkSeam(), job: { ...JOB, start: KEY } } })).toMatch(
      /job\.start with handle "reply" declares neither/,
    );
  });

  it("exact dedupe alone keys a reply-handle start", async () => {
    const start = { ...KEY, dedupe: { exact: true, windowMs: 60_000 } };
    const f = fakePlugin(dir, { seams: { ...linkSeam(), job: { ...JOB, start } } });
    const s = await startPlugin("fake", f.argv, { graceMs: 200 });
    await s.shutdown();
  });

  it.each([
    ["watch", "poll", /must declare watch "stream"/],
    ["settleText", "none", /settleText other than "none"/],
    ["fence", "sync", /no write fence/],
  ] as const)("a plugin channel with %s %s", async (key, value, re) => {
    const seams = { channel: { name: "cloud", caps: { ...CHANNEL_CAPS, [key]: value } } };
    expect(await refusal({ seams })).toMatch(re);
  });

  it("a job seam whose channel is not the channel seam's name", async () => {
    const seams = {
      ...linkSeam(),
      job: { ...JOB, channel: "elsewhere" },
      channel: { name: "cloud", caps: CHANNEL_CAPS },
    };
    expect(await refusal({ seams })).toMatch(
      /job\.channel "elsewhere" is not the channel seam's name/,
    );
  });

  it("a handshake the plugin answers with an error, its stderr line in the reason", async () => {
    expect(await refusal({ speaks: [3, 3], stderr: "fake: boot banner" })).toMatch(
      /handshake failed: permanent: no common protocol version.*stderr: fake: boot banner/,
    );
  });

  it("an argv that does not start", async () => {
    const err = await startPlugin("fake", [join(dir, "nope", "mu-plugin-fake")], {
      graceMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginRefusedError);
    expect((err as Error).message).toMatch(/did not start/);
  });

  it("a declaration that changed since `mu plugin add` is refused until it is added again", async () => {
    const f = fakePlugin(dir);
    await addPlugin(db, "fake", f.argv);
    f.set({ seams: linkSeam({ slots: "mu" }) });
    await expect(pluginSession(db, "fake")).rejects.toThrow(
      /other seams or capabilities .* mu plugin add fake/,
    );
    await closePluginSessions();
    const again = await addPlugin(db, "fake", f.argv);
    expect(again.refreshed).toBe(true);
    const s = await pluginSession(db, "fake");
    expect(s.init.seams.link?.slots).toBe("mu");
  });

  it("a changed instance or version is recorded, not refused", async () => {
    const f = fakePlugin(dir);
    await addPlugin(db, "fake", f.argv);
    f.set({ instance: "fake-2", version: "0.2.0" });
    await pluginSession(db, "fake");
    expect(db.prepare("SELECT instance, version FROM plugins WHERE name = 'fake'").get()).toEqual({
      instance: "fake-2",
      version: "0.2.0",
    });
  });
});

describe("trust rules", () => {
  it("accepts the user's own 0755 mu-plugin-<name>", () => {
    expect(trustProblems("fake", fakePlugin(dir).path)).toEqual([]);
  });

  it("refuses a relative path", () => {
    expect(trustProblems("fake", "bin/mu-plugin-fake")).toEqual([
      '"bin/mu-plugin-fake" is not an absolute path',
    ]);
  });

  it("refuses another basename", () => {
    const f = fakePlugin(dir, {}, "other");
    expect(trustProblems("fake", f.path)).toEqual([
      "its executable must be named mu-plugin-fake, not mu-plugin-other",
    ]);
  });

  it.each([0o775, 0o757])("refuses a file with mode %o (group- or world-writable)", (mode) => {
    const f = fakePlugin(dir);
    chmodSync(f.path, mode);
    expect(trustProblems("fake", f.path)).toEqual([`${f.path} is group- or world-writable`]);
  });

  it("refuses a symlink to a writable file, and accepts one to a sound file", () => {
    const f = fakePlugin(dir, {}, "real");
    const link = join(dir, "mu-plugin-fake");
    symlinkSync(f.path, link);
    expect(trustProblems("fake", link)).toEqual([]);
    chmodSync(f.path, 0o777);
    expect(trustProblems("fake", link)).toEqual([`${link}'s target is group- or world-writable`]);
  });

  it("refuses a file that is not executable, and a directory", () => {
    const file = join(dir, "mu-plugin-fake");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o644);
    expect(trustProblems("fake", file)).toEqual([`${file} is not executable by you`]);
    expect(trustProblems("fake", join(dir, "nothing", "mu-plugin-fake"))).toEqual([
      `${join(dir, "nothing", "mu-plugin-fake")} does not exist`,
    ]);
  });

  it("`mu plugin add` refuses an untrusted path before running anything", async () => {
    const f = fakePlugin(dir);
    chmodSync(f.path, 0o777);
    await expect(addPlugin(db, "fake", f.argv)).rejects.toThrow(/group- or world-writable/);
    expect(f.calls()).toEqual([]);
  });
});
