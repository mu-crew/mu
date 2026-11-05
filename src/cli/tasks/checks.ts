// mu — `mu task check` and `mu task verdict` (spec D5): record a check a
// native subagent or a cross-family pane runs, and its verdict.
//
//   mu task check <id> --by <harness>/<model> --brief -     prints check=<id>
//   mu task verdict <id> --check <check id> -              VERDICT/EVIDENCE lines

import { issueCheck, recordCheckVerdict } from "../../checks.js";
import { assertTaskInWorkstream, emitJson, resolveEntityRef } from "../../cli.js";
import type { Db } from "../../db.js";
import { pc } from "../../output.js";
import { resolveActorIdentity } from "../../tasks.js";
import { UsageError } from "../handle.js";
import { readStdinText, STDIN_ARG } from "../stdin.js";

async function resolveTask(
  db: Db,
  rawId: string,
  opts: { workstream?: string },
): Promise<{ localId: string; workstream: string }> {
  const { name, workstream } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, name, opts.workstream);
  return { localId: name, workstream };
}

export async function cmdTaskCheck(
  db: Db,
  rawId: string,
  opts: { by?: string; brief?: string; workstream?: string; json?: boolean },
): Promise<void> {
  if (opts.by === undefined) throw new UsageError("check needs --by <harness>/<model>");
  if (opts.brief === undefined) {
    throw new UsageError("check needs --brief <text> (or `-` and a heredoc on stdin)");
  }
  const { localId, workstream } = await resolveTask(db, rawId, opts);
  const brief = opts.brief === STDIN_ARG ? await readStdinText("--brief") : opts.brief;
  const check = issueCheck(db, localId, {
    workstream,
    by: opts.by,
    brief,
    author: await resolveActorIdentity(),
  });
  if (opts.json) return emitJson({ taskName: localId, check });
  console.log(`check=${check.id}`);
}

export async function cmdTaskVerdict(
  db: Db,
  rawId: string,
  text: string | undefined,
  opts: { check?: string; workstream?: string; json?: boolean },
): Promise<void> {
  if (opts.check === undefined) throw new UsageError("verdict needs --check <check id>");
  if (text === undefined) {
    throw new UsageError("verdict needs the VERDICT/EVIDENCE text (or `-` and a heredoc on stdin)");
  }
  const { localId, workstream } = await resolveTask(db, rawId, opts);
  const verdict = text === STDIN_ARG ? await readStdinText("verdict") : text;
  const r = recordCheckVerdict(db, localId, {
    workstream,
    check: opts.check,
    verdict,
    author: await resolveActorIdentity(),
  });
  if (opts.json) return emitJson({ taskName: localId, ...r });
  const label = r.check.label ?? "UNVERIFIED";
  if (!r.changed) {
    console.log(pc.dim(`check=${r.check.id} verdict=${label} (already recorded; no-op)`));
    return;
  }
  console.log(
    `check=${r.check.id} verdict=${label}${r.replaced ? " (replaced the earlier verdict)" : ""}`,
  );
}
