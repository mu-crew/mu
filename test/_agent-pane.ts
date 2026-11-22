import { insertAgent } from "../src/agents.js";
import { PANE_ID_RE } from "../src/mux/pane-ref.js";
import { FAKE_SERVER_IDENTITY } from "./_verbs-mock.js";

/** Model a row born on the fake mux, rather than a legacy ID-only tmux row. */
export const insertTestAgent: typeof insertAgent = (db, row) =>
  insertAgent(
    db,
    PANE_ID_RE.test(row.paneId) ? { paneIdentity: FAKE_SERVER_IDENTITY, ...row } : row,
  );
