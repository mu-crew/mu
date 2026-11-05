// mu — `mu agent answer <name> <choice...>`: type a pending permission
// dialog's answer into an agent's pane (spec D4). Kept out of
// src/cli/agents.ts, which is past its cap.

import type { Command } from "commander";
import { answerAgent } from "../agents.js";
import { ANSWER_KEY_NAMES } from "../channels/index.js";
import {
  assertAgentInWorkstream,
  emitJson,
  handle,
  JSON_OPT,
  resolveEntityRef,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { say } from "../messages.js";
import { pc } from "../output.js";

export async function cmdAnswer(
  db: Db,
  rawName: string,
  keys: readonly string[],
  opts: { workstream?: string; json?: boolean; force?: boolean } = {},
): Promise<void> {
  // One short line per key: a newline would submit whatever sits in the input box.
  if (keys.length === 0 || keys.some((k) => k === "" || /[\r\n]/.test(k))) {
    throw new UsageError(say("agent.answer_keys"));
  }
  const { name, workstream: ws } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const r = await answerAgent(db, name, keys, {
    workstream: ws,
    ...(opts.force ? { force: true } : {}),
  });
  if (opts.json) {
    emitJson({ agentName: name, transport: r.transport, keys: r.keys, ack: r.ack });
    return;
  }
  const how = `via ${r.transport}, ${r.ack === "confirmed" ? "confirmed by the next event" : "unconfirmed"}`;
  console.log(pc.dim(`answered ${name} with ${r.keys.join(" ")} (${how})`));
  if (r.ack !== "confirmed") {
    console.error(pc.yellow(`warning: ${say("agent.answer_unconfirmed", name, ws)}`));
  }
}

export function wireAnswerCommand(agent: Command): void {
  agent
    .command("answer <name> <choice...>")
    .description(
      `Type a pending permission dialog's answer into a hook harness's pane (1, y, n; ${ANSWER_KEY_NAMES.slice(0, 4).join(", ")} and arrows go as keys). Refused unless the agent reads blocked; confirmed by its next hook event.`,
    )
    .option("--force", "type the keys even when the agent does not read blocked")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string, choice: string[]) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        force?: boolean;
      };
      return handle((db) => cmdAnswer(db, name, choice, opts), this as Command)();
    });
}
