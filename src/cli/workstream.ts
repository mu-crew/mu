// mu — `mu workstream` verbs (init / list / teardown).
//
// A workstream = one mux session (`mu-<name>`) + every DB row tagged
// with that name (agents / tasks / edges / notes / worktrees / logs).
// `init` creates the session + DB row pair; `list` shows
// every workstream on the machine; `teardown` is the symmetric inverse:
// soft (sets torn_down_at), previewed first, applied with `--if <rev>`.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { basename } from "node:path";
import { emitJson, parseNonNegativeInt, resolveWorkstream, UsageError } from "../cli.js";
import { type Db, tornDownAtOf } from "../db.js";
import { type AttachTarget, activeMux, attachShellLine, type MuxBackend } from "../mux.js";
import { muTable, pc } from "../output.js";
import {
  assertWorkstreamInitable,
  ensureWorkstream,
  listEmptyWorkstreams,
  listTornDownWorkstreams,
  listWorkstreams,
  previewReinit,
  reinitWorkstream,
  summarizeWorkstream,
  sweepRevision,
  teardownWorkstream,
  WorkstreamRevisionMismatchError,
  workstreamRevision,
} from "../workstream.js";
import { setNextOutcome } from "./handle.js";
import { clipPlain, clippedRecord, type PageOut, pageOut, shrinkItem } from "./page-records.js";

export async function cmdInit(
  db: Db,
  name: string,
  opts: { json?: boolean; if?: number } = {},
): Promise<void> {
  assertWorkstreamInitable(name, db);
  const sessionName = `mu-${name}`;
  // A torn-down name is reused only after a preview: init then hard-deletes
  // the old rows (one op group with the new row). Without --if it writes
  // nothing and creates no session.
  const reuse = previewReinit(db, name);
  if (reuse !== null && opts.if === undefined) {
    setNextOutcome({
      kind: "preview",
      apply: ["mu", "workstream", "init", name],
      revision: reuse.revision,
    });
    if (opts.json) {
      emitJson({
        workstreamName: name,
        created: false,
        dryRun: true,
        tornDownAt: reuse.tornDownAt,
        tasks: reuse.tasks,
        notes: reuse.notes,
        edges: reuse.edges,
        revision: reuse.revision,
      });
      return;
    }
    console.log(
      `will permanently delete torn-down ${name}: ${reuse.tasks} tasks, ${reuse.notes} notes; rev=${reuse.revision}`,
    );
    return;
  }
  if (reuse !== null && opts.if !== undefined) await reinitWorkstream(db, name, opts.if);
  const dbCreated = ensureWorkstream(db, name) || reuse !== null;
  // Load-bearing: `workstream init` IS session creation.
  const mux = await activeMux();
  // Creates the session with its placeholder `_mu` window, or repairs
  // a missing `_mu` (the operator killed it after the first spawn;
  // without it, tmux a -t mu-<ws> lands on an agent's pane instead of
  // the orchestration shell).
  // (review_bug_workstream_init_does_not_repair_missing_mu_window)
  const { created: sessionCreated, repaired: muWindowRepaired } =
    await mux.ensureSession(sessionName);
  const sessionAlready = !sessionCreated;
  const created = !sessionAlready || dbCreated;
  // Naming convention (docs/reference/naming.md): <project>-<purpose>,
  // so two repos never share `auth` and `workstream list` groups by project.
  const nameHint = name.includes("-")
    ? undefined
    : `name workstreams <project>-<purpose> (e.g. ${projectGuess() ?? "repo"}-${name}); one per effort`;
  const attach = await attachLine(mux, { session: sessionName });
  if (opts.json) {
    emitJson({
      workstreamName: name,
      muxSession: sessionName,
      created,
      muxSessionAlreadyExisted: sessionAlready,
      dbRowAlreadyExisted: !dbCreated,
      muWindowRepaired,
      ...(nameHint && created ? { hint: nameHint } : {}),
      ...(attach !== undefined ? { attach } : {}),
    });
    return;
  }
  if (sessionAlready && !dbCreated) {
    const repaired = muWindowRepaired ? ` — ${pc.yellow("repaired missing _mu window")}` : "";
    console.log(
      pc.dim(
        `workstream "${name}" already exists (mux session ${sessionName}, DB row registered)${repaired}`,
      ),
    );
    return;
  }
  console.log(`Created workstream ${pc.bold(name)} (mux session ${pc.bold(sessionName)})`);
  if (nameHint && created) console.log(pc.dim(`hint: ${nameHint}`));
  if (attach !== undefined) console.log(pc.dim(`attach: ${attach}`));
}

