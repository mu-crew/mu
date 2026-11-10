// mu — plugin registration (spec 2026-11-09-mu-plugins.md, D14): the `plugins`
// table, the trust rules, and the one session per plugin an invocation starts.
//
// User-configured, never discovered: `mu plugin add <name> -- <absolute path>
// [args…]` records the argv, runs the handshake once and stores the row. mu
// never scans PATH, a directory or a package. The executable's basename is
// `mu-plugin-<name>`; mu refuses a relative path, and a file (or a symlink's
// target) that is not a regular file the user owns, or that the group or the
// world may write. mu does not hash the binary: the handshake's `instance` is
// the fence.
//
// The row keeps what the handshake declared. Each invocation's first need
// starts the plugin and runs the handshake again, under the same load rules;
// a declaration that differs from the row is refused until `mu plugin add`
// records it again (same argv: a re-check that refreshes the row). The
// version, protocol and instance it reports are recorded as they change.

import { lstatSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { carrierJobsOfPlugin } from "../carrier-jobs.js";
import type { Db } from "../db.js";
import { effectsOfPlugin } from "../effects.js";
import { hostRecordsOfProvider } from "../host-records.js";
import { hostsOfPlugin } from "../hosts.js";
import { type PluginSession, startPlugin } from "./client.js";
import {
  PluginCallError,
  PluginExistsError,
  PluginInUseError,
  PluginNotFoundError,
  PluginRefusedError,
} from "./errors.js";
import { muTerminating, terminatingReason } from "./process.js";
import { declaredSeams, type PluginSeams, type SeamName } from "./protocol.js";

/** A `plugins` row. */
export interface PluginRow {
  name: string;
  /** JSON array: the argv, its first word the absolute path. */
  argv_json: string;
  protocol: number;
  version: string;
  instance: string;
  /** JSON array of the declared seam names. */
  seams_json: string;
  /** JSON: the handshake's seams object, each seam with its capabilities. */
  caps_json: string;
  schema_digest: string;
  added_at: string;
  checked_at: string;
}

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function isValidPluginName(name: string): boolean {
  return PLUGIN_NAME_RE.test(name);
}

export function getPlugin(db: Db, name: string): PluginRow {
  const row = db.prepare("SELECT * FROM plugins WHERE name = ?").get(name) as PluginRow | undefined;
  if (row === undefined) throw new PluginNotFoundError(name);
  return row;
}

export function listPlugins(db: Db): PluginRow[] {
  return db.prepare("SELECT * FROM plugins ORDER BY name").all() as PluginRow[];
}

/** The seams the row declares, with their capabilities. */
export function pluginSeams(row: PluginRow): PluginSeams {
  return JSON.parse(row.caps_json) as PluginSeams;
}

export function pluginArgv(row: PluginRow): string[] {
  return JSON.parse(row.argv_json) as string[];
}

/** Why mu will not run `path` as plugin `name`'s executable (D14 Trust); empty when it will. */
export function trustProblems(name: string, path: string): string[] {
  if (!isAbsolute(path)) return [`${JSON.stringify(path)} is not an absolute path`];
  const out: string[] = [];
  if (basename(path) !== `mu-plugin-${name}`) {
    out.push(`its executable must be named mu-plugin-${name}, not ${basename(path)}`);
  }
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path);
  } catch {
    return [...out, `${path} does not exist`];
  }
  const what = link.isSymbolicLink() ? `${path}'s target` : path;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return [...out, `${what} does not exist`];
  }
  if (!st.isFile()) out.push(`${what} is not a regular file`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) out.push(`${what} is not owned by you`);
  if ((st.mode & 0o022) !== 0) out.push(`${what} is group- or world-writable`);
  if ((st.mode & 0o100) === 0) out.push(`${what} is not executable by you`);
  return out;
}

/** Things that name the plugin, which `mu plugin rm` refuses over. */
function pluginUsers(db: Db, name: string): string[] {
  return [
    ...hostsOfPlugin(db, name).map((h) => `host ${h}`),
    ...hostRecordsOfProvider(db, name).map((h) => `provider host ${h}`),
    ...carrierJobsOfPlugin(db, name).map((j) => `job ${j.workstream}/${j.name}`),
    ...effectsOfPlugin(db, name).map((e) => `effect ${e.key}`),
  ];
}

export interface PluginAdded {
  plugin: PluginRow;
  /** The name was registered with this argv already: the row was re-checked. */
  refreshed: boolean;
}

/**
 * Register `argv` as plugin `name`: the trust rules, one handshake under the load rules, the
 * row. The same argv again re-checks and refreshes the row; another argv refuses.
 */
