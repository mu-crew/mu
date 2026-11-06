// mu — `mu init`: write mu's hook entries and skill where each harness reads
// them (spec D13, D17). Touches no DB, so it does not run through handle().
// src/mu-init.ts decides what is written.

import { basename, dirname } from "node:path";
import type { Command } from "commander";
import { emitJson, JSON_OPT } from "../cli.js";
import { HARNESSES, type Harness, isHarness } from "../harnesses.js";
import { type InitItem, initRefused, runInit } from "../mu-init.js";
import { pc } from "../output.js";
import { CliExitError, emitParseError, UsageError } from "./handle.js";

/** `--harness`'s value: names, comma-separated, or `all`. A typo is a usage error, never "done". */
export function parseHarnessList(value: string): Harness[] {
  const names = value
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (names.length === 0 || !names.every((n) => n === "all" || isHarness(n))) {
    throw new UsageError(
      `--harness takes ${HARNESSES.join(", ")} or all, comma-separated; got ${JSON.stringify(value)}`,
      { showHelp: false },
    );
  }
  return names.includes("all") ? [...HARNESSES] : names.filter(isHarness);
}

function line(kind: string, i: InitItem): string {
  const where = i.path === null ? "" : ` ${pc.bold(i.path)}`;
  const text = `${kind} ${i.harness}:${where} ${i.state}: ${i.detail}`;
  return i.state === "written" || i.state === "refused" ? text : pc.dim(text);
}

/** The prompt skills, one line per harness, state and detail
 *  (`prompts claude: <dir> written 9 (installed): mu-debug, …`), in the order the
 *  items come; a refused one alone, with its reason. */
function promptLines(items: readonly InitItem[]): { line: string; refused: boolean }[] {
  const groups = new Map<string, InitItem[]>();
  const order: (InitItem | InitItem[])[] = [];
  for (const i of items) {
    if (i.state === "refused" || i.state === "skipped" || i.path === null) {
      order.push(i);
      continue;
    }
    const key = `${i.harness}\0${i.state}\0${i.detail}`;
    const group = groups.get(key);
    if (group !== undefined) group.push(i);
    else {
      const fresh = [i];
      groups.set(key, fresh);
      order.push(fresh);
    }
  }
  return order.flatMap((entry) => {
    if (!Array.isArray(entry)) {
      return [{ line: line("prompts", entry), refused: entry.state === "refused" }];
    }
    const [first] = entry;
    if (first === undefined) return [];
    const names = entry.map((i) => basename(i.path ?? "")).join(", ");
    const where = pc.bold(dirname(first.path ?? ""));
    const text = `prompts ${first.harness}: ${where} ${first.state} ${entry.length} (${first.detail}): ${names}`;
    return [{ line: first.state === "written" ? text : pc.dim(text), refused: false }];
  });
}

export function wireInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Write mu's Stop hook entry and skill for claude, codex and cursor-agent, and prompt skills for claude and cursor-agent, where each harness set up here reads them. Touches only what it wrote. Rerun after upgrading mu",
    )
    .option(
      "--harness <names>",
      `write for these even when not set up here (${HARNESSES.join(", ")}, all; comma-separated)`,
    )
    .option(...JSON_OPT)
    .action(function () {
      const cmd = this as Command;
      try {
        const opts = cmd.opts() as { harness?: string; json?: boolean };
        const harnesses = opts.harness === undefined ? undefined : parseHarnessList(opts.harness);
        const r = runInit(harnesses === undefined ? {} : { harnesses });
        const refused = initRefused(r);
        if (opts.json === true) {
          if (refused) {
            throw new CliExitError(1, {
              error: "InitRefusedError",
              message: "mu init left some files untouched (see data)",
              data: r,
            });
          }
          emitJson(r);
          return;
        }
        for (const i of r.hooks) {
          const text = line("hook", i);
          if (i.state === "refused") process.stderr.write(`${text}\n`);
          else console.log(text);
        }
        for (const i of r.skills) {
          const text = line("skill", i);
          if (i.state === "refused") process.stderr.write(`${text}\n`);
          else console.log(text);
        }
        for (const text of promptLines(r.prompts)) {
          if (text.refused) process.stderr.write(`${text.line}\n`);
          else console.log(text.line);
        }
        // codex runs a new or changed hook only once the user trusts it.
        if (r.hooks.some((i) => i.harness === "codex" && i.state === "written")) {
          console.log(pc.dim("codex asks you to trust the changed hook once (/hooks)"));
        }
        if (refused) throw new CliExitError(1);
      } catch (err) {
        process.exit(emitParseError(err, cmd));
      }
    });
}
