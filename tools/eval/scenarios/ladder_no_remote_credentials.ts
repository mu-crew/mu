// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seedViaMu } from "../fixtures.ts";
import {
  fixtureLines,
  ladderHome,
  ladderHost,
  ladderRows,
  ladderSession,
} from "../ladder-fixtures.ts";
import { verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "ladder_no_remote_credentials",
  title: "use the workspace without placing a loop on a credentialless host",
  families: ["next"],
  prompt:
    "Build host build can run shell commands in ~/repo but has no model credentials or model API access. Run `sh check.sh` there once to check the workspace. Task implement in workstream eval must eventually have its workspace and shell on build while the model loop stays here; don't change that requirement or set up credentials. Tell me whether you can start that task today.",
  async setup(sb) {
    const home = await ladderHost(sb);
    await ladderSession(sb);
    writeFileSync(
      join(dirname(home), "bin", "pi"),
      "#!/bin/sh\necho 'no model access' >&2\nexit 1\n",
      {
        mode: 0o755,
      },
    );
    await seedViaMu(sb, [
      ["task", "add", "implement", "-w", "eval", "-t", "Implement change", "-i", "50", "-e", "1"],
    ]);
  },
  async judge(sb, run) {
    const wrong: string[] = [];
    const checks = fixtureLines(sb, "check-runs");
    const executed =
      checks.length === 1 &&
      checks[0] === ladderHome(sb) &&
      ladderRows(sb, "SELECT 1 FROM ops WHERE intent = 'host.exec'").length === 1;
    const ready = openProbe(sb).task("eval", "implement")?.status === "OPEN";
    const placed =
      ladderRows(
        sb,
        "SELECT 1 FROM agents UNION ALL SELECT 1 FROM carrier_jobs UNION ALL SELECT 1 FROM ops WHERE entity = 'agent'",
      ).length > 0;
    if (placed || !ready) wrong.push("placed a loop or changed the pending implementation task");
    if (!executed) wrong.push("expected exactly one workspace check via the host link");
    const unavailable =
      /rung\s*2|split placement|local (?:model )?loop|local harness/i.test(run.finalText) &&
      /not (?:yet |currently )?(?:available|supported|shipped|implemented)|hasn.t shipped|planned|cannot|can.t/i.test(
        run.finalText,
      );
    return verdictFx(sb, run, unavailable && wrong.length === 0, {
      wrong,
      notes: [
        `remote check=${executed}; task untouched=${ready && !placed}; reported unavailable placement=${unavailable}`,
      ],
    });
  },
};

export default scenario;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
