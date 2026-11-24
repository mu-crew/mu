// Only the full Vitest config loads this. The fast gate needs no Git binary.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { pinRealGit } from "./_real-git.js";
import { RUN_ROOT_KEY } from "./_run-root.js";

export function setup(project: TestProject): () => void {
  const root = project.getProvidedContext()[RUN_ROOT_KEY];
  const keys = ["PATH", "GIT_EXEC_PATH", "GIT_CONFIG_NOSYSTEM", "GIT_TEMPLATE_DIR"];
  const inherited = keys.map((key) => [key, process.env[key]] as const);
  pinRealGit(root);
  // Fixtures don't need the machine's system config or sample hooks.
  const template = join(root, "git-template");
  mkdirSync(join(template, "info"), { recursive: true });
  mkdirSync(join(template, "hooks"));
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TEMPLATE_DIR = template;
  return () => {
    for (const [key, value] of inherited) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
