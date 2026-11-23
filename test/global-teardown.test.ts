import { describe, expect, it } from "vitest";
import { leakedVitestTmpDir } from "./_global-teardown.js";

describe("leakedVitestTmpDir", () => {
  const root = (dir: unknown) => ({ vitest: { _tmpDir: dir } });
  it("returns vitest's root tmp dir when it is a direct child of tmpdir", () => {
    expect(leakedVitestTmpDir(root("/t/abc"), "/t")).toBe("/t/abc");
  });
  it("refuses anything else, so teardown can never rm outside the temp dir", () => {
    expect(leakedVitestTmpDir(root("/t/a/b"), "/t")).toBeNull();
    expect(leakedVitestTmpDir(root("/t"), "/t")).toBeNull();
    expect(leakedVitestTmpDir(root("rel"), "/t")).toBeNull();
    expect(leakedVitestTmpDir(root(undefined), "/t")).toBeNull();
    expect(leakedVitestTmpDir(undefined, "/t")).toBeNull();
  });
});
