// Best-effort V8 compile cache for the `mu` bin (see src/main.ts).
//
// Never hand enableCompileCache a directory that does not exist yet: it
// creates it with a recursive mkdir, and Node's recursive mkdir spins
// forever at 100% CPU on some paths (e.g. anything under /proc, where
// mkdir keeps returning ENOENT). Create the directory here with bounded,
// non-recursive mkdirs instead, check it is writable, and skip the cache
// on any failure. Builtins only: this runs before the CLI graph loads.

import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname } from "node:path";

type EnableCompileCache = (dir: string) => unknown;

const nodeEnable = (nodeModule as { enableCompileCache?: EnableCompileCache }).enableCompileCache;

/** Create `dir` (and missing parents) one level at a time, at most
 *  `maxDepth` levels. Returns false on any error instead of retrying. */
export function ensureDirBounded(dir: string, maxDepth = 32): boolean {
  const missing: string[] = [];
  let cur = dir;
  for (let i = 0; i < maxDepth; i++) {
    try {
      if (!statSync(cur).isDirectory()) return false;
      break;
    } catch {
      missing.push(cur);
      const parent = dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
  }
  try {
    for (const d of missing.reverse()) mkdirSync(d);
    accessSync(dir, constants.W_OK);
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Enable the compile cache in `dir`. Returns whether it was attempted;
 *  never throws. `enable` is null on Node versions without it. */
export function enableCompileCacheIn(
  dir: string,
  enable: EnableCompileCache | null = nodeEnable ?? null,
): boolean {
  if (enable === null) return false;
  if (!ensureDirBounded(dir)) return false;
  try {
    enable(dir);
    return true;
  } catch {
    return false;
  }
}
