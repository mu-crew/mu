// mu — `mu agent send`: a prompt, slash command, steer or fresh session
// through the agent's channel, `--interrupt` (abort then send), and `--wait`
// (the wait for exactly the run the send started, as one document).

import {
  getAgent,
  interruptAgent,
  isSlashCommand,
  parseSessionCommand,
  sendToAgent,
} from "../agents.js";
import { agentChannel, type ChannelName, channelTarget, sendAckMs } from "../channels/index.js";
import {
  assertAgentInWorkstream,
  CliExitError,
  emitJson,
  resolveEntityRef,
  resolveExistingWorkstream,
  UsageError,
} from "../cli.js";
import type { Db } from "../db.js";
import { say } from "../messages.js";
import type { SendWarning } from "../mux.js";
import { pc } from "../output.js";
import type { WaitRef } from "../wait.js";
import { setNextOutcome } from "./handle.js";
import { readStdinText, STDIN_ARG } from "./stdin.js";
import { runWait, type WaitSignals } from "./wait.js";
import { armSend, sentFence } from "./wait-arm.js";

export async function cmdSend(
  db: Db,
  rawName: string,
  rawText: string,
  opts: {
    workstream?: string;
    json?: boolean;
    steer?: boolean;
    fresh?: boolean;
    force?: boolean;
    interrupt?: boolean;
    timeout?: number;
    /** Enter the wait for the run this send starts (one JSON document: the receipt in `sent`, then the wait). */
    wait?: boolean;
  } = {},
  sig?: WaitSignals,
): Promise<void> {
  const text = rawText === STDIN_ARG ? await readStdinText("send text") : rawText;
  if (opts.interrupt) {
    for (const [on, flag] of [
      [opts.fresh, "--fresh"],
      [opts.steer, "--steer"],
      [opts.force, "--force"],
    ] as const) {
      if (on) throw new UsageError(say("agent.send_interrupt_excl", flag));
    }
    if (isSlashCommand(text)) {
      throw new UsageError(say("agent.send_interrupt_slash"));
    }
    // Refuse before the abort: an empty prompt would kill the running turn
    // and then send nothing.
    if (text === "") throw new UsageError(say("agent.send_interrupt_empty"));
  } else if (opts.timeout !== undefined) {
    throw new UsageError(say("agent.send_timeout"));
  }
  if (opts.fresh && opts.steer) throw new UsageError(say("agent.send_fresh_steer"));
  if (opts.wait) {
    if (sig === undefined) throw new UsageError(say("agent.send_wait_sig"));
    // A slash command starts no run: there is nothing to wait for (refused before the send).
    if (isSlashCommand(text)) {
      throw new UsageError(say("agent.send_wait_slash"));
    }
  }
  if (opts.interrupt) return cmdSendInterrupt(db, rawName, text, opts, sig);
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  // A plain --force is the hooks send gate's override (paste into a running or unknown agent).
  if (opts.force && !opts.fresh && parseSessionCommand(text) === undefined) {
    const row = getAgent(db, name, ws);
    if (row === undefined || agentChannel(channelTarget(db, row)).name !== "hooks") {
      throw new UsageError(say("agent.send_force"));
    }
  }
  // dogfood_send_after_new_dropped: capture the undelivered warning
  // rather than letting it print raw, so it lands in the JSON payload
  // too. `exit 0` must not be able to mean "silently dropped".
  let undelivered: SendWarning | undefined;
  const sent = await sendToAgent(db, name, text, {
    workstream: ws,
    ...(opts.steer ? { mode: "steer" as const } : {}),
    ...(opts.fresh ? { fresh: true } : {}),
    ...(opts.force ? { force: true } : {}),
    onUndelivered: (w) => {
      undelivered = w;
    },
  });
  // Arm the wait this send owes (a delivered prompt; fenced by the runs measured BEFORE it).
  const armed =
    undelivered === undefined
      ? armSend(db, { name, workstreamName: ws }, sent)
      : { armed: false as const };
  const warnings = armed.warning === undefined ? [] : [armed.warning];
  if (!opts.json && !opts.wait) for (const w of warnings) console.error(pc.yellow(`warning: ${w}`));
  // The run this send started, as a wait counts it: ctl's runs, or a confirmed paste's.
  const fence = sentFence(sent);
  if (opts.wait && sig !== undefined) {
    return enterSendWait(
      db,
      { name, workstreamName: ws },
      { transport: sent.transport, ...fence },
      {
        sig,
        verb: "mu agent send --wait",
        undelivered: undelivered === undefined ? undefined : undelivered.message,
        receipt: {
          agentName: name,
          sentBytes: Buffer.byteLength(text),
          transport: sent.transport,
          ...(sent.runs !== undefined ? { runs: sent.runs } : {}),
          ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
          ...(sent.msgId !== undefined ? { msgId: sent.msgId } : {}),
          ...(sent.receipt !== undefined ? { receipt: sent.receipt } : {}),
          ...(sent.ack !== undefined ? { ack: sent.ack } : {}),
          ...(sent.runCount !== undefined ? { runCount: sent.runCount } : {}),
        },
        warnings,
      },
    );
  }
  // ONE next: a delivered ctl reply with runs, or a confirmed hooks paste, gives the exact
  // wait baseline (the wait returns the run's final text). An undelivered or mux send owes no wait.
  if (fence.runs !== undefined && undelivered === undefined) {
    setNextOutcome({
      kind: "sent",
      agent: { name, workstream: ws },
      runs: fence.runs,
      ...(fence.incarnation !== undefined ? { incarnation: fence.incarnation } : {}),
    });
  }
  if (opts.json) {
    emitJson({
      agentName: name,
      sentBytes: Buffer.byteLength(text),
      transport: sent.transport,
      fresh: opts.fresh === true,
      ...(sent.command !== undefined ? { command: sent.command } : {}),
      ...(sent.state !== undefined ? { state: sent.state } : {}),
      ...(sent.runs !== undefined ? { runs: sent.runs } : {}),
      ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
      ...(sent.msgId !== undefined ? { msgId: sent.msgId, delivery: "delivered" } : {}),
      ...(sent.receipt !== undefined ? { receipt: sent.receipt } : {}),
      ...(sent.ack !== undefined ? { ack: sent.ack } : {}),
      ...(sent.runCount !== undefined ? { runCount: sent.runCount } : {}),
      delivered: undelivered === undefined,
      ...(undelivered !== undefined
        ? { undelivered: { reason: undelivered.reason, message: undelivered.message } }
        : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
    return;
  }
  if (undelivered !== undefined) {
    console.error(pc.yellow(`warning: ${undelivered.message}`));
  } else {
    const how =
      sent.transport === "mux"
        ? "via mux"
        : sent.transport === "hooks"
          ? sent.ack === "sent"
            ? "via hooks to its host, sent: the next wait confirms it"
            : `via hooks${opts.fresh ? ", fresh session" : ""}, confirmed${sent.runCount !== undefined ? `: run ${sent.runCount}` : ""}`
          : opts.fresh
            ? "via ctl, fresh session"
            : sent.command !== undefined
              ? `via ctl, pi ran /${sent.command}`
              : sent.runs !== undefined
                ? `via ctl, pi was ${sent.state ?? "?"}, runs ${sent.runs}`
                : `via ctl, pi ${sent.state ?? "?"}`;
    const receipt =
      sent.receipt === undefined ? "" : "; no reply, but its receipt confirms it landed";
    console.log(pc.dim(`sent ${Buffer.byteLength(text)} bytes to ${name} (${how}${receipt})`));
  }
}

/**
 * `send --wait`: the prompt is delivered (and armed); now wait for exactly the run it
 * started: one explicit agent ref pinned by the measured runs + incarnation, `all` mode so a
 * sibling's event does not end it (an urgent one still does: the worker died, a dialog, a
 * delegate report). ONE document: the wait's, with the send's receipt as `sent`.
 * An UNDELIVERED send waits for nothing: it fails with the receipt (the prompt may not have landed).
 */
async function enterSendWait(
  db: Db,
  agent: { name: string; workstreamName: string },
  sent: { transport?: ChannelName; runs?: number; incarnation?: string },
  o: {
    sig: WaitSignals;
    verb: string;
    receipt: Record<string, unknown>;
    warnings: string[];
    undelivered?: string | undefined;
  },
): Promise<void> {
  if (o.undelivered !== undefined) {
    throw new CliExitError(1, {
      error: "SendUndelivered",
      message: say("agent.send_undelivered", o.undelivered),
      data: { sent: { ...o.receipt, delivered: false } },
    });
  }
  // A fence (ctl's runs, a confirmed hooks paste's) pins the wait to exactly that run.
  const fenced = sent.transport !== "mux" && sent.runs !== undefined;
  const ref: WaitRef = {
    kind: "agent",
    workstream: agent.workstreamName,
    id: agent.name,
    ...(fenced ? { afterRuns: sent.runs } : {}),
    ...(fenced && sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
  };
  await runWait(
    db,
    {
      refs: [ref],
      mode: "all",
      onStall: "exit",
      verb: o.verb,
      scope: agent.workstreamName,
    },
    o.sig,
    {
      extraData: {
        sent: { ...o.receipt, delivered: true },
        ...(o.warnings.length > 0 ? { warnings: o.warnings } : {}),
      },
    },
  );
}

/**
 * `mu agent send --interrupt`: abort a busy agent, wait for it to settle, send. pi over its
 * control socket; a `hooks` agent by its harness's interrupt key, then a paste.
 */
async function cmdSendInterrupt(
  db: Db,
  rawName: string,
  text: string,
  opts: { workstream?: string; json?: boolean; timeout?: number; wait?: boolean },
  sig?: WaitSignals,
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const r = await interruptAgent(db, name, text, {
    workstream: ws,
    ...(opts.timeout === undefined ? {} : { timeoutMs: Math.round(opts.timeout * 1000) }),
  });
  const transport = r.transport ?? "ctl";
  // hooks: the paste after the interrupt is confirmed by its run count, or it is unknown.
  const undelivered =
    r.ack === "unknown" ? say("agent.send_unconfirmed", name, sendAckMs()) : undefined;
  // The interrupt is delivered (it threw otherwise): arm the run it started, same fence rule.
  const armed =
    undelivered === undefined
      ? armSend(db, { name, workstreamName: ws }, { ...r, transport })
      : { armed: false as const };
  const warnings = armed.warning === undefined ? [] : [armed.warning];
  if (!opts.json && !opts.wait) for (const w of warnings) console.error(pc.yellow(`warning: ${w}`));
  if (opts.wait && sig !== undefined) {
    return enterSendWait(
      db,
      { name, workstreamName: ws },
      { ...r, transport },
      {
        sig,
        verb: "mu agent send --interrupt --wait",
        undelivered,
        receipt: {
          agentName: name,
          sentBytes: Buffer.byteLength(text),
          transport,
          interrupt: true,
          wasBusy: r.wasBusy,
          ...(r.pending ? { pending: true } : {}),
          ...(r.runs !== undefined ? { runs: r.runs } : {}),
          ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
          ...(r.msgId !== undefined ? { msgId: r.msgId } : {}),
          ...(r.receipt !== undefined ? { receipt: r.receipt } : {}),
          ...(r.stopped !== undefined ? { stopped: r.stopped } : {}),
          ...(r.ack !== undefined ? { ack: r.ack } : {}),
          ...(r.runCount !== undefined ? { runCount: r.runCount } : {}),
        },
        warnings,
      },
    );
  }
  if (r.runs !== undefined) {
    setNextOutcome({
      kind: "sent",
      agent: { name, workstream: ws },
      runs: r.runs,
      ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
    });
  }
  if (opts.json) {
    emitJson({
      agentName: name,
      sentBytes: Buffer.byteLength(text),
      transport,
      interrupt: true,
      ...r,
      ...(r.msgId !== undefined ? { delivery: "delivered" } : {}),
      ...(r.ack !== undefined ? { delivered: undelivered === undefined } : {}),
      ...(undelivered !== undefined
        ? { undelivered: { reason: "unconfirmed", message: undelivered } }
        : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
    return;
  }
  if (transport === "hooks") {
    const what = !r.wasBusy
      ? "it was idle"
      : r.stopped === "unconfirmed"
        ? "interrupted a busy run, unconfirmed: idle?"
        : "interrupted a busy run";
    if (r.stopped === "unconfirmed")
      console.error(pc.yellow(say("agent.interrupt_unconfirmed", name)));
    if (undelivered !== undefined) console.error(pc.yellow(`warning: ${undelivered}`));
    else {
      const run = r.runCount !== undefined ? `: run ${r.runCount}` : "";
      const how = r.ack === "sent" ? "sent: the next wait confirms it" : `confirmed${run}`;
      console.log(
        pc.dim(`sent ${Buffer.byteLength(text)} bytes to ${name} (via hooks, ${what}, ${how})`),
      );
    }
    return;
  }
  const what = r.wasBusy ? "interrupted a busy run" : "pi was idle";
  const runs = r.runs !== undefined ? `, runs ${r.runs}` : "";
  const receipt = r.receipt === undefined ? "" : "; no reply, but its receipt confirms it landed";
  console.log(
    pc.dim(`sent ${Buffer.byteLength(text)} bytes to ${name} (via ctl, ${what}${runs}${receipt})`),
  );
  if (r.pending) console.log(pc.yellow("queued messages went back to the pane's editor unsent"));
}
