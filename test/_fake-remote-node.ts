// A fake remote node for the `hooks` channel's remote path (spec D11, U12).
//
// It stands in for the host a remote hook harness worker runs on: a host
// profile whose `exec` template runs `{cmd}` here (logging each command it was
// asked), with a fake `murmur` first on that command's PATH. The fake murmur
// keeps the worker's remote area in a directory, as murmur's does:
//
//   murmur pane --remote <key> --json   applies the waiting event files in name
//                                       order to the key's state, deletes them,
//                                       and prints the state with the events it
//                                       applied (murmur's RemoteReport shape)
//   murmur hook mu --remote <key>       records one of mu's events (stdin JSON)
//                                       in the area, stamped `by: "mu"`
//
// The test writes the remote harness's own events with `emit`. A file
// `pane-fail` makes the read exit 1; `hook-fail` makes mu's write fail.
// `murmur status` lists nothing: the node's store never holds a remote worker.

import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeRemoteNode {
  /** The host profile's exec template (`/bin/sh <fake-exec> {cmd}`). */
  readonly exec: string;
  /** The remote area's directory. */
  readonly dir: string;
  /** Write one of the remote harness's events into the key's area. */
  emit(event: string, fields?: Record<string, unknown>): void;
  /** Every command the exec template ran, in order. */
  execCalls(): string[];
  /** Every event mu recorded on the node with `murmur hook mu --remote`, in order. */
  muWrites(): Record<string, unknown>[];
  /** Events written but not yet read. */
  pending(): number;
  /** Make the next reads fail (exit 1), or succeed again. */
  failReads(on: boolean): void;
  /** Make mu's writes fail, or succeed again. */
  failWrites(on: boolean): void;
}