/** The attach line, or none when the backend cannot resolve the target
 *  (herdr: no such workspace): it is information, never a failure. */
async function attachLine(mux: MuxBackend, target: AttachTarget): Promise<string | undefined> {
  try {
    return attachShellLine(await mux.attachCommands(target));
  } catch {
    return undefined;
  }
}

/** The cwd's repo or folder name, lowercased into a workstream-legal slug. */
function projectGuess(): string | undefined {
  const base = basename(process.cwd())
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  return base === "" ? undefined : base;
}

/** Rows of `workstream list` and `--torn-down`, as text records or one capped JSON page. */
function emitWorkstreamPage(page: PageOut): void {
  if (page.data !== undefined) {
    emitJson(page.data);
    return;
  }
  for (const line of page.lines) console.log(line);
}

/** `item` with each named text field clipped to `scale` x its limit (cut counted); `whole` clips nothing. */
function clipFields<T extends object>(
  row: T,
  limits: { [K in keyof T]?: number },
  scale: number,
): { item: T; cut: number } {
  const item = { ...row };
  let cut = 0;
  for (const k of Object.keys(limits) as (keyof T)[]) {
    const v = item[k];
    if (typeof v !== "string") continue;
    const one = clipPlain(v, Math.floor((limits[k] ?? 0) * scale));
    item[k] = one.text as T[keyof T];
    cut += one.cut;
  }
  return { item, cut };
}

const SUMMARY_LIMITS = { name: 64, muxSession: 80 };
const TORN_DOWN_LIMITS = { name: 64, group: 64, at: 40 };

export async function cmdWorkstreamList(
  db: Db,
  opts: { json?: boolean; tornDown?: boolean; all?: boolean } = {},
): Promise<void> {
  const json = opts.json === true;
  const whole = opts.all === true;
  const retrieve = `mu workstream list${opts.tornDown === true ? " --torn-down" : ""} --all${json ? " --json" : ""}`;
  // `--torn-down` answers a DIFFERENT question ("what did I remove, and
  // how do I get it back") from the torn-down rows plus the ops log (old
  // hard teardowns), so it replaces the listing instead of adding rows to it.
  // Mixing the two would need a status column on every row to say which
  // half each came from.
  if (opts.tornDown === true) {
    const gone = listTornDownWorkstreams(db);
    if (gone.length === 0 && !json) {
      console.log(pc.dim("no torn-down workstreams"));
      return;
    }
    // One record per teardown: `group` is the only actionable column
    // (`mu log --group <group>`), so it leads after the name, in full.
    emitWorkstreamPage(
      pageOut(gone, {
        json,
        whole,
        singleRetrieve: true,
        text: (r, all) =>
          clippedRecord(
            ["torn-down", r.name, r.group, r.at, r.kind === "soft" ? "kept" : "deleted"],
            `tasks=${r.tasks} edges=${r.edges} notes=${r.notes}${r.recreated ? " recreated" : ""}`,
            all,
          ),
        item: (r, all) =>
          all ? { item: r, cut: 0 } : shrinkItem((scale) => clipFields(r, TORN_DOWN_LIMITS, scale)),
        resume: () => retrieve,
      }),
    );
    return;
  }
  const summaries = await listWorkstreams(db);
  if (summaries.length === 0 && !json) {
    console.log(pc.dim("no workstreams found"));
    return;
  }
  emitWorkstreamPage(
    pageOut(summaries, {
      json,
      whole,
      singleRetrieve: true,
      text: (r, all) =>
        clippedRecord(
          ["workstream", r.name, r.muxAlive ? "alive" : "-"],
          `agents=${r.agentCount} tasks=${r.taskCount} edges=${r.edgeCount} notes=${r.noteCount}`,
          all,
        ),
      item: (r, all) =>
        all ? { item: r, cut: 0 } : shrinkItem((scale) => clipFields(r, SUMMARY_LIMITS, scale)),
      resume: () => retrieve,
    }),
  );
}

