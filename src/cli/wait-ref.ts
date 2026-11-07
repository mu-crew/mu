// mu — `mu wait`'s ref grammar: `task:[ws/]id`, `agent:[ws/]name[@runs][#incarnation]`,
// `delegate:<call id>`. Moved out of src/cli/wait.ts (the run and the commander wiring) under the
// 800-line refactor line; `mu wait` and `mu task wait` (src/cli/tasks/claim.ts) parse with it.

import { getAgent } from "../agents.js";
import {
  checkQualifiedPrefix,
  parseQualifiedRef,
  resolveExistingWorkstream,
  UsageError,
} from "../cli.js";
import type { Db } from "../db.js";
import { DelegateNotFoundError, getDelegateCall } from "../delegates.js";
import { TaskNotFoundError } from "../tasks/errors.js";
import { getTask } from "../tasks/queries.js";
import type { WaitRef } from "../wait.js";

/** The typed ref spellings, for usage messages. */
export const TYPED_FORMS =
  "task:[<ws>/]<id>, agent:[<ws>/]<name>[@<runs>][#<incarnation>], delegate:<call id>";

/**
 * One typed ref. A bare word is refused (it could be a task or an agent) with the
 * spelling that names it; a typo'd workstream or id is the same error the other
 * verbs give, before anything waits.
 */
export async function parseWaitRef(
  db: Db,
  raw: string,
  scope: string | undefined,
  legacy: { afterRuns?: number; inc?: string } = {},
): Promise<WaitRef> {
  const colon = raw.indexOf(":");
  const kind = colon === -1 ? "" : raw.slice(0, colon);
  if (kind !== "task" && kind !== "agent" && kind !== "delegate") {
    throw new UsageError(
      `ref ${JSON.stringify(raw)} is not typed: use ${TYPED_FORMS}` +
        (raw.includes(":") ? "" : ` (e.g. task:${raw} or agent:${raw})`),
      { showHelp: false },
    );
  }
  let rest = raw.slice(colon + 1);
  if (rest === "")
    throw new UsageError(`ref ${JSON.stringify(raw)} names nothing`, { showHelp: false });
  if (kind === "delegate") {
    const call = getDelegateCall(db, rest);
    if (call === undefined) throw new DelegateNotFoundError(rest);
    return { kind, workstream: call.workstream, id: rest };
  }
  let afterRuns = legacy.afterRuns;
  let incarnation = legacy.inc;
  if (kind === "agent") {
    const hash = rest.indexOf("#");
    if (hash !== -1) {
      incarnation = rest.slice(hash + 1);
      rest = rest.slice(0, hash);
      if (incarnation === "")
        throw new UsageError(`ref ${JSON.stringify(raw)}: empty #incarnation`, { showHelp: false });
    }
    const at = rest.lastIndexOf("@");
    if (at !== -1) {
      const n = rest.slice(at + 1);
      if (!/^\d+$/.test(n)) {
        throw new UsageError(`ref ${JSON.stringify(raw)}: @<runs> must be a whole number`, {
          showHelp: false,
        });
      }
      afterRuns = Number(n);
      rest = rest.slice(0, at);
    }
  }
  const parsed = parseQualifiedRef(rest);
  const workstream =
    parsed.workstream !== undefined
      ? checkQualifiedPrefix(rest, parsed.workstream)
      : await resolveExistingWorkstream(db, scope);
  if (kind === "task") {
    if (getTask(db, parsed.name, workstream) === undefined) {
      throw new TaskNotFoundError(
        parsed.workstream !== undefined ? rest : parsed.name,
        workstream,
        parsed.name,
      );
    }
    return { kind, workstream, id: parsed.name };
  }
  if (getAgent(db, parsed.name, workstream) === undefined) {
    // The engine raises the typed AgentNotFoundError; say it before any wait starts.
    const { AgentNotFoundError } = await import("../agents/errors.js");
    throw new AgentNotFoundError(parsed.name);
  }
  return {
    kind,
    workstream,
    id: parsed.name,
    ...(afterRuns !== undefined ? { afterRuns } : {}),
    ...(incarnation !== undefined ? { incarnation } : {}),
  };
}
