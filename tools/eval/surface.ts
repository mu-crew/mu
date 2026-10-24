// A surface is a directory holding a built mu (dist/ + skills/mu). mu is only ever a subprocess.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Family, Surface } from "./types.ts";

export const SURFACES_DIR: string = join(homedir(), ".cache", "mu", "eval", "surfaces");

export function surfaceFromDir(name: string, root: string): Surface {
  const abs = resolve(root);
  const surface: Surface = {
    name,
    root: abs,
    cli: join(abs, "dist", "cli.js"),
    extension: join(abs, "dist", "extension", "mu-pi.js"),
    skillDir: join(abs, "skills", "mu"),
  };
  const need = [surface.cli, surface.extension, join(surface.skillDir, "SKILL.md")];
  const missing = need.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      `surface ${name} (${abs}) is missing: ${missing.join(", ")} (run npm run build)`,
    );
  }
  return surface;
}

/** A surface name is one plain lowercase path segment: no separators, no "..", not hidden, not empty. */
export function surfaceDir(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.includes("..")) {
    throw new Error(
      `invalid surface name ${JSON.stringify(name)}: use lowercase letters, digits, . _ -`,
    );
  }
  const dir = join(SURFACES_DIR, name);
  // strict child only: dir === SURFACES_DIR would let prepareSurface delete every surface
  if (!resolve(dir).startsWith(SURFACES_DIR + sep)) {
    throw new Error(`invalid surface name ${JSON.stringify(name)}: escapes ${SURFACES_DIR}`);
  }
  return dir;
}

/**
 * A scenario root must exist and live outside SURFACES_DIR: prepareSurface rm -rf's the dirs in
 * there, which would take candidate scripts with it. Returns the absolute path.
 */
export function checkScenarioRoot(root: string): string {
  const abs = resolve(root);
  const inside = (p: string, c: string): boolean => p === c || p.startsWith(c + sep);
  const refuse = (): never => {
    throw new Error(
      `scenario root ${abs} is inside ${SURFACES_DIR}, which prepare deletes; use e.g. tools/eval/candidates/<decision>-<a|b|c>`,
    );
  };
  if (inside(abs, SURFACES_DIR)) refuse();
  if (!existsSync(abs)) throw new Error(`scenario root ${abs} does not exist`);
  // a symlink out of the cache into it is the same trap
  const cache = existsSync(SURFACES_DIR) ? realpathSync(SURFACES_DIR) : SURFACES_DIR;
  if (inside(realpathSync(abs), cache)) refuse();
  return abs;
}

export function parseFamily(v: string, what = "--family"): Family {
  if (v === "3x" || v === "next") return v;
  throw new Error(`${what} must be 3x or next, got ${JSON.stringify(v)}`);
}

/** `<dir|name>[:<3x|next>[:<scenario-root>]]` -> target, family, root (each undefined when absent). */
export function parseSurfaceSpec(spec: string): {
  target: string;
  family?: Family;
  scenarioRoot?: string;
} {
  const [target = "", family, root, ...extra] = spec.split(":");
  if (target === "" || extra.length > 0 || (root !== undefined && root === "")) {
    throw new Error(`bad --surface ${JSON.stringify(spec)}: want <dir|name>[:<3x|next>[:<root>]]`);
  }
  return {
    target,
    family:
      family === undefined || family === "" ? undefined : parseFamily(family, "surface family"),
    scenarioRoot: root === undefined ? undefined : checkScenarioRoot(root),
  };
}

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/** Export <ref> of <repo> into SURFACES_DIR/<name> and build it. Reuses a built dir at the same sha. */
export async function prepareSurface(name: string, ref: string, repo: string): Promise<Surface> {
  const dir = surfaceDir(name);
  const sha = run("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], repo).trim();
  const stamp = join(dir, ".ref");
  const same = existsSync(stamp) && readFileSync(stamp, "utf8").trim() === sha;
  if (!(same && existsSync(join(dir, "dist")))) {
    run("rm", ["-rf", dir], repo);
    mkdirSync(dir, { recursive: true });
    const archive = execFileSync("git", ["-C", repo, "archive", sha], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", dir], { input: archive });
    run("npm", ["ci"], dir);
    run("npm", ["run", "build"], dir);
    writeFileSync(stamp, `${sha}\n`);
  }
  return surfaceFromDir(name, dir);
}
