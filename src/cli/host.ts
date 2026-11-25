// mu — host profiles, provider hosts and commands through a host's link.
// `host init` prints a plugin or template starter and runs nothing.

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
import { HOST_EXEC_DEFAULT_TIMEOUT_S, hostExec } from "../host-exec.js";
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
  hostFetchStarter,
  hostMuleStarter,
  hostStarter,
  isValidHostName,
  listHostChannels,
  listHosts,
  removeHost,
} from "../hosts.js";
import { isJsonMode, muTable, pc } from "../output.js";
import { shellQuote } from "../shell-quote.js";
import { relTimeAgo, truncateFront } from "./format.js";
import { CliExitError, failureWithData } from "./handle.js";

/** Width of `host list`'s repo cell: front-truncated so the repo's own name survives. */
const REPO_BUDGET = 28;

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

/** `3h ago`; the raw value when it does not parse (a hand-edited probe). */
function probedAgo(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : relTimeAgo(Date.now() - at);
}

function channelLine(c: HostChannel): string {
  const on = c.kind === "attached" ? `pane ${c.pane_id}` : `pid ${c.pid}`;
  return `${c.holder} (${c.kind}, ${on})`;
}

export function cmdHostAdd(db: Db, name: string, opts: HostAddOptions): void {
  const host = addHost(
    db,
    {
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
    },
    { replace: opts.replace === true },
  );
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

/**
 * The provider hosts, each asked its status once (a `gone` one is `lost`, D1).
 * A status that cannot be read (`unknown`, `needs-human`, or a throw such as an
 * unregistered plugin) leaves the recorded state and becomes that host's note,
 * so one unreachable provider never fails the listing nor hides behind `ready`.
 */
async function providerHosts(
  db: Db,
): Promise<{ records: HostRecord[]; statusNotes: Map<string, string> }> {
  const statusNotes = new Map<string, string>();
  for (const r of listHostRecords(db)) {
    try {
      const st = await observeHost(db, r.name);
      if (st?.state === "unknown") statusNotes.set(r.name, `status unknown: ${st.reason}`);
      if (st?.state === "needs-human") statusNotes.set(r.name, `needs a human: ${st.remedy}`);
    } catch (e) {
      statusNotes.set(r.name, `status failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { records: listHostRecords(db), statusNotes };
}

function printRecords(
  db: Db,
  records: readonly HostRecord[],
  statusNotes: ReadonlyMap<string, string>,
): void {
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
  for (const [name, note] of statusNotes) {
    console.log(pc.yellow(`warn ${name}: ${note} (state as last recorded)`));
  }
}

/**
 * `host list`: one row per host, templates left to `host show`. `--json` keeps
 * the collection shape; `kind` tells a profile from a provider host.
 */
export async function cmdHostList(db: Db): Promise<void> {
  const hosts = listHosts(db);
  const { records, statusNotes } = await providerHosts(db);
  if (isJsonMode()) {
    emitJsonCollection([
      ...hosts.map((h) => ({ kind: "profile", ...hostJson(h) })),
      ...records.map((r) => {
        const note = statusNotes.get(r.name);
        return {
          kind: "provider",
          ...recordJson(r),
          ...(note !== undefined ? { status_note: note } : {}),
        };
      }),
    ]);
    return;
  }
  if (hosts.length === 0 && records.length === 0) {
    console.log("no host profiles (mu host init prints a starter)");
    return;
  }
  const both = hosts.length > 0 && records.length > 0;
  if (records.length > 0) {
    if (both) console.log(pc.bold("Provider hosts"));
    printRecords(db, records, statusNotes);
  }
  if (hosts.length === 0) return;
  if (both) console.log(pc.bold("\nProfiles"));
  const held = new Map<string, number>();
  for (const c of listHostChannels(db)) held.set(c.host, (held.get(c.host) ?? 0) + 1);
  const t = muTable({
    head: ["HOST", "TRANSPORT", "DEFAULT REPO", "CHANNELS", "HARNESSES"],
  });
  for (const h of hosts) {
    t.push([
      h.name,
      h.transport,
      h.repo === null ? "-" : truncateFront(h.repo, REPO_BUDGET),
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
      : `  harnesses: ${harnessesCell(host)} (probed ${probedAgo(caps.probedAt)})`,
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

type HostInitOptions = { ssh?: boolean; mule?: boolean; template?: boolean };

/** Print a starter. Never executes it: the user reviews, edits and pastes. */
export function cmdHostInit(name: string, opts: HostInitOptions): void {
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
  if (opts.template !== true) {
    const plugin = lease ? "mule" : "ssh";
    const register = `mu plugin add ${plugin} -- /path/to/mu-plugin-${plugin}`;
    const fetch = hostFetchStarter(name);
    const command = `mu host add ${name} --plugin ${plugin} --fetch ${shellQuote(fetch)}${lease ? "" : " --max-sessions 1"}`;
    if (isJsonMode()) {
      emitJson({ host: name, plugin, register, fetch, command });
      return;
    }
    console.log(
      `# Starter for ${name}. Replace the plugin path before running; mu runs none of this.`,
    );
    console.log(lease ? `# ${name} must be configured in mule.` : `# ${name} is the ssh target.`);
    console.log(register);
    console.log(command);
    return;
  }
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
    ...(lease ? [] : ["--max-sessions 2"]),
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
  if (!lease) {
    console.log(
      `# No fresh ssh from the agent's tree? Use the mule plugin: open its private master from your terminal, then mu host add ${name} --plugin mule --fetch <cmd> (docs/guide/plugins.md#register-the-mule-plugin).`,
    );
  }
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

/** `text` with its final newline (a template link strips it, a plugin keeps it). */
const endLine = (text: string): string => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/** The command line `host exec` sends: one word is the script verbatim, several are quoted words. */
export function execScript(words: string[]): string {
  return words.length === 1 ? (words[0] as string) : words.map(shellQuote).join(" ");
}

/**
 * `host exec`: the link's reply. Plain mode writes the streams and exits with the link's code
 * (a hand-back is exit 5, `HostHandbackError`); `--json` prints one document and exits the same.
 * No exit code (deadline, no answer): exit 5.
 */
export async function cmdHostExec(
  db: Db,
  name: string,
  words: string[],
  opts: { cwd?: string; timeout?: string },
): Promise<void> {
  const timeoutS = opts.timeout === undefined ? undefined : Number(opts.timeout);
  if (timeoutS !== undefined && !(Number.isInteger(timeoutS) && timeoutS > 0)) {
    throw new UsageError(
      `--timeout wants whole seconds above 0, got ${JSON.stringify(opts.timeout)}`,
    );
  }
  const r = await hostExec(db, name, {
    script: execScript(words),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(timeoutS !== undefined ? { timeoutS } : {}),
  });
  const { host: _host, ...data } = r;
  if (r.exit === null) {
    const msg = `host ${name}: no exit code (deadline or no answer); the remote command ${r.remote === "stopped" ? "was stopped" : "may still run"}`;
    if (isJsonMode()) {
      throw new CliExitError(5, {
        error: "HostExecNoExit",
        message: msg,
        data: { exit: null, remote: r.remote },
      });
    }
    process.stdout.write(r.stdout);
    process.stderr.write(endLine(r.stderr));
    process.stderr.write(`HostExecNoExit: ${msg}\n`);
    throw new CliExitError(5);
  }
  if (isJsonMode()) emitJson(data);
  else {
    process.stdout.write(endLine(r.stdout));
    process.stderr.write(endLine(r.stderr));
  }
  if (r.exit !== 0) throw new CliExitError(r.exit);
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
  replace?: boolean;
}

export function wireHostCommands(program: Command): void {
  const host = program
    .command("host")
    .description(
      "Manage host profiles and provider hosts. A profile runs remote commands through a registered plugin or through your command templates.",
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
      "a registered plugin runs this host's commands; collect and close existing work before switching a template profile to a plugin",
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
    .option(
      "--replace",
      "replace the existing profile of this name in one step; every refusal of `host add` and `host rm` runs first, so a refusal keeps the old profile",
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
      "Print plugin registration and host profile commands for you to edit. Prints only: mu never runs them or connects.",
    )
    .option("--ssh", "print the mu-plugin-ssh starter (see docs/guide/plugins.md)")
    .option("--mule", "print the mu-plugin-mule starter for a host configured in mule")
    .option("--template", "print the template profile instead: ssh session or mule lease")
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as HostInitOptions;
      return handle(async () => cmdHostInit(name, opts), this as Command)();
    });
  host
    .command("exec <name> <cmd...>")
    .description(
      `Run one command on the host through its link (after --); no row or job. Exits with the link's code; 5 for a hand-back (a template's own exit 3 too) or no exit code. Output clipped at 1 MiB; deadline ${HOST_EXEC_DEFAULT_TIMEOUT_S} s.`,
    )
    .option("--cwd <dir>", "the remote working directory (default: the login directory)")
    .option("--timeout <s>", "deadline in seconds")
    .option(...JSON_OPT)
    .action(function (name: string, cmd: string[]) {
      const opts = (this as Command).opts() as { cwd?: string; timeout?: string };
      return handle((db) => cmdHostExec(db, name, cmd, opts), this as Command)();
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
