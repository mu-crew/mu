// Real mu + tmux: `nextstep check` (every §2.3 row of every untimed case) and `nextstep selftest`
// (the whole path with the scripted evalfaux models, on the pilots) on the built checkout. Zero
// model cost. Skips without dist/, tmux or zsh (the notes_multi pilot runs under zsh). The timed
// cases (wait_heartbeat_merge, wait_shell_limit, sleep_poll) wait out real worker delays of up to
// 200 s after a 120 s lead-in: their check runs only with EVAL_NEXTSTEP_TIMED=1 (about 7 minutes).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextSelftest, runNextCheck } from "../../tools/eval/nextstep.ts";
import { NEXT_CASES } from "../../tools/eval/nextstep-cases.ts";
import { surfaceFromDir } from "../../tools/eval/surface.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const has = (bin: string, arg: string): boolean => {
  try {
    execFileSync(bin, [arg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const ready =
  existsSync(join(ROOT, "dist", "cli.js")) && has("tmux", "-V") && has("zsh", "--version");
const surface = () => ({ ...surfaceFromDir("checkout", ROOT), family: "next" as const });
const untimed = NEXT_CASES.filter((c) => c.timed !== true);
const timed = NEXT_CASES.filter((c) => c.timed === true);
const pilots = NEXT_CASES.filter((c) => ["close_preview_apply", "notes_multi"].includes(c.id));

describe.skipIf(!ready)("nextstep on the built checkout", () => {
  it("check: goldens and alternatives hit; bad, `true`, lucky spellings and forgeries miss", async () => {
    const lines: string[] = [];
    const r = await runNextCheck(surface(), {
      cases: untimed,
      concurrency: 6,
      log: (l) => lines.push(l),
    });
    expect(
      lines.filter((l) => l.startsWith("FAIL")),
      lines.join("\n"),
    ).toEqual([]);
    expect(r.failures).toBe(0);
    const kinds = new Set(
      r.results.map((x) => `${x.case}/${x.leadIn} ${x.kind.replace(/\d+$/, "")}`),
    );
    for (const k of [
      "close_preview_apply/a golden",
      "close_preview_apply/b golden",
      "close_preview_apply/a bad",
      "close_preview_apply/a true",
      "close_preview_apply/a lucky",
      "close_preview_apply/a alt",
      "notes_multi/a golden",
      "notes_multi/a lucky",
      "notes_multi/a alt",
    ])
      expect(kinds, k).toContain(k);
    // the zsh bad fails the way the friction did, and shows one of the two
    const bad = r.results.find((x) => x.case === "notes_multi" && x.kind === "bad");
    expect(bad?.row.partial).toBe(true);
    expect(bad?.row.why).toContain("command 1 exited 1");
    // the forgeries miss on the printed-by-mu rule, not on a failed command
    for (const x of r.results.filter((x) => x.case === "notes_multi" && x.kind.startsWith("lucky")))
      expect(
        x.row.perCommand.every((c) => c.exit === 0),
        x.kind,
      ).toBe(true);
    // every untimed case and lead-in variant proved its golden
    for (const c of untimed)
      expect(
        r.results.some((x) => x.case === c.id && x.kind === "golden" && x.ok),
        c.id,
      ).toBe(true);
  }, 300_000);

  it.skipIf(process.env.EVAL_NEXTSTEP_TIMED !== "1")(
    "check, timed cases: a sleep or a poll standing in for a wait misses",
    async () => {
      const lines: string[] = [];
      const r = await runNextCheck(surface(), {
        cases: timed,
        concurrency: 8,
        log: (l) => lines.push(l),
      });
      expect(
        lines.filter((l) => l.startsWith("FAIL")),
        lines.join("\n"),
      ).toEqual([]);
      // each sleep row misses on the timed rule
      for (const x of r.results.filter((x) => x.kind.startsWith("sleep")))
        expect(x.row.why.join("; "), `${x.case} ${x.kind}`).toMatch(/idle: command/);
    },
    900_000,
  );

  it("selftest: the scripted golden hits, the scripted bad misses, rows resume, the report renders", async () => {
    const lines: string[] = [];
    const code = await nextSelftest(surface(), { cases: pilots, log: (l) => lines.push(l) });
    expect(
      lines.filter((l) => l.startsWith("FAIL")),
      lines.join("\n"),
    ).toEqual([]);
    expect(code).toBe(0);
  }, 240_000);
});