export async function cmdTeardown(
  db: Db,
  opts: {
    workstream?: string;
    if?: number;
    json?: boolean;
    empty?: boolean;
  },
): Promise<void> {
  if (opts.empty) {
    await cmdTeardownEmpty(db, opts);
    return;
  }
  const workstream = await resolveWorkstream(opts.workstream);
  const summary = await summarizeWorkstream(db, { workstream });
  const tornDownAt = tornDownAtOf(db, workstream);
  const hasLocalState = summary.muxAlive || summary.agentCount > 0;
  // Already torn down with nothing local left: a no-op. A torn-down name
  // that still has agents or a session here (a peer tore it down)
  // IS worth finishing locally, so it falls through.
  // Empty-but-registered workstreams (a row in `workstreams` with no
  // agents/tasks/etc.) ARE worth tearing down — otherwise the bare
  // registry row is orphaned forever. nothingToDo is the strict
  // intersection: nothing on disk, in mux, OR in the DB.
  const nothingToDo =
    tornDownAt !== null
      ? !hasLocalState
      : !summary.muxAlive &&
        !summary.registered &&
        summary.agentCount === 0 &&
        summary.taskCount === 0 &&
        summary.noteCount === 0 &&
        summary.worktreeCount === 0;

  if (nothingToDo) {
    const reason =
      tornDownAt !== null ? `already torn down (at ${tornDownAt})` : "nothing to tear down";
    if (opts.json) {
      emitJson({ workstreamName: workstream, tornDown: false, reason, summary });
      return;
    }
    console.log(
      pc.dim(
        tornDownAt !== null
          ? `workstream "${workstream}" is already torn down (at ${tornDownAt}); nothing left on this machine`
          : `workstream "${workstream}" has no mux session and no DB rows; nothing to tear down`,
      ),
    );
    return;
  }

  const revision = workstreamRevision(db, workstream);
  if (opts.if === undefined) {
    setNextOutcome({
      kind: "preview",
      apply: ["mu", "workstream", "teardown", workstream],
      revision,
    });
    if (opts.json) {
      emitJson({
        workstreamName: workstream,
        tornDown: false,
        dryRun: true,
        revision,
        summary,
      });
      return;
    }
    console.log(pc.bold(`Workstream ${workstream} (mux session ${summary.muxSession})`));
    console.log(
      `  mux session  : ${summary.muxAlive ? pc.yellow("alive (will be killed)") : pc.dim("not running")}`,
    );
    console.log(`  agents       : ${summary.agentCount}`);
    console.log(
      `  tasks        : ${summary.taskCount}  (edges: ${summary.edgeCount}, notes: ${summary.noteCount}; kept)`,
    );
    console.log(
      `  worktrees    : ${summary.worktreeCount}${summary.worktreeCount > 0 ? pc.dim(" (kept: teardown never removes one)") : ""}`,
    );
    console.log(`  rev=${revision}`);
    console.log("");
    console.log(pc.dim("(preview; nothing changed. Apply with --if <rev>)"));
    return;
  }

  const result = await teardownWorkstream(db, { workstream, ifRevision: opts.if });
  if (opts.json) {
    emitJson({
      workstreamName: workstream,
      tornDown: true,
      ...result,
    });
    return;
  }
  console.log(pc.bold(`Workstream ${workstream} (mux session ${summary.muxSession})`));
  console.log(
    `  mux session  : ${summary.muxAlive ? pc.yellow("alive (will be killed)") : pc.dim("not running")}`,
  );
  console.log(`  agents       : ${summary.agentCount}`);
  console.log(
    `  tasks        : ${summary.taskCount}  (edges: ${summary.edgeCount}, notes: ${summary.noteCount}; kept)`,
  );
  console.log(`  worktrees    : ${summary.worktreeCount} (kept)`);
  console.log("");
  console.log(
    `Tore down ${pc.bold(workstream)}: killed mux=${result.killedMux}, agents=${result.deletedAgents}; kept tasks=${result.tasks}, edges=${result.edges}, notes=${result.notes}, worktrees=${result.keptWorktrees.length}`,
  );
  if (result.orphanedAgents.length > 0) {
    console.log("");
    console.log(
      pc.yellow(
        `KEPT ${result.orphanedAgents.length} agent row(s): the recorded pane is still alive (or could not be checked): ${result.orphanedAgents.map((o) => `${o.name} (${o.paneId})`).join(", ")}`,
      ),
    );
    for (const o of result.orphanedAgents) {
      console.log(
        pc.dim(
          `  once its pane is gone, preview its close: mu agent close ${o.name} -w ${workstream}`,
        ),
      );
    }
  }
  if (result.keptWorktrees.length > 0) {
    console.log("");
    console.log(pc.yellow("Worktrees are never removed by teardown; they are still registered:"));
    for (const w of result.keptWorktrees) {
      console.log(
        `  - ${w.agent}: ${w.path} (preview its close: mu agent close ${w.agent} -w ${workstream})`,
      );
    }
  }
}

