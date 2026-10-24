// pi loads mu as a package, through pi's real resolver and loader, in an
// isolated HOME / PI_CODING_AGENT_DIR / project dir. Needs dist/ (build
// first) and an installed pi; skips without pi. Never reads ~/.pi.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migratePi } from "../src/pi-migrate.js";

const root = join(import.meta.dirname, "..");
const built = join(root, "dist", "extension", "mu-pi.js");

/** pi's dist/index.js: PI_PACKAGE_DIR, else the `pi` binary's install. */
function piIndex(): string | undefined {
  const candidates: string[] = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  for (const dir of (process.env.PATH ?? "").split(":")) {
    try {
      const bin = realpathSync(join(dir, "pi"));
      // .../pi-coding-agent/dist/bundle/cli.js -> .../pi-coding-agent
      candidates.push(join(dirname(bin), "..", ".."));
    } catch {
      // not on this PATH entry
    }
  }
  return candidates.map((c) => join(c, "dist", "index.js")).find((p) => existsSync(p));
}

const pi = piIndex();
const ready = pi !== undefined && existsSync(built);

interface Loaded {
  extensions: number;
  skills: number;
  prompts: number;
  factories: { path: string; tools: string[] }[];
  errors: unknown[];
}

describe.skipIf(!ready)("pi package (real pi resolver + loader)", () => {
  let tmp: string;
  let home: string;
  let agentDir: string;
  let proj: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-pi-pkg-"));
    home = join(tmp, "home");
    agentDir = join(home, ".pi", "agent");
    proj = join(tmp, "proj");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(proj);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function load(): Loaded {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      MU_MUX: "tmux", // mu_delegate registers only with a mux in reach
    };
    for (const k of ["MU_MANAGED_AGENT", "MU_CTL_SOCK", "MU_DELEGATE", "TMUX", "TMUX_PANE"]) {
      delete env[k];
    }
    const out = execFileSync(
      process.execPath,
      [join(import.meta.dirname, "_pi-load.mjs"), pi ?? "", root, proj, agentDir],
      { env, encoding: "utf8", timeout: 30_000 },
    );
    return JSON.parse(out.trim().split("\n").pop() ?? "") as Loaded;
  }

  it("resolves exactly one extension, one skill and every prompt", () => {
    const r = load();
    expect(r.errors).toEqual([]);
    expect(r.extensions).toBe(1);
    expect(r.skills).toBe(1);
    expect(r.prompts).toBe(
      readdirSync(join(root, "prompts")).filter((f) => f.endsWith(".md")).length,
    );
    expect(r.factories).toHaveLength(1);
    expect(r.factories[0]?.tools).toEqual(["mu_delegate", "mu_delegate_cancel"]);
  });

  it("a legacy shim doubles the factories until `mu pi migrate --apply`", () => {
    const shim = join(agentDir, "extensions", "mu.ts");
    const template = readFileSync(join(root, "test", "fixtures", "link-shim-v3.txt"), "utf8");
    writeFileSync(
      shim,
      template.replace(
        JSON.stringify("file:///opt/mu/dist/extension/mu-pi.js"),
        JSON.stringify(pathToFileURL(built).href),
      ),
    );
    expect(load().factories).toHaveLength(2);

    migratePi({ home, apply: true });
    const after = load();
    expect(after.factories).toHaveLength(1);
    expect(after.factories[0]?.tools).toContain("mu_delegate");
  });
});
