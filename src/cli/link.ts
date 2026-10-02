// mu — `mu link pi`: thin wrapper over src/link.ts.
//
// Touches no DB: linking is a filesystem install, so it runs outside
// handle() (which opens the DB and runs ambient sync) and routes errors
// through the same emitError pipeline via emitParseError.

import type { Command } from "commander";
import { emitJson, JSON_OPT, UsageError } from "../cli.js";
import { linkPi, linkSkill } from "../link.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import { emitParseError } from "./handle.js";

export interface LinkCmdOptions {
  json?: boolean;
  copy?: boolean;
  force?: boolean;
  extensionOnly?: boolean;
  skillOnly?: boolean;
}

export function cmdLink(target: string, opts: LinkCmdOptions): void {
  if (target !== "pi") throw new UsageError(`unsupported link target: ${target} (expected: pi)`);
  if (opts.extensionOnly === true && opts.skillOnly === true) {
    throw new UsageError("--extension-only and --skill-only are mutually exclusive");
  }
  const extension = opts.skillOnly === true ? undefined : linkPi({ copy: opts.copy === true });
  const skill = opts.extensionOnly === true ? undefined : linkSkill({ force: opts.force === true });

  const steps: NextStep[] = [{ intent: "Check the install", command: "mu doctor" }];

  if (opts.json === true) {
    emitJson({
      ...(extension ? { extension: { ...extension, copy: opts.copy === true } } : {}),
      ...(skill ? { skill } : {}),
      nextSteps: steps,
    });
    return;
  }

  if (extension) {
    console.log(`extension: ${pc.bold(extension.path)}${opts.copy === true ? " (copy)" : ""}`);
    if (extension.replacedCopy) {
      console.log(
        pc.yellow(
          "  Replaced an inlined copy. Running agents keep the old code until they restart.",
        ),
      );
    }
    if (opts.copy === true) {
      console.log(pc.dim("  Pinned to this mu version: re-run `mu link pi` after upgrading."));
    }
  }
  if (skill) {
    console.log(`skill: ${pc.bold(skill.path)} -> ${skill.target}`);
    if (skill.previous !== undefined) console.log(pc.dim(`  previously -> ${skill.previous}`));
  }
  console.log(pc.dim("Restart pi agents (or /reload) to load the extension."));
  printNextSteps(steps);
}

export function wireLinkCommand(program: Command): void {
  program
    .command("link <target>")
    .description("Install the mu pi extension (shim) and the mu skill; <target> must be 'pi'")
    .option(...JSON_OPT)
    .option("--copy", "inline the extension instead of a shim (pinned; relink after upgrades)")
    .option("--force", "replace an existing skill symlink that points elsewhere")
    .option("--extension-only", "install only the pi extension")
    .option("--skill-only", "install only the mu skill symlink")
    .action(function (target: string) {
      const cmd = this as Command;
      try {
        cmdLink(target, cmd.opts() as LinkCmdOptions);
      } catch (err) {
        process.exit(emitParseError(err, cmd));
      }
    });
}
