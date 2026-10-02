// Tests for src/link.ts — `mu link pi` install logic.
//
// Every test writes ONLY into a fresh temp `home`; the real ~/.pi and
// ~/.agents are never touched. MU_EXTENSION_ENTRY points at a fixture so
// the tests do not need a prior `npm run build`.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectLinks, LinkConflictError, linkPi, linkSkill, MU_SHIM_MARKER } from "../src/link.js";

const repoSkill = resolve(fileURLToPath(import.meta.url), "..", "..", "skills", "mu");

describe("mu link pi", () => {
  let home: string;
  let entry: string;
  const ENTRY_KEY = "MU_EXTENSION_ENTRY";
  const HOME_KEY = "MU_PI_HOME";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mu-link-test-"));
    entry = join(home, "fixture", "mu-pi.js");
    mkdirSync(join(home, "fixture"));
    writeFileSync(entry, "export default function () {}\n");
    process.env[ENTRY_KEY] = entry;
    // Belt and braces: even a call that forgets `home` lands in the temp dir.
    process.env[HOME_KEY] = home;
  });

  afterEach(() => {
    delete process.env[ENTRY_KEY];
    delete process.env[HOME_KEY];
    rmSync(home, { recursive: true, force: true });
  });

  it("linkPi writes a shim with the marker importing the built extension", () => {
    const r = linkPi({ home });
    expect(r.path).toBe(join(home, ".pi", "agent", "extensions", "mu.ts"));
    expect(r.replacedCopy).toBe(false);
    const content = readFileSync(r.path, "utf8");
    expect(content).toContain(MU_SHIM_MARKER);
    expect(content).toContain(JSON.stringify(`file://${entry}`));
  });

  it("linkPi over a file without the marker reports replacedCopy", () => {
    const path = join(home, ".pi", "agent", "extensions", "mu.ts");
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(path, "// old inlined copy\n");
    expect(linkPi({ home }).replacedCopy).toBe(true);
    expect(linkPi({ home }).replacedCopy).toBe(false);
  });

  it("linkPi --copy inlines the built file", () => {
    const r = linkPi({ home, copy: true });
    expect(readFileSync(r.path, "utf8")).toBe(readFileSync(entry, "utf8"));
    expect(inspectLinks({ home }).extension.state).toBe("stale-copy");
  });

  it("linkSkill symlinks to the package's skills/mu", () => {
    const r = linkSkill({ home });
    expect(lstatSync(r.path).isSymbolicLink()).toBe(true);
    expect(realpathSync(r.path)).toBe(realpathSync(repoSkill));
    expect(existsSync(join(r.path, "SKILL.md"))).toBe(true);
    // Idempotent.
    expect(linkSkill({ home }).previous).toBeUndefined();
  });

  it("linkSkill over a real directory throws LinkConflictError and leaves it untouched", () => {
    const dir = join(home, ".agents", "skills", "mu");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mine.txt"), "user data");
    expect(() => linkSkill({ home })).toThrow(LinkConflictError);
    expect(readFileSync(join(dir, "mine.txt"), "utf8")).toBe("user data");
    expect(inspectLinks({ home }).skill.state).toBe("foreign");
  });

  it("linkSkill over a live foreign symlink needs force and reports previous", () => {
    const other = join(home, "other-checkout");
    mkdirSync(other);
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    const path = join(home, ".agents", "skills", "mu");
    symlinkSync(other, path, "dir");
    expect(() => linkSkill({ home })).toThrow(LinkConflictError);
    expect(readlinkSync(path)).toBe(other);
    const r = linkSkill({ home, force: true });
    expect(r.previous).toBe(other);
    expect(existsSync(other)).toBe(true);
  });

  it("inspectLinks: missing/missing on an empty home, ok/ok after both", () => {
    const before = inspectLinks({ home });
    expect(before.extension.state).toBe("missing");
    expect(before.skill.state).toBe("missing");
    linkPi({ home });
    linkSkill({ home });
    const after = inspectLinks({ home });
    expect(after.extension).toMatchObject({ state: "ok", target: entry });
    expect(after.skill.state).toBe("ok");
  });

  it("inspectLinks reports dangling when the shim's import target is gone", () => {
    linkPi({ home });
    rmSync(entry);
    expect(inspectLinks({ home }).extension.state).toBe("dangling");
  });

  it("defaults to MU_PI_HOME when no home is passed", () => {
    expect(linkPi().path.startsWith(home)).toBe(true);
  });
});
