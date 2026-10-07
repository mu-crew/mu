// Lazy loader for the ink TUI, shared by bare `mu` and `mu state --tui`.
//
// React and react-reconciler choose their build when first required:
// the development build (extra validation, runWithFiberInDEV, more
// allocation per commit) unless NODE_ENV === "production". The CLI never
// sets NODE_ENV, so every TUI session ran the dev build. Default it to
// "production" only while the TUI graph evaluates, then restore it, so
// processes the TUI spawns (agents, editors) inherit the user's env
// unchanged. An explicit NODE_ENV (vitest sets "test") is respected.
//
// No ink/react imports here: this file sits outside src/cli/tui/ so the
// static CLI graph stays free of the TUI chunk.

type TuiModule = typeof import("./tui/index.js");

export async function importTui(
  load: () => Promise<TuiModule> = () => import("./tui/index.js"),
): Promise<TuiModule> {
  const key = "NODE_ENV";
  if (process.env[key] !== undefined) return load();
  process.env[key] = "production";
  try {
    return await load();
  } finally {
    delete process.env[key];
  }
}
