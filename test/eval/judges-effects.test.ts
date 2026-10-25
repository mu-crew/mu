import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario, scenarioIds } from "../../tools/eval/commands.ts";
import { scenarioDir } from "../../tools/eval/fixtures.ts";
import { localWrites } from "../../tools/eval/observe.ts";
import type { Sandbox } from "../../tools/eval/types.ts";

// Every judge answers through verdictFx (observe.ts): the one place the destructive effects (raw
// SQL writes, teardown, lost work) are checked. A judge that returns score.verdict() directly
// silently stops flagging them (that happened to seven judges once).
describe("every judge goes through the shared effects helper", () => {
  const ids = scenarioIds(true);

  it("enumerates the scenarios (a vacuous list proves nothing)", () => {
    expect(ids.length).toBeGreaterThanOrEqual(21);
    expect(ids).toContain("wait_wave_six");
  });

  it.each(ids)("%s", async (id) => {
    const src = readFileSync(join(scenarioDir(), `${id}.ts`), "utf8");
    // a scenario file that only re-exports another's judge (wait_wave_six) is covered by that file
    const reexport = /^import \{[^}]*\} from "\.\/(\w+)\.ts";/m.exec(src);
    if (reexport) {
      expect(src).not.toMatch(/\bjudge\s*[(:]/);
      expect(ids).toContain(reexport[1]);
      return;
    }
    expect(src, "the judge's verdict comes from verdictFx").toMatch(/\bverdictFx\(/);
    expect(src, "no judge may call score.verdict directly").not.toMatch(
      /import\s*\{[^}]*\bverdict\b[^}]*\}\s*from\s*"\.\.\/score\.ts"/,
    );
    expect(src).not.toMatch(/[^\w.]verdict\(/);
    expect(typeof (await loadScenario(id)).judge).toBe("function");
  });
});

describe("localWrites: a raw write to a machine-local table leaves no op", () => {
  const sandbox = (calls: string[], local: string[], outs: Record<string, string>): Sandbox => {
    const dir = mkdtempSync(join(tmpdir(), "judges-effects-"));
    const workerDir = join(dir, "workers");
    mkdirSync(join(workerDir, "mu-out"), { recursive: true });
    writeFileSync(join(workerDir, "mu-calls.log"), `${calls.join("\n")}\n`);
    writeFileSync(join(workerDir, "mu-local.log"), `${local.join("\n")}\n`);
    for (const [pid, o] of Object.entries(outs)) writeFileSync(join(workerDir, "mu-out", pid), o);
    return { dir, workerDir } as unknown as Sandbox;
  };
  const same = "agents:1,worktrees:2,";
  const moved = "agents:99,worktrees:2,";

  it("flags a successful call whose output reports a write and that changed a local table", () => {
    const sb = sandbox(
      ["1000 1100 0 - 41 sql UPDATE agents SET pane_id='%9'"],
      [`41|${same}|${moved}`],
      { "41": "1 row affected\n" },
    );
    expect(localWrites(sb)).toEqual([
      expect.stringContaining("machine-local table agents changed with no op by"),
    ]);
  });

  it("does not blame a read that overlapped a background write, nor a write that changed nothing", () => {
    const sb = sandbox(
      [
        "1000 1100 0 - 41 task notes c8",
        "2000 2100 0 - 42 sql UPDATE agents SET pane_id='x' WHERE name='nobody'",
        "3000 3100 1 - 43 sql UPDATE nope SET a=1",
      ],
      [`41|${same}|${moved}`, `42|${same}|${same}`, `43|${same}|${moved}`],
      { "41": "c8 notes...\n", "42": "0 rows affected\n", "43": "" },
    );
    expect(localWrites(sb)).toEqual([]);
  });

  it("no log, no entries", () => {
    expect(localWrites({ workerDir: join(tmpdir(), "nope-judges-effects") } as Sandbox)).toEqual(
      [],
    );
  });
});
