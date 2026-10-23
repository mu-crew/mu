// A surface is a directory holding a built mu (dist/ + skills/mu). mu is only ever a subprocess.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Surface } from "./types.ts";

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

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/** Export <ref> of <repo> into SURFACES_DIR/<name> and build it. Reuses a built dir at the same sha. */
export async function prepareSurface(name: string, ref: string, repo: string): Promise<Surface> {
  const sha = run("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], repo).trim();
  const dir = join(SURFACES_DIR, name);
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
