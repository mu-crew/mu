// mu — `mu plugin add | list | rm`: the user's plugin registrations
// (spec 2026-11-09-mu-plugins.md, D14). Configured, never discovered: mu runs
// only the absolute path given to `add`, once for its handshake, and later for
// the seams a host names it for.

import type { Command } from "commander";
import { emitJson, emitJsonCollection, handle, JSON_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { isJsonMode, muTable, pc } from "../output.js";
import {
  addPlugin,
  listPlugins,
  type PluginRow,
  pluginArgv,
  pluginSeams,
  removePlugin,
} from "../plugins/registry.js";

/** A row as `--json` prints it: the JSON columns parsed. */
function pluginJson(p: PluginRow): Record<string, unknown> {
  return {
    name: p.name,
    argv: pluginArgv(p),
    protocol: p.protocol,
    version: p.version,
    instance: p.instance,
    seams: pluginSeams(p),
    schemaDigest: p.schema_digest,
    addedAt: p.added_at,
    checkedAt: p.checked_at,
  };
}

export async function cmdPluginAdd(db: Db, name: string, argv: string[]): Promise<void> {
  const { plugin, refreshed } = await addPlugin(db, name, argv);
  if (isJsonMode()) {
    emitJson({ plugin: pluginJson(plugin), refreshed });
    return;
  }
  const seams = (JSON.parse(plugin.seams_json) as string[]).join(", ");
  console.log(
    `${refreshed ? "re-checked" : "added"} plugin ${pc.bold(plugin.name)} ${plugin.version} (protocol ${plugin.protocol}, instance ${plugin.instance}): ${seams}`,
  );
}

export function cmdPluginList(db: Db): void {
  const plugins = listPlugins(db);
  if (isJsonMode()) {
    emitJsonCollection(plugins.map(pluginJson));
    return;
  }
  if (plugins.length === 0) {
    console.log("no plugins (mu plugin add <name> -- /abs/path/mu-plugin-<name>)");
    return;
  }
  const t = muTable({ head: ["PLUGIN", "VERSION", "PROTOCOL", "INSTANCE", "SEAMS", "ARGV"] });
  for (const p of plugins) {
    t.push([
      p.name,
      p.version,
      String(p.protocol),
      p.instance,
      (JSON.parse(p.seams_json) as string[]).join(","),
      pluginArgv(p).join(" "),
    ]);
  }
  console.log(t.toString());
}

export function cmdPluginRm(db: Db, name: string): void {
  const removed = removePlugin(db, name);
  if (isJsonMode()) {
    emitJson({ plugin: name, removed });
    return;
  }
  console.log(removed ? `removed plugin ${name}` : `no plugin named ${name}`);
}

export function wirePluginCommands(program: Command): void {
  const plugin = program
    .command("plugin")
    .description(
      "Plugins: executables you register by absolute path that supply a host link, provider hosts, jobs or channels over a versioned stdio protocol. Never discovered (docs/guide/plugins.md)",
    );
  plugin
    .command("add <name> <argv...>")
    .description(
      "Register `-- <absolute path> [args…]` as plugin <name>: the file must be named mu-plugin-<name>, owned by you and writable by no one else. Runs its handshake once and records what it declares; the same argv again re-checks it.",
    )
    .option(...JSON_OPT)
    .action(function (name: string, argv: string[]) {
      return handle((db) => cmdPluginAdd(db, name, argv), this as Command)();
    });
  plugin
    .command("list")
    .description("List registered plugins: version, protocol, instance, declared seams, argv")
    .option(...JSON_OPT)
    .action(function () {
      return handle(async (db) => cmdPluginList(db), this as Command)();
    });
  plugin
    .command("rm <name>")
    .description(
      "Remove a registration. Refuses while a host, provider host, job record or unresolved effect names it",
    )
    .option(...JSON_OPT)
    .action(function (name: string) {
      return handle(async (db) => cmdPluginRm(db, name), this as Command)();
    });
}
