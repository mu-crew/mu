// mu — `mu host add | list | show | rm | init | check`: host profiles.
//
// mu stays ssh-free. These verbs store and print the user's own templates
// (src/hosts.ts); `init --ssh` PRINTS a starter and runs nothing, and
// `check` runs only the stored `exec` template.

import type { Command } from "commander";
import {
  emitJson,
  emitJsonCollection,
  handle,
  JSON_OPT,
  parseNonNegativeInt,
  resolveWorkstream,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { advertised, hostCapabilities } from "../host-harnesses.js";
import {
  abandonHost,
  acquireHost,
  drainHost,
  observeHost,
  releaseHost,
} from "../host-lifecycle.js";
import { deadlineNotice } from "../host-policy.js";
import type { HostRecord } from "../host-provider.js";
import { hostReferences, listHostRecords } from "../host-records.js";
import {
  addHost,
  checkHost,
  getHost,
  type HostChannel,
  HostCheckFailedError,
  type HostProfile,
  type HostTransport,
  hostMuleStarter,
  hostStarter,
  isValidHostName,
  listHostChannels,
  listHosts,
  removeHost,
} from "../hosts.js";
import { isJsonMode, muTable, pc } from "../output.js";
import { shellQuote } from "../shell-quote.js";
import { failureWithData } from "./handle.js";

/**
 * A profile as `--json` prints it: the recorded harness probe parsed (null: never probed).
 * `plugin` only on a `--plugin` profile, so a template profile prints as it always did.
 */
function hostJson(h: HostProfile): Omit<HostProfile, "capabilities"> & { capabilities: unknown } {
  const { plugin, ...rest } = h;
  return {
    ...rest,
    ...(plugin != null ? { plugin } : {}),
    capabilities: hostCapabilities(h) ?? null,
  };
}

/** The harnesses the last `host check` found, or `-` when it never ran. */
function harnessesCell(h: HostProfile): string {
  const caps = hostCapabilities(h);
  if (caps === undefined) return "-";
  const found = advertised(caps);
  return found.length === 0 ? "none" : found.join(",");
}

function channelLine(c: HostChannel): string {
  const on = c.kind === "attached" ? `pane ${c.pane_id}` : `pid ${c.pid}`;
  return `${c.holder} (${c.kind}, ${on})`;
}

export function cmdHostAdd(db: Db, name: string, opts: HostAddOptions): void {
  const host = addHost(db, {
    name,
    ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
    ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
    ...(opts.plugin !== undefined ? { plugin: opts.plugin } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    repo: opts.repo ?? null,
    max_sessions: opts.maxSessions ?? null,
    transport: (opts.transport ?? "session") as HostTransport,
    stop: opts.stop ?? null,
    attach: opts.attach ?? null,
  });
  if (isJsonMode()) {
    emitJson({ host: hostJson(host) });
    return;
  }
  console.log(`added host ${pc.bold(host.name)}`);
}

/** A provider host as `--json` prints it: the record, its params parsed. */
function recordJson(r: HostRecord): Record<string, unknown> {
  const { params_json, creator_pid: _p, creator_start: _s, ...rest } = r;
  return { ...rest, params: JSON.parse(params_json) as unknown };
}

/** The provider hosts, each asked its status once (a `gone` one is `lost`, D1). */
async function providerHosts(db: Db): Promise<HostRecord[]> {
  for (const r of listHostRecords(db)) await observeHost(db, r.name);
  return listHostRecords(db);
}

function printRecords(db: Db, records: readonly HostRecord[]): void {
  const t = muTable({ head: ["HOST", "PROVIDER", "STATE", "HANDLE", "DEADLINE", "JOBS"] });
  for (const r of records) {
    const d = deadlineNotice(r);
    const jobs = hostReferences(db, r).jobs.length;
    t.push([
      r.name,
      r.provider,
      r.reason === null || r.state !== "lost" ? r.state : `lost: ${r.reason}`,
      r.handle ?? "-",
      d === undefined
        ? "-"
        : `${new Date(d.deadlineAt).toISOString()}${d.inMargin ? " (margin)" : ""}`,
      `${jobs}/${r.max_jobs ?? "∞"}`,
    ]);
  }
  console.log(t.toString());
}

export async function cmdHostList(db: Db): Promise<void> {
  const hosts = listHosts(db);
  const records = await providerHosts(db);
  if (isJsonMode()) {
    emitJsonCollection([...hosts.map(hostJson), ...records.map(recordJson)]);
    return;
  }
  if (records.length > 0) printRecords(db, records);
  if (hosts.length === 0) {
    if (records.length === 0) console.log("no host profiles (mu host init prints a starter)");
    return;
  }
  const held = new Map<string, number>();
  for (const c of listHostChannels(db)) held.set(c.host, (held.get(c.host) ?? 0) + 1);
  const t = muTable({
    head: ["HOST", "TRANSPORT", "STOP", "ATTACH", "DEFAULT REPO", "CHANNELS", "HARNESSES"],
  });
  for (const h of hosts) {
    t.push([
      h.name,
      h.transport,
      h.stop ?? "-",
      h.attach ?? "-",
      h.repo ?? "-",
      `${held.get(h.name) ?? 0}/${h.max_sessions ?? "∞"}`,
      harnessesCell(h),
    ]);
  }
  console.log(t.toString());
}

export function cmdHostShow(db: Db, name: string): void {
  const host: HostProfile = getHost(db, name);
  const channels = listHostChannels(db, name);
  if (isJsonMode()) {
    emitJson({ host: hostJson(host), channels });
    return;
  }
  console.log(
    `${pc.bold(host.name)}  transport ${host.transport}  default repo ${host.repo ?? "-"}  max-sessions ${host.max_sessions ?? "none"}`,
  );
  if (host.plugin != null) console.log(`  ${"plugin".padEnd(6)} ${host.plugin}`);
  for (const f of ["shell", "exec", "fetch"] as const) {
    if (host[f] !== null && host[f] !== "") console.log(`  ${f.padEnd(6)} ${host[f]}`);
  }
  if (host.stop !== null) console.log(`  ${"stop".padEnd(6)} ${host.stop}`);
  if (host.attach !== null) console.log(`  ${"attach".padEnd(6)} ${host.attach}`);
  const caps = hostCapabilities(host);
  console.log(
    caps === undefined
      ? "  harnesses: not probed (mu host check)"
      : `  harnesses: ${harnessesCell(host)} (probed ${caps.probedAt})`,
  );
  console.log(
    channels.length === 0
      ? "  channels: none held"
      : `  channels: ${channels.map(channelLine).join("; ")}`,
  );
}

export function cmdHostRm(db: Db, name: string): void {
  const removed = removeHost(db, name);
  if (isJsonMode()) {
    emitJson({ host: name, removed });
    return;
  }
  console.log(removed ? `removed host ${name}` : `no host profile named ${name}`);
}

/** `--param k=v`, repeatable. */
function collectParam(v: string, prev: Record<string, string>): Record<string, string> {
  const eq = v.indexOf("=");
  if (eq <= 0) throw new UsageError(`--param takes key=value, got ${JSON.stringify(v)}`);
  return { ...prev, [v.slice(0, eq)]: v.slice(eq + 1) };
}

export async function cmdHostAcquire(
  db: Db,
  name: string,
  opts: { provider: string; param?: Record<string, string>; repo?: string },
): Promise<void> {
  if (!isValidHostName(name)) throw new UsageError(`invalid host name ${JSON.stringify(name)}`);
  const rec = await acquireHost(db, {
    name,
    provider: opts.provider,
    params: opts.param ?? {},
    repo: opts.repo ?? null,
  });
  if (isJsonMode()) {
    emitJson({ host: rec === undefined ? null : recordJson(rec), acquired: rec !== undefined });
    return;
  }
  console.log(
    rec === undefined
      ? `host ${name} was never acquired: nothing is held`
      : `acquired host ${pc.bold(name)} from ${rec.provider} (${rec.state}, handle ${rec.handle ?? "-"})`,
  );
}

export async function cmdHostDrain(db: Db, name: string): Promise<void> {
  const rec = await drainHost(db, name);
  if (isJsonMode()) {
    emitJson({ host: recordJson(rec) });
    return;
  }
  console.log(`host ${name} is ${rec.state}: no new jobs`);
}

export async function cmdHostRelease(
  db: Db,
  name: string,
  opts: { abandon?: boolean },
): Promise<void> {
  if (opts.abandon === true) {
    const out = abandonHost(db, name);
    if (isJsonMode()) {
      emitJson({ host: name, released: true, abandoned: out });
      return;
    }
    const dropped = [...out.jobs, ...out.recoveries.map((r) => `recovery ${r}`), ...out.effects];
    console.log(`abandoned host ${name} (nothing asked of its provider; mu log has the loss)`);
    for (const d of dropped) console.log(`  dropped ${d}`);
    for (const j of out.running) console.log(`  ${pc.yellow("possibly still running")}: ${j}`);
    return;
  }
  await releaseHost(db, name);
  if (isJsonMode()) {
    emitJson({ host: name, released: true });
    return;
  }
  console.log(`released host ${name}`);
}

/** Print a starter. Never executes it: the user reviews, edits and pastes. */
export function cmdHostInit(name: string, opts: { ssh?: boolean; mule?: boolean }): void {
  if (opts.ssh === true && opts.mule === true) {
    throw new UsageError("host init takes one starter kind: --ssh or --mule");
  }
  if (opts.ssh !== true && opts.mule !== true) {
    throw new UsageError("host init needs a starter kind: --ssh or --mule");
  }
  if (!isValidHostName(name)) {
    throw new UsageError(
      `invalid host name ${JSON.stringify(name)}: lowercase letters, digits, - and _`,
      { showHelp: false },
    );
  }
  const lease = opts.mule === true;
  const s: { shell: string; exec: string; fetch: string; stop?: string; attach?: string } = lease
    ? hostMuleStarter(name)
    : hostStarter(name);
  const command = [
    `mu host add ${name}${lease ? " --transport lease" : ""}`,
    `--shell ${shellQuote(s.shell)}`,
    `--exec ${shellQuote(s.exec)}`,
    ...(s.stop === undefined ? [] : [`--stop ${shellQuote(s.stop)}`]),
    ...(s.attach === undefined ? [] : [`--attach ${shellQuote(s.attach)}`]),
    `--fetch ${shellQuote(s.fetch)}`,
    ...(lease ? [] : ["--max-sessions 1"]),
  ].join(" \\\n  ");
  if (isJsonMode()) {
    emitJson({ host: name, ...(lease ? { transport: "lease" } : {}), ...s, command });
    return;
  }
  console.log(`# Starter for ${name}. Edit it, then run it: mu runs none of this.`);
  console.log(
    lease
      ? `# ${name} is mule's host; a lease worker holds no ssh session (docs/guide/remote.md).`
      : `# ${name} is the ssh target; ~/.ssh/config decides the rest.`,
  );
  console.log(command);
}

export async function cmdHostCheck(
  db: Db,
  name: string,
  opts: { agent?: string; workstream?: string; root?: string },
): Promise<void> {
  const agent =
    opts.agent === undefined
      ? undefined
      : { name: opts.agent, workstream: await resolveWorkstream(opts.workstream) };
  const report = await checkHost(db, name, {
    ...(agent !== undefined ? { agent } : {}),
    ...(opts.root !== undefined ? { root: opts.root } : {}),
  });
  if (isJsonMode()) {
    if (!report.ok) throw failureWithData(failedError(report), report);
    emitJson(report);
    return;
  }
  for (const s of report.steps) {
    const mark = s.warn
      ? pc.yellow("warn")
      : s.ok === true
        ? pc.green("ok  ")
        : s.ok === false
          ? pc.red("FAIL")
          : pc.dim("skip");
    console.log(`${mark} ${s.step.padEnd(9)} ${s.detail}`);
  }
  for (const w of report.warnings) console.log(`${pc.yellow("warn")} ${w}`);
  if (!report.ok) throw failedError(report);
}

function failedError(report: { host: string; steps: { step: string; ok: boolean | null }[] }) {
  return new HostCheckFailedError(
    report.host,
    report.steps.filter((s) => s.ok === false).map((s) => s.step),
  );
}

export interface HostAddOptions {
  shell?: string;
  exec?: string;
  plugin?: string;
  fetch?: string;
  repo?: string;
  maxSessions?: number;
  transport?: string;
  stop?: string;
  attach?: string;
}

export function wireHostCommands(program: Command): void {
  const host = program
    .command("host")
    .description(
      "Host profiles: command templates for a remote host. mu never connects and knows no ssh flags; it fills your templates and runs them with /bin/sh -c",
    );
  host
    .command("add <name>")
    .description(
      "Store a machine-local host profile: --shell opens the pane, --exec runs one remote command, --fetch brings commits home. --transport lease adds --stop and {job_file}/{job}; grammar in docs/guide/remote.md.",
    )
    .option(
      "--shell <template>",
      "pane command template (opens the remote shell; required without --plugin)",
    )
    .option(
      "--exec <template>",
      "template that runs one remote command ({cmd}; required without --plugin)",
    )
    .option(
      "--plugin <name>",
      "a registered plugin (mu plugin add) runs this host's commands instead of --shell and --exec; --fetch runs where the plugin does not fetch",
    )
    .option(
      "--fetch <template>",
      "local template that fetches commits home ({cwd}; required unless --plugin's link fetches)",
    )
    .option(
      "--repo <path>",
      "default remote repo for `agent spawn --host` without --root (a profile names a machine, not a repo)",
    )
    .option(
      "--transport <kind>",
      "session (default: the pane holds an ssh) or lease (the pane is a carrier owning a detached remote job; needs --stop and {job_file} in --shell)",
    )
    .option(
      "--stop <template>",
      "lease only: ends a job given its handle ({job}, required; {cwd} is `.`). Must be idempotent: exit 0 for a job already ended",
    )
    .option(
      "--attach <template>",
      "lease only, optional: opens a new carrier for a job that still runs ({job} and {job_file} once, {local_sock}, {remote_sock}; no {cmd} or {env}), for reattaching a reaped lease agent",
    )
    .option(
      "--max-sessions <n>",
      "cap on channels mu holds to this host at once (panes, --exec, --fetch)",
      parseNonNegativeInt,
    )
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as HostAddOptions;
      return handle(async (db) => cmdHostAdd(db, name, opts), this as Command)();
    });
  host
    .command("list")
    .description(
      "List host profiles with channels held / cap, and provider hosts with their state (each asked its status once)",
    )
    .option(...JSON_OPT)
    .action(function () {
      return handle(async (db) => cmdHostList(db), this as Command)();
    });
  host
    .command("acquire <name>")
    .description(
      "Acquire a provider host from a registered plugin. The record and its acquire are written first: a re-run after a crash resolves the same request",
    )
    .requiredOption("--provider <plugin>", "the registered plugin that provides the host")
    .option("--param <key=value>", "a provider parameter (repeatable)", collectParam, {})
    .option("--repo <path>", "the host's repo for `agent spawn --worktree` without --root")
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        provider: string;
        param?: Record<string, string>;
        repo?: string;
      };
      return handle(async (db) => cmdHostAcquire(db, name, opts), this as Command)();
    });
  host
    .command("drain <name>")
    .description("Stop spawns on a provider host; its agents keep running until you close them")
    .option(...JSON_OPT)
    .action(function (name: string) {
      return handle(async (db) => cmdHostDrain(db, name), this as Command)();
    });
  host
    .command("release <name>")
    .description(
      "Release a drained or lost provider host; refuses while an agent, job or recovery record names it. A crashed release is reissued",
    )
    .option(
      "--abandon",
      "drop the host, its job records, recovery records and unresolved effects; logged, and the work is lost",
    )
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { abandon?: boolean };
      return handle(async (db) => cmdHostRelease(db, name, opts), this as Command)();
    });
  host
    .command("show <name>")
    .description(
      "Show a profile's transport, templates and the channels it holds, with their holders",
    )
    .option(...JSON_OPT)
    .action(function (name: string) {
      return handle(async (db) => cmdHostShow(db, name), this as Command)();
    });
  host
    .command("rm <name>")
    .description("Remove a profile. Refuses while it holds a channel (close those agents first)")
    .option(...JSON_OPT)
    .action(function (name: string) {
      return handle(async (db) => cmdHostRm(db, name), this as Command)();
    });
  host
    .command("init <name>")
    .description(
      "Print a starter `mu host add` for you to edit: --ssh (the socket forward, `$SHELL -ilc`, identity env inside the command) or --mule (a lease profile for a session-capped host). Prints only: mu never runs it and never connects.",
    )
    .option("--ssh", "print the ssh starter")
    .option("--mule", "print the lease starter for a session-capped host (a mule carrier)")
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { ssh?: boolean; mule?: boolean };
      return handle(async () => cmdHostInit(name, opts), this as Command)();
    });
  host
    .command("check <name>")
    .description(
      "Run the profile's --exec under one channel: host answers, repo is git, harnesses and murmur hooks (recorded), pi and `pi list` if pi is there; lease templates expanded, not run. --agent probes its socket and job. Exit 5 on failure.",
    )
    .option("--agent <name>", "also probe this agent's control socket (the forward rides its pane)")
    .option("--root <path>", "the remote repo the repo step checks (default: the profile's)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).optsWithGlobals() as {
        agent?: string;
        workstream?: string;
        root?: string;
      };
      return handle((db) => cmdHostCheck(db, name, opts), this as Command)();
    });
}
