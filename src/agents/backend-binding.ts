// mu — advisory spawn refusal for a second managed backend (spec A §8.2).
//
// A workstream lives on one backend (tmux, herdr or Rex). A spawn refuses
// while a registered pane names another one, without probing it for liveness.
// Advisory: two first spawns can race.
// A Rex terminal driving tmux workers is fine: only rows count, not the terminal.

import { listAgents } from "../agents.js";
import type { Db } from "../db.js";
import { foreignBackend } from "../mux/binding.js";
import { activeMux } from "../mux/detect.js";
import { MuxBackendMismatchError } from "./errors.js";

export async function assertBackendBinding(db: Db, workstream: string): Promise<void> {
  const active = (await activeMux()).name;
  for (const row of listAgents(db, { workstream })) {
    const other = foreignBackend(row.paneId, active);
    if (other !== undefined) throw new MuxBackendMismatchError(workstream, active, other, row.name);
  }
}
