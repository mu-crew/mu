import { afterEach, describe, expect, it, vi } from "vitest";
import { hostExec } from "../src/host-exec.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture({ handshakeInProcess: true });

afterEach(() => vi.restoreAllMocks());

const warning = /^warning: host "box": .*60 s.*use a standing host[^\n]*\n$/;

describe("provider host idle reclaim", () => {
  it("warns on stderr before exec on an idle host with a known window", async () => {
    await h.setup({}, { hostFacts: { idleReclaimMs: 60_000 } });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      expect(h.calls("link.exec")).toHaveLength(0);
      return true;
    });

    expect(await hostExec(h.db, "box", { script: "printf ok" })).toMatchObject({
      exit: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(stderr.mock.calls).toEqual([[expect.stringMatching(warning)]]);
  });

  it("warns before the first spawn, but not before another spawn or exec while its job runs", async () => {
    await h.setup({}, { hostFacts: { idleReclaimMs: 60_000 } });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      expect(h.calls("job.start")).toHaveLength(0);
      return true;
    });

    await h.spawn();
    expect(h.calls("job.start")).toHaveLength(1);
    expect(stderr.mock.calls).toEqual([[expect.stringMatching(warning)]]);
    stderr.mockClear();

    expect((await hostExec(h.db, "box", { script: "true" })).exit).toBe(0);
    await h.spawn({ name: "w2" });
    expect(h.calls("job.start")).toHaveLength(2);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("does not warn before exec or spawn when the plugin reports no window", async () => {
    await h.setup();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect((await hostExec(h.db, "box", { script: "true" })).exit).toBe(0);
    await h.spawn();
    expect(h.calls("job.start")).toHaveLength(1);
    expect(stderr).not.toHaveBeenCalled();
  });
});
