// AGENTS.md: files cap at 1500 LOC (refactor at 800). Enforced here for test/.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("no test file exceeds 1500 lines", () => {
  const root = join(__dirname);
  const over = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.includes("fixtures"))
    .filter((f) => readFileSync(join(root, f), "utf8").split("\n").length > 1501);
  expect(over).toEqual([]);
});
