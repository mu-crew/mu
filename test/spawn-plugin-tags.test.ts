// A plugin job's tmux view is tagged like a built-in spawn: @mu_agent, @mu_workstream, @mu_role.

import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import type { SpawnAgentPaneOptions } from "../src/mux/types.js";
import { pluginHostFixture } from "./_plugin-host.js";
import { FAKE_SERVER_IDENTITY } from "./_verbs-mock.js";

const h = pluginHostFixture({ handshakeInProcess: true });

it("passes the @mu_* pane options to the plugin view's spawnAgent", async () => {
  await h.setup({ handle: "file", start: { lookup: true, fenceKey: false }, view: "detached" });
  let seen: SpawnAgentPaneOptions | undefined;
  h.stubMux({
    spawnAgent: async (s) => {
      seen = s;
      h.panes.set("%1", { command: s.command });
      writeFileSync(leaseJobFile(h.db, "ws", "w1"), "file-job-1\n");
      s.onPaneCreated?.("%1", FAKE_SERVER_IDENTITY);
      return "%1";
    },
  });
  await h.spawn();
  expect(seen?.paneOptions).toEqual({
    "@mu_agent": "w1",
    "@mu_workstream": "ws",
    "@mu_role": "worker",
  });
}, 15_000);
