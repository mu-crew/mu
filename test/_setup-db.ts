// Per-fork: route fresh-file `openDb` calls through the template DB copy
// (see test/_db-template.ts). A no-op when globalSetup provided no template.

import { inject, vi } from "vitest";
import { DB_TEMPLATE_KEY, openDbFromTemplate } from "./_db-template.js";

vi.mock("../src/db.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db.js")>();
  const template = (inject as (key: string) => unknown)(DB_TEMPLATE_KEY);
  if (typeof template !== "string") return real;
  return {
    ...real,
    openDb: (options?: Parameters<typeof real.openDb>[0]) =>
      openDbFromTemplate(template, real.openDb, options),
  };
});
