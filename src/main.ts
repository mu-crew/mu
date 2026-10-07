#!/usr/bin/env node
// The `mu` bin (dist/cli.js). A bootstrap so the V8 compile cache is on
// before the CLI graph loads: static ESM imports are hoisted and evaluated
// before any statement in the importing module, so the cache has to be
// enabled here and the CLI pulled in with a dynamic import.
//
// The cache lives under the mu state dir (<state>/compile-cache) and is
// best-effort (src/compile-cache.ts): old Node, an unwritable dir, or
// NODE_DISABLE_COMPILE_CACHE just run uncached.

import { join } from "node:path";
import { enableCompileCacheIn } from "./compile-cache.js";
import { defaultStateDir } from "./state-dir.js";

enableCompileCacheIn(join(defaultStateDir(), "compile-cache"));

const { runCli } = await import("./cli.js");
await runCli(process.argv);
