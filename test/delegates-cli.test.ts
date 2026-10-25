// `mu delegates` end to end through the CLI (in-process, real SQLite).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStdinReaderForTests } from "../src/cli/stdin.js";
import { rmFixtureDir } from "./_fs.js";
import { runCliJson, runCliWire } from "./_runCli.js";

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-delegates-cli-"));
  db = join(dir, "mu.db");
});
afterEach(() => {
  setStdinReaderForTests(null);
  rmFixtureDir(dir);
});

const reg = (id: string, ...more: string[]) =>
  runCliJson(
    [
      "delegates",
      "register",
      id,
      "--caller",
      "pi:s",
      "-w",
      "scratch",
      "--text",
      "check it",
      "--json",
      ...more,
    ],
    db,
  );

describe("mu delegates", () => {
  it("register -> mark -> finish -> list/show/tally round-trips", async () => {
    await runCliJson(["task", "add", "f1", "-w", "crew", "-t", "f1", "--json"], db);
    const r = await reg(
      "pi:s:1",
      "--record",
      "crew/f1",
      "--wave",
      "w",
      "--label",
      "ref1",
      "--state",
      "starting",
    );
    expect(r.exitCode).toBeNull();
    expect(r.data.call).toMatchObject({ state: "starting", wave: "w" });
    const m = await runCliJson(
      ["delegates", "mark", "pi:s:1", "running", "--agent", "delegate-ref1", "--json"],
      db,
    );
    expect(m.data.call).toMatchObject({ state: "running", agent: "delegate-ref1" });
    const f = await runCliJson(
      [
        "delegates",
        "finish",
        "pi:s:1",
        "--outcome",
        "done",
        "--author",
        "delegate-ref1",
        "--text",
        "VERDICT: REFUTED no\nEVIDENCE:\n- x",
        "--json",
      ],
      db,
    );
    expect(f.data).toMatchObject({
      changed: true,
      state: "done",
      verdict: "REFUTED",
      recorded: true,
    });
    const l = await runCliJson(["delegates", "--caller", "pi:s", "--wave", "w", "--json"], db);
    expect(l.data.items.map((x: { state: string }) => x.state)).toEqual(["done"]);
    const s = await runCliJson(["delegates", "show", "pi:s:1", "--json"], db);
    expect(s.data.call.verdict).toBe("REFUTED");
    const t = await runCliJson(
      ["delegates", "tally", "-w", "scratch", "--wave", "w", "--json"],
      db,
    );
    expect(t.data.findings).toEqual([
      { id: "crew/f1", confirmed: 0, refuted: 1, unverified: 0, pending: 0 },
    ]);
    const notes = await runCliJson(["task", "notes", "f1", "-w", "crew", "--all", "--json"], db);
    expect(JSON.stringify(notes.data)).toContain("EVIDENCE:\\n- x");
  });

  it("a changed request under the same call id exits 4; an unknown record task exits 3 and writes nothing", async () => {
    expect((await reg("pi:s:1")).exitCode).toBeNull();
    const again = await runCliWire(
      [
        "delegates",
        "register",
        "pi:s:1",
        "--caller",
        "pi:s",
        "-w",
        "scratch",
        "--text",
        "other",
        "--json",
      ],
      db,
    );
    expect(again.exitCode).toBe(4);
    const bad = await reg("pi:s:2", "--record", "crew/nope");
    expect(bad.exitCode).toBe(3);
    const l = await runCliJson(["delegates", "--all", "--json"], db);
    expect(l.data.count).toBe(1);
  });

  it("a refused call is listed with its reissue command, then reissued once", async () => {
    await reg("pi:s:1", "--state", "refused");
    const human = await runCliWire(["delegates", "--caller", "pi:s"], db);
    expect(human.stdout).toContain("refused");
    expect(human.stdout).toContain("mu delegates reissue pi:s:1");
    expect(
      (await runCliWire(["delegates", "reissue", "pi:s:1", "--json"], db)).exitCode,
    ).toBeNull();
    expect((await runCliWire(["delegates", "reissue", "pi:s:1", "--json"], db)).exitCode).toBe(4);
  });

  it("the prompt can come from stdin", async () => {
    setStdinReaderForTests(async () => "line one\nline two\n");
    const r = await runCliJson(
      [
        "delegates",
        "register",
        "pi:s:9",
        "--caller",
        "pi:s",
        "-w",
        "scratch",
        "--text",
        "-",
        "--json",
      ],
      db,
    );
    expect(r.data.call.request.text).toBe("line one\nline two");
  });

  it("finish is a no-op the second time", async () => {
    await reg("pi:s:1", "--state", "starting");
    const args = [
      "delegates",
      "finish",
      "pi:s:1",
      "--outcome",
      "done",
      "--author",
      "d",
      "--text",
      "VERDICT: CONFIRMED",
      "--json",
    ];
    expect((await runCliJson(args, db)).data.changed).toBe(true);
    expect((await runCliJson(args, db)).data.changed).toBe(false);
  });
});
