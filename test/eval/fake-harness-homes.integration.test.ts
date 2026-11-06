// The fake claude and codex read their user hooks where the real ones do: `$CLAUDE_CONFIG_DIR`
// and `$CODEX_HOME` when set and non-empty, else under `$HOME`. Runs the real fake-harness
// process with piped stdio and a SessionStart hook that records which config file fired it.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmFixtureDir } from "../_fs.js";

const FAKE = join(import.meta.dirname, "..", "..", "tools", "eval", "fake-harness.ts");

let dir: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-fake-homes-"));
});

afterEach(() => {
  try {
    child?.kill("SIGKILL");
  } catch {}
  child = undefined;
  try {
    rmFixtureDir(dir);
  } catch {}
});

/** A SessionStart hook in `file` that appends `tag` to the marker. */
function hookAt(file: string, tag: string, marker: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const command = `printf '%s\\n' ${tag} >> '${marker}'`;
  writeFileSync(
    file,
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }),
  );
}

/** Start the fake `h` (codex gets a prompt: its session starts with it) and read the marker. */
async function firedBy(h: "claude" | "codex", env: Record<string, string>): Promise<string[]> {
  const home = join(dir, "home");
  const cwd = join(dir, "proj");
  mkdirSync(cwd, { recursive: true });
  const marker = join(dir, "marker");
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, ...env };
  child = spawn(process.execPath, [FAKE, h], {
    cwd,
    env: base,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin?.on("error", () => {});
  if (h === "codex") child.stdin?.write("hi\r");
  for (let i = 0; i < 200 && !existsSync(marker); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // Let a second hook, were one wrongly read, land too.
  await new Promise((r) => setTimeout(r, 200));
  child.kill("SIGKILL");
  return existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [];
}

describe("fake harness user hook homes", () => {
  beforeEach(() => {
    hookAt(join(dir, "home", ".claude", "settings.json"), "home", join(dir, "marker"));
    hookAt(join(dir, "home", ".codex", "hooks.json"), "home", join(dir, "marker"));
    hookAt(join(dir, "cfg", "settings.json"), "cfg", join(dir, "marker"));
    hookAt(join(dir, "cfg", "hooks.json"), "cfg", join(dir, "marker"));
  });

  it("claude reads $CLAUDE_CONFIG_DIR, not ~/.claude", async () => {
    expect(await firedBy("claude", { CLAUDE_CONFIG_DIR: join(dir, "cfg") })).toEqual(["cfg"]);
  });

  it("claude with an empty CLAUDE_CONFIG_DIR reads ~/.claude", async () => {
    expect(await firedBy("claude", { CLAUDE_CONFIG_DIR: "" })).toEqual(["home"]);
  });

  it("codex reads $CODEX_HOME, not ~/.codex", async () => {
    expect(await firedBy("codex", { CODEX_HOME: join(dir, "cfg") })).toEqual(["cfg"]);
  });

  it("codex with an empty CODEX_HOME reads ~/.codex", async () => {
    expect(await firedBy("codex", { CODEX_HOME: "" })).toEqual(["home"]);
  });
});
