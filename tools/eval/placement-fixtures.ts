// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { hostProfile, makeRepo, seedViaMu, shq, sshShim } from "./fixtures.ts";
import type { Sandbox } from "./types.ts";

export async function placementHost(sb: Sandbox): Promise<string> {
  await makeRepo(sb, {
    "check.sh":
      '#!/bin/sh\nprintf \'%s\\n\' "$HOME" >> "$HOME/check-runs"\necho check >> "$HOME/job-events"\necho workspace-check-ok\n',
  });
  await seedViaMu(sb, [["workstream", "init", "eval"]]);
  const { hostRoot } = await sshShim(sb, { host: "build", maxSessions: 1 });
  return join(hostRoot, "home");
}

/** Shipped template transport only: a pane publishes a handle and stays live, without model calls. */
export async function placementLease(sb: Sandbox, home: string): Promise<void> {
  const carrier = join(home, "carrier.sh");
  const stop = join(home, "stop.sh");
  const exec = join(home, "exec.sh");
  writeFileSync(
    exec,
    `#!/bin/sh
if [ -f ${shq(join(home, "master-down"))} ]; then
  echo exec >> ${shq(join(home, "job-events"))}
  echo 'master is down; reconnect it' >&2
  exit 3
fi
exec ssh build "$1"
`,
  );
  writeFileSync(
    carrier,
    `#!/bin/sh
printf 'start job-%s\\n' "$$" >> ${shq(join(home, "job-events"))}
printf 'job-%s\\n' "$$" > "$1.tmp" && mv "$1.tmp" "$1" || exit 1
exec sleep 300
`,
  );
  writeFileSync(
    stop,
    `#!/bin/sh
printf 'stop %s\\n' "$1" >> ${shq(join(home, "job-events"))}
if [ -f ${shq(join(home, "master-down"))} ]; then
  echo 'master is down; reconnect it' >&2
  exit 3
fi
`,
  );
  await seedViaMu(sb, [
    [
      "host",
      "add",
      "build",
      "--transport",
      "lease",
      "--max-sessions",
      "1",
      "--repo",
      "~/repo",
      "--shell",
      `sh ${shq(carrier)} {job_file} {local_sock} {remote_sock} {cmd}`,
      "--exec",
      `sh ${shq(exec)} {cmd}`,
      "--stop",
      `sh ${shq(stop)} {job}`,
      "--fetch",
      "git fetch ssh://build{cwd} HEAD",
    ],
  ]);
}

export const placementSession = (sb: Sandbox): Promise<void> =>
  hostProfile(sb, "build", { maxSessions: 1 });
export const placementHome = (sb: Sandbox): string => join(sb.dir, "hosts", "build", "home");

export function fixtureLines(sb: Sandbox, name: string): string[] {
  const file = join(placementHome(sb), name);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}

export function placementRows<T>(sb: Sandbox, query: string): T[] {
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(query).all() as T[];
  } finally {
    db.close();
  }
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
