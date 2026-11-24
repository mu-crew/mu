import { readFileSync } from "node:fs";
import { join } from "node:path";

/** skills/mu/SKILL.md, read once per file that pins its markers. */
export const SKILL = readFileSync(
  join(import.meta.dirname, "..", "skills", "mu", "SKILL.md"),
  "utf8",
);