// ─── cmdTeardownEmpty ─────────────────────────────────────────────────
//
// `mu workstream teardown --empty` sweeps every workstream with no
// user-meaningful state (zero tasks, agents, worktrees), except
// `scratch`, whose idle session is kept alive on purpose. It never
// sweeps an unregistered `mu-*` session: with no DB row there is no
// evidence it is idle (see listEmptyWorkstreams); the human output
// names them so the operator can tear one down explicitly.
// Each workstream's teardown is its own op group
// (`mu workstream list --torn-down` lists the groups). Without `--if` it
// previews the set and prints the sweep revision; `--empty --if <rev>`
// recomputes the revision (a member added, removed or changed refuses the
// sweep), then tears each down with the revision it had in that snapshot.
// Per-workstream teardown errors are accumulated into a `failed` array
// so a single bad pane doesn't abort the rest of the cleanup. See
// workstream_destroy_empty_sweep.

interface EmptyTeardownResult {
  workstreamName: string;
  killedMux: boolean;
  deletedAgents: number;
}

interface EmptyDestroyFailure {
  workstreamName: string;
  error: string;
}

/** Read created_at for a registered workstream; the empty string when
 *  the row is gone (keeps the signature total). */
function workstreamCreatedAt(db: Db, name: string): string {
  const row = db.prepare("SELECT created_at FROM workstreams WHERE name = ?").get(name) as
    | { created_at: string }
    | undefined;
  return row?.created_at ?? "";
}

