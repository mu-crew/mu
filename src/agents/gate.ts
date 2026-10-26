// mu — remote command gates: `spawn --host` of a NON-pi command.
//
// A gate is a foreground remote command (`npm test`) in a pane. Its numeric
// exit is the authoritative result `mu wait` returns, without pi or murmur.
//
// Two statuses exist and only one is the answer. The LOCAL pane runs the
// profile's `shell` template (ssh, a container exec, a fake), whose own exit
// may swallow or replace the remote command's. So the remote wrapper writes a
// completion record keyed by the spawn-unique token (`agents.gate_token`):
// `MU_GATE <token> <rc>`, atomically, on the host. The record is read with the
// profile's `exec` template only AFTER the mux proves the transport pane
// exited (`paneResult`), and that proof frees the pane's channel first, so at
// --max-sessions 1 the read admits like any other exec. Absent, malformed or
// foreign records, a signal or a lost transport are never success.
//
// Reading is idempotent (it never removes the record); `agent close` removes
// only its own token's file.

import { randomUUID } from "node:crypto";
import type { AgentRow } from "../agents.js";
import type { Db } from "../db.js";
import { getHost, runHostTemplate } from "../hosts.js";
import { activeMux } from "../mux.js";
import { localPaneAlive } from "../remote-agent.js";
import { shellQuote } from "../shell-quote.js";

/** What a gate's wait sees. `unknown` is retried (the result could not be read yet); `dead` is final. */
export type GateReading =
  | { kind: "running" }
  | { kind: "exited"; code: number }
  | { kind: "dead"; reason: string }
  | { kind: "unknown"; reason: string };

/** A fresh token: the gate's marker on its row and the key of its remote record. */
export const newGateToken = (): string => randomUUID();

const TOKEN_RE = /^[0-9a-f-]{36}$/;
const DIR = `"$HOME"/.local/state/mu-next/remote-gates`;

const sh = (body: string): string => `sh -c ${shellQuote(body)}`;

function assertToken(token: string): void {
  if (!TOKEN_RE.test(token)) throw new Error(`gate token ${JSON.stringify(token)} is not a uuid`);
}

/**
 * The command the template's `{cmd}` carries for a gate: runs `command` under
 * `sh -c` and records its numeric status for `token`. A host that cannot take
 * the record refuses to run the command (exit 126), so no gate runs unrecorded.
 */
export function gateWrapper(command: string, token: string): string {
  assertToken(token);
  return sh(
    [
      `d=${DIR}`,
      `mkdir -p "$d" || exit 126`,
      `rm -f "$d/${token}" "$d/${token}.tmp"`,
      `sh -c ${shellQuote(command)}`,
      `rc=$?`,
      `printf 'MU_GATE ${token} %s\\n' "$rc" > "$d/${token}.tmp" && mv "$d/${token}.tmp" "$d/${token}"`,
      `exit "$rc"`,
    ].join("\n"),
  );
}

/** The exec command that prints the token's record, behind a tag proving the script ran. */
const readCommand = (token: string): string =>
  sh([`f=${DIR}/${token}`, `echo MU_GATE_READ`, `[ ! -f "$f" ] || cat "$f"`].join("\n"));

/** The exec command that removes the token's own files. */
const cleanCommand = (token: string): string =>
  sh([`d=${DIR}`, `rm -f "$d/${token}" "$d/${token}.tmp"`].join("\n"));

type Parsed = { kind: "code"; code: number } | { kind: "dead"; reason: string };

