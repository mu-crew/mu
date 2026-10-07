// importTui defaults NODE_ENV to "production" while the TUI graph loads
// so React and react-reconciler pick their production builds
// (f_tui_react_dev_build), and leaves an explicit NODE_ENV alone.

import { describe, expect, it } from "vitest";
import { importTui } from "../src/cli/tui-load.js";
import { withEnv } from "./_env.js";

type TuiModule = Awaited<ReturnType<typeof importTui>>;
const fake = {} as TuiModule;

describe("importTui", () => {
  it("loads the TUI with NODE_ENV=production when unset, then unsets it", async () => {
    await withEnv("NODE_ENV", undefined, async () => {
      let seen: string | undefined;
      const mod = await importTui(async () => {
        seen = process.env.NODE_ENV;
        return fake;
      });
      expect(mod).toBe(fake);
      expect(seen).toBe("production");
      expect(process.env.NODE_ENV).toBeUndefined();
    });
  });

  it("unsets NODE_ENV even when the load throws", async () => {
    await withEnv("NODE_ENV", undefined, async () => {
      await expect(
        importTui(async () => {
          throw new Error("no tty");
        }),
      ).rejects.toThrow("no tty");
      expect(process.env.NODE_ENV).toBeUndefined();
    });
  });

  it("respects an explicit NODE_ENV", async () => {
    await withEnv("NODE_ENV", "development", async () => {
      let seen: string | undefined;
      await importTui(async () => {
        seen = process.env.NODE_ENV;
        return fake;
      });
      expect(seen).toBe("development");
      expect(process.env.NODE_ENV).toBe("development");
    });
  });
});
