// mu — `mu pi migrate`: retire the pre-package `mu link pi` installs.
//
// Touches no DB, so it does not run through handle() (which opens the DB
// and runs ambient sync). Report-only unless --apply; see src/pi-migrate.ts.

import type { Command } from "commander";
import { emitJson, JSON_OPT } from "../cli.js";
import { pc } from "../output.js";
import { type MigrateEntry, migratePi } from "../pi-migrate.js";
import { emitParseError, refuseDbInsideSyncDir } from "./handle.js";

function line(label: string, e: MigrateEntry): string {
  if (e.moved) return `${label}: moved ${pc.bold(e.path)} -> ${e.to ?? "?"}`;
  const what = {
    absent: "not present",
    shim: "mu-owned (not moved)",
    foreign: "not mu's: left alone",
  }[e.state];
  return `${label}: ${pc.bold(e.path)} ${pc.dim(what)}`;
}

export function wirePiCommand(program: Command): void {
  const pi = program.command("pi").description("pi package helpers");
  pi.command("migrate")
    .description(
      "Move the old `mu link pi` extension shim and skill symlink out of pi's discovery path (mu-owned files only; nothing is deleted). Without --apply, report only. Install the package with: pi install npm:@mu-crew/mu",
    )
    .option(...JSON_OPT)
    .option("--apply", "move the mu-owned files aside (default: report only)")
    .action(function () {
      const cmd = this as Command;
      try {
        refuseDbInsideSyncDir();
        const opts = cmd.opts() as { json?: boolean; apply?: boolean };
        const r = migratePi({ apply: opts.apply === true });
        if (opts.json === true) {
          emitJson(r);
          return;
        }
        console.log(line("extension", r.extension));
        console.log(line("skill", r.skill));
        for (const g of r.guidance) console.log(pc.dim(g));
      } catch (err) {
        process.exit(emitParseError(err, cmd));
      }
    });
}