async function cmdTeardownEmpty(
  db: Db,
  opts: {
    workstream?: string;
    if?: number;
    json?: boolean;
  },
): Promise<void> {
  // --empty is a sweep verb; -w (target a single workstream)
  // contradicts it. Fail loud with exit 2 (UsageError) so a typo
  // (`--empty -w foo`) doesn't silently sweep instead of targeting
  // `foo`.
  if (opts.workstream !== undefined) {
    throw new UsageError(
      "--empty is mutually exclusive with a named target (positional <name> or -w/--workstream): the sweep targets every empty workstream, so naming one contradicts it",
    );
  }
  const empties = await listEmptyWorkstreams(db);
  // One snapshot: the sweep revision is the hash of exactly these member
  // revisions, and the apply below passes each member ITS snapshot revision,
  // never a fresh one (a fresh read would bless a change made since the
  // preview).
  const snapshot = new Map(empties.map((e) => [e.name, workstreamRevision(db, e.name)]));
  const revision = sweepRevision(snapshot);

  if (opts.if === undefined) {
    if (empties.length > 0) {
      setNextOutcome({
        kind: "preview",
        apply: ["mu", "workstream", "teardown", "--empty"],
        revision,
      });
    }
    if (opts.json) {
      emitJson({ items: empties, count: empties.length, revision });
      return;
    }
    if (empties.length === 0) {
      console.log(pc.dim("no empty workstreams found"));
      return;
    }
    const table = muTable({
      head: ["workstream", "created_at", "mux"].map((h) => pc.bold(h)),
      colWidths: [40, null, null],
    });
    for (const ws of empties) {
      const createdAt = workstreamCreatedAt(db, ws.name);
      // Em-dash if the row vanished between list and render, so the
      // column never goes visually empty (matches the mux column).
      const createdCell = createdAt === "" ? pc.dim("\u2014") : pc.dim(createdAt);
      table.push([ws.name, createdCell, ws.muxAlive ? pc.green("alive") : pc.dim("\u2014")]);
    }
    console.log(table.toString());
    console.log("");
    console.log(
      pc.dim(
        `${empties.length} empty workstream${empties.length === 1 ? "" : "s"} would be torn down (preview; rev=${revision}).`,
      ),
    );
    return;
  }

  // --if path: the set must be the one that was previewed.
  if (opts.if !== revision) {
    throw new WorkstreamRevisionMismatchError(
      "(empty sweep)",
      opts.if,
      revision,
      "mu workstream teardown --empty",
    );
  }
  // No-op early if there's nothing to do.
  if (empties.length === 0) {
    if (opts.json) {
      emitJson({ tornDown: 0, results: [], failed: [] });
      return;
    }
    console.log(pc.dim("no empty workstreams found; nothing to tear down"));
    return;
  }

  const results: EmptyTeardownResult[] = [];
  const failed: EmptyDestroyFailure[] = [];
  for (const ws of empties) {
    try {
      // The member's snapshot revision, checked again inside its own
      // commit transaction: a change made while an earlier member was being
      // torn down refuses this one.
      const result = await teardownWorkstream(db, {
        workstream: ws.name,
        ifRevision: snapshot.get(ws.name) ?? 0,
      });
      results.push({
        workstreamName: ws.name,
        killedMux: result.killedMux,
        deletedAgents: result.deletedAgents,
      });
    } catch (err) {
      // Best-effort sweep: log the failure and keep going. Every
      // workstream torn down before or after this one wrote its own
      // op group, so a half-completed sweep leaves no partial state.
      failed.push({
        workstreamName: ws.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (opts.json) {
    emitJson({ tornDown: results.length, results, failed });
    return;
  }
  for (const r of results) {
    console.log(
      `Tore down ${pc.bold(r.workstreamName)} ${pc.dim(
        `(killedMux=${r.killedMux}, agents=${r.deletedAgents})`,
      )}`,
    );
  }
  if (failed.length > 0) {
    console.log("");
    console.log(
      pc.yellow(
        `WARNING: ${failed.length} workstream${failed.length === 1 ? "" : "s"} could not be torn down cleanly:`,
      ),
    );
    for (const f of failed) {
      console.log(`  - ${f.workstreamName}: ${f.error}`);
    }
  }
  console.log("");
  console.log(pc.dim(`Sweep complete: tornDown=${results.length}, failed=${failed.length}.`));
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireWorkstreamCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { handle, JSON_OPT, WORKSTREAM_OPT } from "../cli.js";

/** Fold an optional positional workstream name into the opts bag.
 *
 *  dogfood-destroy-w-flag: `workstream init` takes its target
 *  POSITIONALLY while `teardown` only took `-w`, so
 *  `mu workstream teardown v2 --yes` printed help ("too many
 *  arguments") instead of tearing down. The positional is now an
 *  additive ALIAS for -w on both verbs; -w keeps working unchanged.
 *  Supplying both is a usage error rather than a silent pick-one.
 *
 *  Codifies the CLI's flag-vs-positional rule: the primary entity a
 *  verb acts on is positional; everything else is a flag. See
 *  docs/reference/naming.md. */
export function withPositionalWorkstream<T extends { workstream?: string }>(
  opts: T,
  name: string | undefined,
): T {
  if (name === undefined) return opts;
  if (opts.workstream !== undefined && opts.workstream !== name) {
    throw new UsageError(
      `workstream given twice and they disagree: positional ${JSON.stringify(name)} vs -w ${JSON.stringify(opts.workstream)}; pass it once`,
      { showHelp: false },
    );
  }
  return { ...opts, workstream: name };
}

export function wireWorkstreamCommands(program: Command): void {
  const workstream = program
    .command("workstream")
    .description(
      "Workstream-level commands. Name them <project>-<purpose> (hail-auth), one per effort; tear down when it ships. Reviews nobody will track belong in scratch delegates, not a workstream.",
    );

  workstream
    .command("init <name>")
    .description(
      "Create the workstream's mux session and register it in the DB. Name it <project>-<purpose>. A torn-down name is previewed first (it permanently deletes the old rows); apply with --if <rev>.",
    )
    .option("--if <rev>", "the revision from the preview", parseNonNegativeInt)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { json?: boolean; if?: number };
      return handle((db) => cmdInit(db, name, opts), this as Command)();
    });

  workstream
    .command("list")
    .description("List every registered workstream on this machine")
    .option(
      "--torn-down",
      "instead list torn-down workstreams (and pre-cut-over teardowns from the ops log), with the op group id (`mu log --group <id>`)",
    )
    .option("--all", "every workstream, uncapped (a list is capped at 4 KB; a cut names this)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        json?: boolean;
        tornDown?: boolean;
        all?: boolean;
      };
      return handle((db) => cmdWorkstreamList(db, opts), this as Command)();
    });

  workstream
    .command("teardown [name]")
    .description(
      "Soft teardown: kill the mux session, delete agent rows, mark the workstream torn down (tasks, notes, worktrees stay). Without --if it previews `rev=<n>`; apply with --if <n>. --empty sweeps empty workstreams, never scratch.",
    )
    .option(...WORKSTREAM_OPT)
    .option("--if <rev>", "apply the preview with this revision", parseNonNegativeInt)
    .option(
      "--empty",
      "sweep every empty workstream (zero tasks, agents, worktrees); never scratch; mutually exclusive with -w",
    )
    .option(...JSON_OPT)
    .action(function (name: string | undefined) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        if?: number;
        json?: boolean;
        empty?: boolean;
      };
      return handle(
        (db) => cmdTeardown(db, withPositionalWorkstream(opts, name)),
        this as Command,
      )();
    });
}
