// Resolve local helpers before spawning: on macOS each failed PATH candidate
// otherwise costs a native spawn attempt. This is not a shell command resolver.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

type Missing = { code: "ENOENT" | "EACCES" };
const cache = new Map<string, string | Missing>();
let cachedPath: string | undefined;
let dirs: string[] = [];
let usesCwd = false;

/** Preserve explicit paths; pin bare names to the first executable regular file. */
export function helperPath(cmd: string, cwd?: string, env = process.env): string {
  if (cmd.includes("/")) return cmd;

  // Node's default search path on Unix if the child's environment lacks PATH.
  const path = env.PATH ?? "/usr/bin:/bin";
  if (path !== cachedPath) {
    cachedPath = path;
    dirs = path.split(delimiter);
    usesCwd = dirs.some((dir) => !isAbsolute(dir));
    cache.clear();
  }

  let base = "";
  if (usesCwd)
    base = cwd === undefined ? process.cwd() : isAbsolute(cwd) ? cwd : `${process.cwd()}/${cwd}`;
  const key = `${base}\0${cmd}`;
  let result = cache.get(key);
  if (result === undefined) {
    result = search(cmd, base);
    // Cache only a hit: a helper installed after a miss must be found.
    if (typeof result === "string") cache.set(key, result);
  }
  if (typeof result === "string") return result;
  throw Object.assign(new Error(`spawn ${cmd} ${result.code} (PATH lookup)`), {
    code: result.code,
    path: cmd,
    syscall: `spawn ${cmd}`,
  });
}

function search(cmd: string, cwd: string): string | Missing {
  let code: Missing["code"] = "ENOENT";
  for (const dir of dirs) {
    // Don't realpath or normalize away '..': PATH can traverse a symlink.
    const base = isAbsolute(dir) ? dir : dir === "" ? cwd : `${cwd}/${dir}`;
    const candidate = `${base.endsWith("/") ? base : `${base}/`}${cmd}`;
    try {
      if (!statSync(candidate).isFile()) {
        code = "EACCES";
        continue;
      }
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EACCES") code = "EACCES";
    }
  }
  return { code };
}
