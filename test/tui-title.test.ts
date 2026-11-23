// The dashboard title: `mu [<ws>]` / `mu`, sanitized, live on workstream switch.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/cli/tui/app.js";
import { createRuntime, type DashboardRuntime } from "../src/cli/tui/runtime.js";
import { formatTitle, setTitle } from "../src/cli/tui/title.js";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { renderApp } from "./_ink-render.js";

describe("formatTitle", () => {
  it("names a selected workstream, plain mu otherwise", () => {
    expect(formatTitle("beta")).toBe("mu [beta]");
    expect(formatTitle(null)).toBe("mu");
    expect(formatTitle(undefined)).toBe("mu");
    expect(formatTitle("")).toBe("mu");
  });

  it("strips escapes and control characters, and caps the length", () => {
    const t = formatTitle("a\u001b]2;evil\u0007b\u001b[31mc\nd\u0000");
    expect(t).toBe("mu [abc d]");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
    expect(t).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(formatTitle("\u001b[31m\u0007")).toBe("mu");
    expect(formatTitle("x".repeat(500)).length).toBe("mu []".length + 40);
  });
});

describe("setTitle", () => {
  const saved = process.title;
  afterEach(() => {
    process.title = saved;
  });
  it("sets process.title and writes OSC 2", () => {
    const out: string[] = [];
    setTitle("beta", (s) => out.push(s));
    expect(process.title).toBe("mu [beta]");
    expect(out).toEqual(["\u001b]2;mu [beta]\u0007"]);
  });
});

describe("App title updates", () => {
  let tmp: string;
  let db: Db;
  let rt: DashboardRuntime;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-tui-title-"));
    db = openDb({ path: join(tmp, "a.db") });
    ensureWorkstream(db, "alpha");
    ensureWorkstream(db, "beta");
  });
  afterEach(() => {
    rt?.close();
    db.close();
    rmFixtureDir(tmp);
  });

  it("reports the initial workstream and every switch", async () => {
    rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
    const seen: (string | null)[] = [];
    const ui = await renderApp(
      createElement(App, {
        runtime: rt,
        pollMs: null,
        initialWorkstream: "beta",
        now: () => 0,
        onWorkstream: (w) => seen.push(w),
      }),
      { columns: 100, rows: 30 },
    );
    await ui.until((s) => s.includes("[beta]"));
    expect(seen.at(-1)).toBe("beta");
    await ui.press("[");
    await ui.until((s) => s.includes("[alpha]"));
    expect(seen.at(-1)).toBe("alpha");
    await ui.press("]");
    await ui.until((s) => s.includes("[beta]"));
    expect(seen.at(-1)).toBe("beta");
    expect(seen.filter((w) => w === null).length).toBeLessThanOrEqual(1);
    ui.unmount();
  });
});