/** The record in a read's stdout: exactly `MU_GATE <token> <digits>`, the gate's own token. */
function parseRecord(stdout: string, token: string): Parsed {
  const lines = stdout.split("\n").map((l) => l.trim());
  const tag = lines.lastIndexOf("MU_GATE_READ");
  const rest = (tag === -1 ? [] : lines.slice(tag + 1)).filter((l) => l !== "");
  if (rest.length === 0) return { kind: "dead", reason: "no completion record on the host" };
  const m = /^MU_GATE ([0-9a-f-]+) (\d{1,3})$/.exec(rest[0] ?? "");
  if (rest.length !== 1 || m === null) {
    return { kind: "dead", reason: "the completion record is malformed" };
  }
  if (m[1] !== token) return { kind: "dead", reason: "the completion record is another gate's" };
  const code = Number(m[2]);
  if (code > 255) return { kind: "dead", reason: "the completion record is malformed" };
  return { kind: "code", code };
}

/** The row `agent` names right now: same registry id, pane and token, else it was replaced. */
function sameRow(db: Db, agent: AgentRow): boolean {
  const row = db
    .prepare(
      `SELECT a.id, a.pane_id, a.gate_token FROM agents a JOIN workstreams w ON w.id = a.workstream_id
        WHERE w.name = ? AND a.name = ?`,
    )
    .get(agent.workstreamName, agent.name) as
    | { id: number; pane_id: string; gate_token: string | null }
    | undefined;
  return (
    row !== undefined &&
    row.id === agent.incarnation &&
    row.pane_id === agent.paneId &&
    row.gate_token === agent.gateToken
  );
}

const unknown = (reason: string): GateReading => ({ kind: "unknown", reason });

/**
 * Read one gate: running, exited with the remote command's numeric status,
 * dead (final failure: no usable record, or the pane is gone) or unknown
 * (retry: the mux or the host could not answer). A proven exit frees the pane's
 * channel through the result read's own admission (see `localPaneAlive`); an
 * unknown probe frees nothing.
 */
export async function readGate(db: Db, agent: AgentRow): Promise<GateReading> {
  const token = agent.gateToken;
  const host = agent.host;
  if (token === null || host === null) return unknown("not a remote command gate");
  let pane: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof activeMux>>["paneResult"]>>>;
  try {
    const mux = await activeMux();
    if (mux.paneResult === undefined) return unknown("the multiplexer cannot report a pane's exit");
    pane = await mux.paneResult(agent.paneId);
  } catch (e) {
    return unknown(`mux: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (pane.state === "running") return { kind: "running" };
  if (pane.state === "absent") return { kind: "dead", reason: "pane gone" };
  // The transport exited: `localPaneAlive` reads it as dead, so the exec reclaims its channel.
  if (!sameRow(db, agent)) return { kind: "dead", reason: "the agent was replaced" };
  let run: Awaited<ReturnType<typeof runHostTemplate>>;
  try {
    run = await runHostTemplate(
      db,
      host,
      "exec",
      `gate:${agent.workstreamName}/${agent.name}`,
      { cmd: readCommand(token), cwd: getHost(db, host).repo },
      { paneAlive: localPaneAlive },
    );
  } catch (e) {
    return unknown(`result read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!sameRow(db, agent)) return { kind: "dead", reason: "the agent was replaced" };
  if (run.exitCode !== 0) {
    return unknown(
      run.exitCode === null ? "result read timed out" : `result read failed (exit ${run.exitCode})`,
    );
  }
  if (!run.stdout.split("\n").some((l) => l.trim() === "MU_GATE_READ")) {
    return unknown("the host's answer carried no result tag");
  }
  const rec = parseRecord(run.stdout, token);
  return rec.kind === "code" ? { kind: "exited", code: rec.code } : rec;
}

/**
 * Remove the gate's own remote record (its token's files only: a replacement
 * has another token). Best effort, one exec under its own channel; the caller
 * has already proven the pane dead and freed its channel.
 */
export async function cleanGateResult(db: Db, agent: AgentRow): Promise<boolean> {
  const token = agent.gateToken;
  const host = agent.host;
  if (token === null || host === null) return false;
  try {
    const r = await runHostTemplate(
      db,
      host,
      "exec",
      `gate-clean:${agent.workstreamName}/${agent.name}`,
      { cmd: cleanCommand(token), cwd: getHost(db, host).repo },
      { paneAlive: localPaneAlive },
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
