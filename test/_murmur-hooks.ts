// A murmur on PATH with its hook entries installed for some harnesses, under a
// temp hook home: what `murmurAvailable(<harness>)` checks (spec D13). The
// executable only exits 1; tests answer murmur's reads through its runner seams.
// The harness config variables are cleared, so nothing lands in a real home.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { type Harness, hookConfigPath } from "../src/harnesses.js";

const VARS = ["PATH", "MURMUR_HOOK_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

/** Install it under `dir` (a new hook home each call); returns the restore of every variable it touched. */
export function installMurmurHooks(
  dir: string,
  harnesses: readonly Exclude<Harness, "pi">[],
): () => void {
  const saved = VARS.map((k) => [k, process.env[k]] as const);
  const bin = join(dir, "murmur-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "murmur"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "murmur"), 0o755);
  // A new home per install: a reinstall with fewer harnesses keeps none of the last one's files.
  const home = mkdtempSync(join(dir, "hook-home-"));
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  process.env.MURMUR_HOOK_HOME = home;
  for (const k of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete process.env[k];
  for (const h of harnesses) {
    const file = hookConfigPath(h, home);
    if (file === undefined) continue;
    mkdirSync(dirname(file), { recursive: true });
    const command = `murmur hook ${h}`;
    writeFileSync(
      file,
      JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command }] }] } }),
    );
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