const MURMUR = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
const args = process.argv.slice(3);
const at = (flag) => args[args.indexOf(flag) + 1];
const eventsDir = path.join(dir, "events");
const statePath = path.join(dir, "state.json");
const readState = (key) => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
  return { key, claimed: false, claimed_at: null, harness: null, session_id: null, run_count: 0,
    activity: "stopped", confirmed: true, last_text: null, attention: [], updated_at: null };
};
const apply = (st, e) => {
  if (!st.claimed && e.by === "mu") return false;
  if (!st.claimed) { st.claimed = true; st.claimed_at = e.at; st.harness = e.harness; }
  st.updated_at = e.at;
  if (e.event !== "permission_requested") st.attention = st.attention.filter((a) => a.kind !== "blocked");
  switch (e.event) {
    case "session_start":
      st.activity = "stopped"; st.confirmed = true;
      if (e.source !== "resume") { st.session_id = e.session_id; st.run_count = 0; st.last_text = null; }
      break;
    case "prompt_submitted": st.activity = "running"; st.run_count += 1; st.confirmed = true; break;
    case "continued": st.activity = "running"; break;
    case "permission_requested": st.attention.push({ kind: "blocked", message: e.message || "", at: e.at }); break;
    case "interrupted": st.activity = "stopped"; st.confirmed = e.by !== "mu"; break;
    case "turn_stopped": st.activity = "stopped"; st.confirmed = true; if (typeof e.text === "string") st.last_text = e.text; break;
    case "turn_failed": st.activity = "stopped"; st.attention.push({ kind: "error", message: e.message || "", at: e.at }); break;
    case "session_end": if (e.reason !== "clear") st.claimed = false; break;
  }
  return true;
};
const word = (st) => {
  if (!st.claimed && st.attention.length === 0) return null;
  if (st.attention.some((a) => a.kind === "blocked")) return "blocked";
  if (st.attention.some((a) => a.kind === "error")) return "error";
  if (st.activity === "running") return "working";
  return st.confirmed ? "idle" : "idle?";
};
if (args[0] === "pane" && args.includes("--remote")) {
  if (fs.existsSync(path.join(dir, "pane-fail"))) { process.stderr.write("murmur: boom\n"); process.exit(1); }
  const key = at("--remote");
  const st = readState(key);
  fs.mkdirSync(eventsDir, { recursive: true });
  const applied = [];
  for (const name of fs.readdirSync(eventsDir).sort()) {
    const file = path.join(eventsDir, name);
    const e = JSON.parse(fs.readFileSync(file, "utf8"));
    if (apply(st, e)) applied.push(e);
    fs.rmSync(file);
  }
  fs.writeFileSync(statePath, JSON.stringify(st));
  const report = {
    remote: key,
    state: word(st),
    agent: st.claimed_at === null ? null : {
      agent_name: null, workstream: null, role: null, cli: st.harness, driver: "orchestrated",
      activity: st.activity, harness: st.harness, session_id: st.session_id, run_count: st.run_count,
      last_text: st.last_text, confirmed: st.confirmed, claimed: st.claimed,
      claimed_at: st.claimed_at, updated_at: st.updated_at,
    },
    attention: st.attention,
    events: applied.map((e) => ({ event: e.event, harness: e.harness ?? null, at: e.at, by: e.by,
      session_id: e.session_id ?? null, source: e.source ?? null, reason: e.reason ?? null,
      message: e.message ?? null, text: e.text ?? null, generation_id: e.generation_id ?? null })),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else if (args[0] === "hook" && args[1] === "mu" && args.includes("--remote")) {
  if (fs.existsSync(path.join(dir, "hook-fail"))) process.exit(1);
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.appendFileSync(path.join(dir, "mu-writes.jsonl"), JSON.stringify(input) + "\n");
  fs.mkdirSync(eventsDir, { recursive: true });
  // Named by the system-wide monotonic clock, as the test's own events are: name order is write order.
  const name = String(process.hrtime.bigint()).padStart(24, "0") + "-mu.json";
  fs.writeFileSync(path.join(eventsDir, name), JSON.stringify({ ...input, at: Date.now(), by: "mu" }));
} else if (args[0] === "status") {
  process.stdout.write("[]\n");
} else {
  process.stderr.write("fake murmur: unexpected " + args.join(" ") + "\n");
  process.exit(2);
}
`;

export function fakeRemoteNode(
  root: string,
  harness = "claude",
  sessionId = "sess-1",
): FakeRemoteNode {
  const dir = join(root, "remote-node");
  const bin = join(dir, "bin");
  const log = join(dir, "execlog");
  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(log, { recursive: true });
  const script = join(dir, "murmur.cjs");
  writeFileSync(script, MURMUR);
  // `murmur` on the remote command's PATH: the node script with its area baked in.
  writeFileSync(join(bin, "murmur"), `#!/bin/sh\nexec node '${script}' '${dir}' "$@"\n`);
  chmodSync(join(bin, "murmur"), 0o755);
  const fakeExec = join(dir, "fake-exec.sh");
  writeFileSync(
    fakeExec,
    `#!/bin/sh
n=$(ls '${log}' | wc -l)
printf '%s' "$1" > '${log}'/$n
PATH='${bin}':$PATH
export PATH
exec /bin/sh -c "$1"
`,
  );
  chmodSync(fakeExec, 0o755);
  return {
    exec: `/bin/sh ${fakeExec} {cmd}`,
    dir,
    emit(event, fields = {}) {
      // Named by the system-wide monotonic clock, as mu's writes are: name order is write order.
      const name = `${String(process.hrtime.bigint()).padStart(24, "0")}-h.json`;
      writeFileSync(
        join(dir, "events", name),
        JSON.stringify({
          event,
          harness,
          session_id: sessionId,
          at: Date.now(),
          by: "harness",
          ...fields,
        }),
      );
    },
    execCalls: () =>
      readdirSync(log)
        .sort((a, b) => Number(a) - Number(b))
        .map((f) => readFileSync(join(log, f), "utf8")),
    muWrites: () => {
      try {
        return readFileSync(join(dir, "mu-writes.jsonl"), "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    pending: () => readdirSync(join(dir, "events")).length,
    failReads(on) {
      if (on) writeFileSync(join(dir, "pane-fail"), "");
      else rmSync(join(dir, "pane-fail"), { force: true });
    },
    failWrites(on) {
      if (on) writeFileSync(join(dir, "hook-fail"), "");
      else rmSync(join(dir, "hook-fail"), { force: true });
    },
  };
}
