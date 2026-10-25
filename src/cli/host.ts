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
import {
  addHost,
  checkHost,
  getHost,
  type HostChannel,
  HostCheckFailedError,
  type HostProfile,
  hostStarter,
  isValidHostName,
  listHostChannels,
  listHosts,
  removeHost,
} from "../hosts.js";
import { isJsonMode, muTable, pc, printNextSteps } from "../output.js";
import { shellQuote } from "../shell-quote.js";
import { failureWithData } from "./handle.js";

function channelLine(c: HostChannel): string {
  const on = c.kind === "attached" ? `pane ${c.pane_id}` : `pid ${c.pid}`;
  return `${c.holder} (${c.kind}, ${on})`;
}

export function cmdHostAdd(db: Db, name: string, opts: HostAddOptions): void {
  const host = addHost(db, {
    name,
    shell: opts.shell,
    exec: opts.exec,
    fetch: opts.fetch,
    repo: opts.repo,
    max_sessions: opts.maxSessions ?? null,
  });
  if (isJsonMode()) {
    emitJson({ host });
    return;
  }
  console.log(`added host ${pc.bold(host.name)}`);
  printNextSteps([{ intent: "Check it", command: `mu host check ${host.name}` }]);
}

export function cmdHostList(db: Db): void {
  const hosts = listHosts(db);
  if (isJsonMode()) {
    emitJsonCollection(hosts);
    return;
  }
  if (hosts.length === 0) {
    console.log("no host profiles");
    printNextSteps([{ intent: "Print a starter", command: "mu host init <name> --ssh" }]);
    return;
  }
  const held = new Map<string, number>();
  for (const c of listHostChannels(db)) held.set(c.host, (held.get(c.host) ?? 0) + 1);
  const t = muTable({ head: ["HOST", "REPO", "CHANNELS"] });
  for (const h of hosts) {
    t.push([h.name, h.repo, `${held.get(h.name) ?? 0}/${h.max_sessions ?? "∞"}`]);
  }
  console.log(t.toString());
}

export function cmdHostShow(db: Db, name: string): void {
  const host: HostProfile = getHost(db, name);
  const channels = listHostChannels(db, name);
  if (isJsonMode()) {
    emitJson({ host, channels });
    return;
  }
  console.log(
    `${pc.bold(host.name)}  repo ${host.repo}  max-sessions ${host.max_sessions ?? "none"}`,
  );
  for (const f of ["shell", "exec", "fetch"] as const) console.log(`  ${f.padEnd(6)} ${host[f]}`);
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

/** Print a starter. Never executes it: the user reviews, edits and pastes. */
export function cmdHostInit(name: string, opts: { ssh?: boolean }): void {
  if (opts.ssh !== true) {
    throw new UsageError("host init needs a starter kind: --ssh");
  }
  if (!isValidHostName(name)) {
    throw new UsageError(
      `invalid host name ${JSON.stringify(name)}: lowercase letters, digits, - and _`,
      { showHelp: false },
    );
  }
  const s = hostStarter(name);
  const command = [
    `mu host add ${name}`,
    `--shell ${shellQuote(s.shell)}`,
    `--exec ${shellQuote(s.exec)}`,
    `--fetch ${shellQuote(s.fetch)}`,
    "--repo '<remote repo path>'",
    "--max-sessions 1",
  ].join(" \\\n  ");
  if (isJsonMode()) {
    emitJson({ host: name, ...s, command });
    return;
  }
  console.log(`# Starter for ${name}. Edit it, then run it: mu runs none of this.`);
  console.log(`# ${name} is the ssh target; ~/.ssh/config decides the rest.`);
  console.log(command);
}

export async function cmdHostCheck(
  db: Db,
  name: string,
  opts: { agent?: string; workstream?: string },
): Promise<void> {
  const agent =
    opts.agent === undefined
      ? undefined
      : { name: opts.agent, workstream: await resolveWorkstream(opts.workstream) };
  const report = await checkHost(db, name, agent === undefined ? {} : { agent });
  if (isJsonMode()) {
    if (!report.ok) throw failureWithData(failedError(report), report);
    emitJson(report);
    return;
  }
  for (const s of report.steps) {
    const mark =
      s.ok === true ? pc.green("ok  ") : s.ok === false ? pc.red("FAIL") : pc.dim("skip");
    console.log(`${mark} ${s.step.padEnd(9)} ${s.detail}`);
  }
  if (!report.ok) throw failedError(report);
}

function failedError(report: { host: string; steps: { step: string; ok: boolean | null }[] }) {
  return new HostCheckFailedError(
    report.host,
    report.steps.filter((s) => s.ok === false).map((s) => s.step),
  );
}

export interface HostAddOptions {
  shell: string;
  exec: string;
  fetch: string;
  repo: string;
  maxSessions?: number;
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
      "Store a host profile (machine-local). Templates may use {env} {cmd} {local_sock} {remote_sock} {cwd}; each value is one shell-quoted word (inside your own quotes, the value itself; {cmd:sh} etc. also quote for a second shell such as the remote login shell), {{ }} are literal braces, anything else in braces is refused. --shell is the pane command, --exec runs one remote command, --fetch runs locally and brings commits back (git fetch ssh://dev{cwd} HEAD).",
    )
    .requiredOption("--shell <template>", "pane command template (opens the remote shell)")
    .requiredOption("--exec <template>", "template that runs one remote command ({cmd})")
    .requiredOption("--fetch <template>", "local template that fetches commits home ({cwd})")
    .requiredOption("--repo <path>", "the repository's path on the host")
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
    .description("List host profiles with channels held / cap")
    .option(...JSON_OPT)
    .action(function () {
      return handle(async (db) => cmdHostList(db), this as Command)();
    });
  host
    .command("show <name>")
    .description("Show a profile's templates and the channels it holds, with their holders")
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
      "Print a starter `mu host add` for ssh (the socket forward, `$SHELL -ilc`, identity env inside the command) for you to edit. Prints only: mu never runs it and never connects.",
    )
    .option("--ssh", "print the ssh starter")
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { ssh?: boolean };
      return handle(async () => cmdHostInit(name, opts), this as Command)();
    });
  host
    .command("check <name>")
    .description(
      "Run the profile's own --exec template under one channel: the host answers, the repo is a git repo, pi runs, `pi list` names mu. With --agent, also probe that agent's forwarded control socket. Each failure is reported, nothing is retried; exit 5 when a step fails",
    )
    .option("--agent <name>", "also probe this agent's control socket (the forward rides its pane)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).optsWithGlobals() as { agent?: string; workstream?: string };
      return handle((db) => cmdHostCheck(db, name, opts), this as Command)();
    });
}
