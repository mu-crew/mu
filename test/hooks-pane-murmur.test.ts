// The `hooks` channel's murmur calls against a `murmur` on PATH (spec D3,
// D11, D17): the options mu passes a murmur that has them, and what it does
// with an older murmur that refuses them. A fake `murmur` script logs its
// argv and stdin, and answers as the build it stands for: `new` takes
// `hook mu --by` and `clear -L`, `old` refuses both as murmur did before them
// (`hook mu` exits 2 naming the option; commander exits 1 for `clear`).
// Also the parse of `last_text_run`, present or absent.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPaneAttention,
  parseHooksPane,
  resetMurmurFeaturesForTests,
  setMurmurClearRunnerForTests,
  setMurmurHookRunnerForTests,
  writeMuEvent,
} from "../src/channels/hooks-pane.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let originalPath: string | undefined;

/** A fake murmur of `build` first on PATH; each call appends `<argv>|<stdin>` to its log. */
function installMurmur(build: "new" | "old"): void {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const refuse =
    build === "old"
      ? `case " $* " in
  *" hook mu "*--by*) echo "murmur: hook mu: unknown option: --by" >&2; exit 2 ;;
  *" clear "*" -L "*) echo "error: unknown option '-L'" >&2; exit 1 ;;
esac`
      : "";
  writeFileSync(
    join(bin, "murmur"),
    `#!/bin/sh
${refuse}
input=""
case "$1" in hook) input=$(cat) ;; esac
printf '%s|%s\\n' "$*" "$input" >> '${join(dir, "log")}'
exit 0
`,
  );
  chmodSync(join(bin, "murmur"), 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
}

/** The calls the fake murmur took (refused ones are not logged). */
const calls = (): string[] => {
  try {
    return readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhpm-"));
  originalPath = process.env.PATH;
  setMurmurHookRunnerForTests(null);
  setMurmurClearRunnerForTests(null);
  resetMurmurFeaturesForTests();
});
afterEach(() => {
  const pathKey = "PATH";
  if (originalPath === undefined) delete process.env[pathKey];
  else process.env.PATH = originalPath;
  setMurmurHookRunnerForTests(null);
  setMurmurClearRunnerForTests(null);
  resetMurmurFeaturesForTests();
  rmFixtureDir(dir);
});

describe("murmur hook mu --by harness: a relayed harness event", () => {
  it("is written with --by harness where murmur takes it; mu's own events carry no --by", async () => {
    installMurmur("new");
    await withEnv("MU_TMUX_SOCKET", "", async () => {
      expect(await writeMuEvent("%3", { event: "interrupted" }, { by: "harness" })).toBe(true);
      expect(await writeMuEvent("%3", { event: "interrupted" })).toBe(true);
    });
    expect(calls()).toEqual([
      'hook mu --pane %3 --by harness|{"event":"interrupted"}',
      'hook mu --pane %3|{"event":"interrupted"}',
    ]);
  });

  it("an older murmur refuses --by: written as mu's instead, and --by is not tried again", async () => {
    installMurmur("old");
    await withEnv("MU_TMUX_SOCKET", "", async () => {
      expect(await writeMuEvent("%3", { event: "interrupted" }, { by: "harness" })).toBe(true);
      expect(await writeMuEvent("%3", { event: "turn_stopped" }, { by: "harness" })).toBe(true);
    });
    expect(calls()).toEqual([
      'hook mu --pane %3|{"event":"interrupted"}',
      'hook mu --pane %3|{"event":"turn_stopped"}',
    ]);
  });

  it("a murmur that refuses the event itself is not asked again without --by", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "murmur"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(dir, "log")}'\necho "murmur: hook mu: no such pane: %3" >&2\nexit 1\n`,
    );
    chmodSync(join(bin, "murmur"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    await withEnv("MU_TMUX_SOCKET", "", async () => {
      expect(await writeMuEvent("%3", { event: "interrupted" }, { by: "harness" })).toBe(false);
    });
    expect(calls()).toEqual(["hook mu --pane %3 --by harness"]);
  });

  it("no murmur on PATH: false, never a throw", async () => {
    process.env.PATH = join(dir, "empty-bin");
    expect(await writeMuEvent("%3", { event: "interrupted" }, { by: "harness" })).toBe(false);
  });
});

describe("murmur clear on mu's tmux server", () => {
  it("names a private MU_TMUX_SOCKET with -L, as murmur pane is read", async () => {
    installMurmur("new");
    await withEnv("MU_TMUX_SOCKET", "mu-test-sock", async () => {
      expect(await clearPaneAttention("%3")).toBe(true);
    });
    expect(calls()).toEqual(["clear --pane %3 -L mu-test-sock|"]);
  });

  it("no private socket: plain, as the focus hook calls it", async () => {
    installMurmur("new");
    await withEnv("MU_TMUX_SOCKET", "", async () => {
      expect(await clearPaneAttention("%3")).toBe(true);
    });
    expect(calls()).toEqual(["clear --pane %3|"]);
  });

  it("an older murmur refuses -L: asked again without it, as before", async () => {
    installMurmur("old");
    await withEnv("MU_TMUX_SOCKET", "mu-test-sock", async () => {
      expect(await clearPaneAttention("%3")).toBe(true);
    });
    expect(calls()).toEqual(["clear --pane %3|"]);
  });
});

describe("parseHooksPane: last_text_run", () => {
  const report = (agent: Record<string, unknown>) =>
    JSON.stringify({
      pane: "%3",
      state: "idle",
      agent: { activity: "stopped", session_id: "s", run_count: 4, last_text: "x", ...agent },
      attention: [],
    });

  it("is read where murmur reports it, null included", () => {
    expect(parseHooksPane(report({ last_text_run: 4 }))?.lastTextRun).toBe(4);
    expect(parseHooksPane(report({ last_text_run: null }))?.lastTextRun).toBeNull();
  });

  it("is absent from an older murmur's report: unknown, not null", () => {
    const pane = parseHooksPane(report({}));
    expect(pane).toBeDefined();
    expect(pane !== undefined && "lastTextRun" in pane).toBe(false);
  });
});
