// mu — `mu agent reattach <name>`: preview and apply (src/agents/reattach.ts). Kept out of
// src/cli/agents.ts, which is past its cap.

import type { Command } from "commander";
import { previewReattach, reattachAgent } from "../agents/reattach.js";
import * as cli from "../cli.js";
import { pc } from "../output.js";
import { CliExitError, setNextOutcome } from "./handle.js";
import { installWaitSignals } from "./wait.js";

export function wireReattachCommand(agent: Command): void {
  agent
    .command("reattach <name>")
    .description(
      "Open a new carrier pane for a reaped lease agent whose job still runs (pi only; the host needs an attach template): previews without --if; --if <rev> applies",
    )
    .option("--if <rev>", "apply the preview with this revision", cli.parseNonNegativeInt)
    .option(...cli.WORKSTREAM_OPT)
    .option(...cli.JSON_OPT)
    .action(function (raw: string) {
      const opts = (this as Command).optsWithGlobals() as { workstream?: string; json?: boolean };
      const rev = (opts as { if?: number }).if;
      const sig = installWaitSignals();
      const run = cli.handle(async (db) => {
        const name = cli.applyQualifiedRef(raw, opts);
        const ws = await cli.resolveWorkstream(opts.workstream);
        if (rev === undefined) {
          const p = await previewReattach(db, ws, name);
          const apply = ["mu", "agent", "reattach", name, "-w", ws];
          setNextOutcome({ kind: "preview", apply, revision: p.revision });
          if (opts.json) return cli.emitJson({ ...p, dryRun: true });
          const tree = p.cwd === null ? "" : `, tree ${p.cwd}`;
          return console.log(
            `Reattach ${pc.bold(name)}? job ${p.job} on ${p.host} gets a new carrier pane (was ${p.previous_pane_id}${tree}; rev ${p.revision})`,
          );
        }
        const r = await reattachAgent(db, ws, name, { ifRevision: rev, signal: sig.signal }).catch(
          (e: unknown) => {
            const which = sig.which();
            if (which === undefined) throw e;
            if (!opts.json) console.error(`${which} during reattach of ${name}: its row is kept`);
            throw new CliExitError(which === "SIGTERM" ? 143 : 130);
          },
        );
        if (opts.json) return cli.emitJson(r);
        console.log(`Reattached ${pc.bold(name)} (job ${r.job} on ${r.host}, pane ${r.pane_id})`);
        if (!r.ready) console.error(pc.yellow(`warning: ctl ${r.ctl}: the pane holds the job`));
      }, this as Command);
      return run().finally(() => sig.dispose());
    });
}