export async function addPlugin(
  db: Db,
  name: string,
  argv: readonly string[],
): Promise<PluginAdded> {
  if (!isValidPluginName(name)) {
    throw new PluginRefusedError(name, [
      "a plugin name is lowercase letters, digits and -, starting with a letter (max 32)",
    ]);
  }
  const path = argv[0];
  if (path === undefined)
    throw new PluginRefusedError(name, [
      "no executable given (mu plugin add <name> -- <path> [args…])",
    ]);
  const existing = db.prepare("SELECT argv_json FROM plugins WHERE name = ?").get(name) as
    | { argv_json: string }
    | undefined;
  const argvJson = JSON.stringify(argv);
  if (existing !== undefined && existing.argv_json !== argvJson) throw new PluginExistsError(name);
  const trust = trustProblems(name, path);
  if (trust.length > 0) throw new PluginRefusedError(name, trust);
  const s = await startPlugin(name, argv);
  await s.shutdown();
  const now = new Date().toISOString();
  const init = s.init;
  // A channel's identity is (plugin, name): a name another plugin's channel holds in this DB
  // refuses, in the insert's own transaction (plugins spec D9; P6e1 review round 2).
  const channel = init.seams.channel?.name;
  db.transaction(() => {
    const taken =
      channel === undefined
        ? undefined
        : listPlugins(db).find((p) => p.name !== name && pluginSeams(p).channel?.name === channel);
    if (taken !== undefined) {
      throw new PluginRefusedError(name, [
        `its channel ${channel} is already plugin ${taken.name}'s in this DB: a channel name is one plugin's`,
      ]);
    }
    db.prepare(
      `INSERT INTO plugins (name, argv_json, protocol, version, instance, seams_json, caps_json, schema_digest, added_at, checked_at)
     VALUES (@name, @argv_json, @protocol, @version, @instance, @seams_json, @caps_json, @schema_digest, @now, @now)
     ON CONFLICT (name) DO UPDATE SET protocol = excluded.protocol, version = excluded.version,
       instance = excluded.instance, seams_json = excluded.seams_json, caps_json = excluded.caps_json,
       schema_digest = excluded.schema_digest, checked_at = excluded.checked_at
     WHERE argv_json = excluded.argv_json`,
    ).run({
      name,
      argv_json: argvJson,
      protocol: init.protocol,
      version: init.plugin.version,
      instance: init.instance,
      seams_json: JSON.stringify(declaredSeams(init.seams)),
      caps_json: JSON.stringify(init.seams),
      schema_digest: init.schema,
      now,
    });
  }).immediate();
  const plugin = getPlugin(db, name);
  if (plugin.argv_json !== argvJson) throw new PluginExistsError(name); // raced another add
  return { plugin, refreshed: existing !== undefined };
}

/** Remove the registration; false when there was none. Refuses while anything names it. */
export function removePlugin(db: Db, name: string): boolean {
  return db
    .transaction(() => {
      const users = pluginUsers(db, name);
      if (users.length > 0) throw new PluginInUseError(name, users);
      return db.prepare("DELETE FROM plugins WHERE name = ?").run(name).changes > 0;
    })
    .immediate();
}

// ─── Sessions: one per plugin per invocation ───────────────────────────

const sessions = new Map<string, Promise<PluginSession>>();
/** The sessions that started, by the same key: to tell one that has since ended. */
const started = new Map<string, PluginSession>();

/**
 * The plugin's session for this invocation, started on first need. `needs`: the seams the
 * caller requires, refused at load when the plugin lacks one. A session whose plugin was
 * stopped without breaking the protocol (a cancelled call kills its group) is started again
 * on the next need; one that broke the protocol stays refused for the invocation.
 */
export function pluginSession(
  db: Db,
  name: string,
  needs: readonly SeamName[] = [],
): Promise<PluginSession> {
  const key = `${db.name}\0${name}`;
  // Terminating (the latch): no new session, no restart, no new request.
  const latched = muTerminating();
  if (latched !== undefined) {
    return Promise.reject(
      new PluginCallError(name, "start", "permanent", terminatingReason(latched)),
    );
  }
  const ended = started.get(key)?.process;
  if (ended !== undefined && ended.broken !== undefined && !ended.poisoned) {
    sessions.delete(key);
    started.delete(key);
  }
  let s = sessions.get(key);
  if (s === undefined) {
    s = openSession(db, name).then((session) => {
      started.set(key, session);
      return session;
    });
    sessions.set(key, s);
  }
  return s.then((session) => {
    const missing = needs.filter((n) => session.init.seams[n] === undefined);
    if (missing.length > 0) {
      throw new PluginRefusedError(
        name,
        missing.map((n) => `it implements no ${n} seam, which this needs`),
      );
    }
    return session;
  });
}

async function openSession(db: Db, name: string): Promise<PluginSession> {
  const row = getPlugin(db, name);
  const argv = pluginArgv(row);
  // The trust rules hold at every use, not only at `add`: the file may have changed since.
  const trust = trustProblems(name, argv[0] ?? "");
  if (trust.length > 0) throw new PluginRefusedError(name, trust);
  const s = await startPlugin(name, argv);
  const declared = JSON.stringify(s.init.seams);
  if (declared !== row.caps_json) {
    await s.shutdown();
    throw new PluginRefusedError(name, [
      `it declares other seams or capabilities than when it was added: run mu plugin add ${name} -- ${pluginArgv(row).join(" ")} again to record them`,
    ]);
  }
  const { protocol, instance } = s.init;
  const version = s.init.plugin.version;
  if (protocol !== row.protocol || version !== row.version || instance !== row.instance) {
    db.prepare(
      "UPDATE plugins SET protocol = ?, version = ?, instance = ?, checked_at = ? WHERE name = ? AND argv_json = ?",
    ).run(protocol, version, instance, new Date().toISOString(), name, row.argv_json);
  }
  return s;
}

/** Shut every session down (`shutdown`, the grace, the group killed). handle() calls it at exit. */
export async function closePluginSessions(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  started.clear();
  await Promise.all(
    open.map(async (p) => {
      try {
        await (await p).shutdown();
      } catch {}
    }),
  );
}
