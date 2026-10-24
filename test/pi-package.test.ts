// The pi package contract: package.json declares what pi loads, the
// extension no longer registers prompts itself, and `mu pi migrate`
// moves only a verified mu-owned legacy shim, inside a temp home.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MU_SHIM_MARKER, migratePi } from "../src/pi-migrate.js";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  pi?: Record<string, string[]>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files?: string[];
};

describe("package manifest", () => {
  it("declares exactly the extension, skills and prompts pi loads", () => {
    expect(pkg.pi).toEqual({
      extensions: ["./dist/extension/mu-pi.js"],
      skills: ["./skills"],
      prompts: ["./prompts/*.md"],
    });
  });

  it("ships every declared path", () => {
    for (const dir of ["dist", "skills", "prompts"]) expect(pkg.files).toContain(dir);
  });

  it("lists pi as an optional '*' peer and never bundles it", () => {
    const name = "@earendil-works/pi-coding-agent";
    expect(pkg.peerDependencies?.[name]).toBe("*");
    expect(pkg.peerDependenciesMeta?.[name]?.optional).toBe(true);
    expect(pkg.dependencies?.[name]).toBeUndefined();
  });

  it("registers no prompts from the extension (the manifest owns them)", () => {
    const src = readFileSync(join(root, "extension", "mu-pi.ts"), "utf8");
    expect(src).not.toContain("resources_discover");
    expect(src).not.toContain("promptsDir");
  });
});

describe("mu pi migrate", () => {
  let home: string;
  const ext = () => join(home, ".pi", "agent", "extensions", "mu.ts");
  const skill = () => join(home, ".agents", "skills", "mu");
  const shim = `${MU_SHIM_MARKER}\nconst { default: e } = await import("file:///x/mu-pi.js");\nexport default e;\n`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mu-migrate-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function putShim(): void {
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(ext(), shim);
  }
  function putSkillLink(name = "mu"): string {
    const target = join(home, "pkg", "skills", "mu");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), `---\nname: ${name}\n---\n`);
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    symlinkSync(target, skill(), "dir");
    return target;
  }

  it("reports and changes nothing without apply", () => {
    putShim();
    const r = migratePi({ home });
    expect(r.extension.state).toBe("shim");
    expect(r.extension.moved).toBe(false);
    expect(existsSync(ext())).toBe(true);
  });

  it("moves the verified shim out of discovery, to a name pi never loads", () => {
    putShim();
    const r = migratePi({ home, apply: true });
    expect(r.extension.moved).toBe(true);
    expect(existsSync(ext())).toBe(false);
    const to = r.extension.to ?? "";
    expect(to).toContain(join(home, ".pi", "agent"));
    expect(to.endsWith(".ts")).toBe(false);
    expect(readFileSync(to, "utf8")).toBe(shim);
    expect(r.guidance.join(" ")).toMatch(/restart|\/reload/);
  });

  it("moves a mu skill symlink and leaves its target alone", () => {
    const target = putSkillLink();
    const r = migratePi({ home, apply: true });
    expect(r.skill.moved).toBe(true);
    expect(existsSync(skill())).toBe(false);
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
  });

  it("never touches a copy, a real directory or a foreign symlink", () => {
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(ext(), "export default function () {}\n");
    putSkillLink("not-mu");
    const r = migratePi({ home, apply: true });
    expect(r.extension).toMatchObject({ state: "foreign", moved: false });
    expect(r.skill).toMatchObject({ state: "foreign", moved: false });
    expect(readFileSync(ext(), "utf8")).toContain("export default");
    expect(lstatSync(skill()).isSymbolicLink()).toBe(true);

    rmSync(skill());
    mkdirSync(skill(), { recursive: true });
    expect(migratePi({ home, apply: true }).skill).toMatchObject({
      state: "foreign",
      moved: false,
    });
    expect(existsSync(skill())).toBe(true);
  });

  it("is a no-op on an empty home", () => {
    const r = migratePi({ home, apply: true });
    expect(r.extension.state).toBe("absent");
    expect(r.skill.state).toBe("absent");
  });

  it("does not overwrite an earlier parked shim", () => {
    putShim();
    const first = migratePi({ home, apply: true }).extension.to;
    putShim();
    const second = migratePi({ home, apply: true }).extension.to;
    expect(second).not.toBe(first);
    expect(existsSync(first ?? "")).toBe(true);
  });
});
