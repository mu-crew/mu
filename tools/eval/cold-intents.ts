// Cold-guess intents (e_cold_guess): short things an orchestrator really asks of mu. Each has a seed
// (what the sandbox holds before the guess), a judge that reads STATE and the guess's own output
// (never its spelling), and one golden command per surface family plus one plausible-but-wrong bad,
// so `cold-guess check` proves the judge before any model is paid for.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostProfile, seedNotes, seedViaMu, shq, sshShim, writeWorkerDriver } from "./fixtures.ts";
import type { OpRow } from "./ops.ts";
import { openProbe } from "./probe.ts";
import { mu, sh } from "./sandbox.ts";
import type { Family, Sandbox } from "./types.ts";

export const WS = "auth";

/** The guess's own execution, as the judge sees it. */
export interface GuessRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ColdCtx {
  sb: Sandbox;
  family: Family;
  run: GuessRun;
  /** ops.maxSeq right after the seed: every op after it is the guess's. */
  base: number;
  /** What the seed recorded (a sha, a path). */
  state: Record<string, string>;
}

export interface ColdEffect {
  hit: boolean;
  /** Right direction, effect not complete (e.g. a two-step close previewed but not applied). */
  partial?: boolean;
  why: string[];
}

export interface ColdIntent {
  id: string;
  /** The verb family it exercises, for the per-surface table. */
  group: "tasks" | "agents" | "state" | "log" | "db" | "host" | "workstream" | "delegates";
  /**
   * The request, in words that name no command, subcommand or flag of either surface
   * (`neutralityLeaks` in cold-guess.ts fails a run otherwise): a cold reader finds the verb in
   * --help, not in us.
   */
  text: string;
  /** Data the request quotes verbatim (a SQL statement, a piece of evidence): exempt from that lint. */
  payload?: string;
  /**
   * `headline`: pre-registered, counted in the headline comparison. `control`: added to separate one
   * cause of a miss from another; reported apart, never in the headline.
   */
  role: "headline" | "control";
  /** Families that have a way to do it at all (delegates exist only on next). */
  families: Family[];
  seed(sb: Sandbox, family: Family): Promise<Record<string, string>>;
  judge(ctx: ColdCtx): Promise<ColdEffect>;
  /** Ops the intent legitimately writes; anything else is a stray (collateral). Default: none. */
  allow?: (o: OpRow) => boolean;
  golden: Record<Family, string>;
  /** A plausible wrong guess both families run; must be flagged. */
  bad: string;
}

// ---- seed helpers ------------------------------------------------------------------------------

const add = (id: string, title: string, impact = 50, extra: string[] = []): string[] => [
  "task",
  "add",
  id,
  "-w",
  WS,
  "-t",
  title,
  "-i",
  String(impact),
  "-e",
  "1",
  ...extra,
];
const init = (): string[] => ["workstream", "init", WS];

/** A pane that prints `mark` and sleeps: an agent mu can list, show and read, with no pi in it. */
async function pane(
  sb: Sandbox,
  name: string,
  mark: string,
  extra: string[] = [],
): Promise<string> {
  const r = await mu(sb, [
    "agent",
    "spawn",
    name,
    "-w",
    WS,
    "--command",
    `sh -c 'echo ${mark}; exec sleep 3600'`,
    "--no-ctl",
    ...extra,
  ]);
  if (r.code !== 0) throw new Error(`seed spawn ${name} failed: ${r.stderr || r.stdout}`);
  return /^\s+(?:workspace|cwd): (\S+)/m.exec(r.stdout)?.[1] ?? "";
}

const hostRoot = (sb: Sandbox): string => join(sb.dir, "hosts", "dev");
const worktreeFlag = (f: Family): string => (f === "next" ? "--worktree" : "--workspace");

/** One commit in `dir` (a file change, so it is real work); returns its sha. */
async function commitIn(sb: Sandbox, dir: string, file: string): Promise<string> {
  await sh(
    sb,
    `cd ${shq(dir)} && echo ${file} > ${file}.txt && git add ${file}.txt && git commit -qm ${file}`,
  );
  return (await sh(sb, `git -C ${shq(dir)} rev-parse HEAD`)).stdout.trim();
}

/** The ssh host "dev" (the eval shim) with its mu-next profile; the 3.x family spells ssh itself. */
async function devHost(sb: Sandbox, f: Family): Promise<void> {
  await sshShim(sb, { host: "dev" });
  if (f === "next") await hostProfile(sb, "dev");
  await writeWorkerDriver(sb);
}

// The 3.x spelling of a remote spawn (remote_spawn.golden.3x.json).
const SPAWN_3X = (name: string): string =>
  `ssh dev 'git -C ~/repo worktree add ~/ws/${name}' && eval "$(mu agent remote-env ${name} -w ${WS} --shell)"; ` +
  `mu agent spawn ${name} -w ${WS} --command "ssh $MU_SSH_ARGS dev -t 'cd ~/ws/${name} && $MU_REMOTE_ENV \\$SHELL -ilc \\"pi --approve\\"'"`;

// ---- judge helpers -----------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
export const ANSI = /\x1b\[[0-9;]*m/g;
const out = (c: ColdCtx): string => c.run.stdout.replace(ANSI, "");
const word = (text: string, w: string): boolean =>
  new RegExp(
    `(^|[^A-Za-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
  ).test(text);

const done = (why: string[]): ColdEffect => ({ hit: why.length === 0, why });

/** A read that must print `must` tokens and none of `mustNot`, exit 0. */
function reads(c: ColdCtx, must: string[], mustNot: string[] = []): ColdEffect {
  const text = out(c);
  const why: string[] = [];
  if (c.run.timedOut) why.push("timed out");
  else if (c.run.code !== 0) why.push(`exit ${c.run.code}`);
  for (const m of must) if (!word(text, m) && !text.includes(m)) why.push(`output lacks ${m}`);
  for (const m of mustNot) if (word(text, m)) why.push(`output has ${m}`);
  return done(why);
}

/** Records of an output: its lines, and the objects of one JSON line. */
const records = (text: string): string[] => text.split("\n").flatMap((l) => l.split("},{"));
const isOpenRecord = (r: string): boolean => !/CLOSED/.test(r);

/** A read that lists open tasks: each of `must` in a record that is not CLOSED, none of `mustNot` in one. */
function listsOpen(c: ColdCtx, must: string[], mustNot: string[]): ColdEffect {
  const open = records(out(c)).filter(isOpenRecord);
  const why: string[] = [];
  if (c.run.timedOut) why.push("timed out");
  else if (c.run.code !== 0) why.push(`exit ${c.run.code}`);
  for (const m of must) if (!open.some((r) => word(r, m))) why.push(`${m} not listed`);
  for (const m of mustNot) if (open.some((r) => word(r, m))) why.push(`output has open ${m}`);
  return done(why);
}

const taskKey = (o: OpRow): string => o.key.split("#")[0] ?? o.key;
const onTasks =
  (...ids: string[]) =>
  (o: OpRow): boolean =>
    ids.some((i) => taskKey(o) === `${WS}/${i}`);

/** Whether `sha` is still reachable: a ref contains it, or a worktree still holds it. */
async function reachable(sb: Sandbox, sha: string): Promise<boolean> {
  const refs = await sh(sb, `git for-each-ref --contains ${sha} --format='%(refname)'`, {
    allowFail: true,
  });
  if (refs.stdout.trim() !== "") return true;
  const trees = await sh(sb, "git worktree list --porcelain", { allowFail: true });
  for (const l of trees.stdout.split("\n")) {
    const p = l.startsWith("worktree ") ? l.slice(9) : "";
    if (p === "" || p === sb.repoDir || !existsSync(p)) continue;
    const head = await sh(sb, `git -C ${shq(p)} rev-parse HEAD`, { allowFail: true });
    if (head.stdout.trim() === sha) return true;
  }
  return false;
}

// ---- the intents -------------------------------------------------------------------------------

const PROOF = "gate green: npm test exit 0";
const SQL = "SELECT local_id, title FROM tasks WHERE impact = 77";
const BRIEF_END = "BRIEF-END-7731";
const LOGS = 24;
const log = (i: number): string => `LOGREC-${String(i).padStart(2, "0")}`;
const ALL: Family[] = ["3x", "next"];

export const INTENTS: ColdIntent[] = [
  {
    id: "owner_of",
    group: "tasks",
    text: "Which worker is assigned t3 in the initiative called auth?",
    role: "headline",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [
        init(),
        add("t3", "implement-token-refresh"),
        add("t4", "other"),
        ["agent", "spawn", "worker-1", "-w", WS, "--command", "sleep 3600", "--no-ctl"],
        ["agent", "spawn", "worker-2", "-w", WS, "--command", "sleep 3600", "--no-ctl"],
        ["task", "claim", "t3", "-w", WS, "--for", "worker-1"],
        ["task", "claim", "t4", "-w", WS, "--for", "worker-2"],
      ]);
      return {};
    },
    judge: async (c) => reads(c, ["t3", "worker-1"]),
    golden: { "3x": `mu task show t3 -w ${WS}`, next: `mu task show t3 -w ${WS}` },
    bad: `mu agent list -w ${WS}`,
  },
  {
    id: "task_brief",
    group: "tasks",
    text: "Print the original brief that t3 in the initiative called auth was given.",
    role: "headline",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t3", "implement-token-refresh")]);
      await seedNotes(sb, WS, "t3", [
        `BRIEF ${"abcdefghij".repeat(40)} ${BRIEF_END}`,
        "LATE-NOTE later",
      ]);
      return {};
    },
    judge: async (c) => reads(c, [BRIEF_END]),
    golden: { "3x": `mu task notes t3 -w ${WS}`, next: `mu task show t3 -w ${WS} --note 1` },
    bad: `mu task list -w ${WS}`,
  },
  {
    id: "blocked_by_t1",
    group: "tasks",
    text: "Which unfinished items in the initiative called auth are held up by t1?",
    role: "headline",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [
        init(),
        add("t1", "root", 80),
        add("t2", "first dependent", 50, ["-b", "t1"]),
        add("t7", "second dependent", 40, ["-b", "t1"]),
        add("t8", "dropped dependent", 40, ["-b", "t1"]),
        add("t5", "unrelated"),
        add("t4", "unrelated too"),
        ["task", "close", "t8", "-w", WS, "--as", "wontfix", "--why", "seed"],
      ]);
      return {};
    },
    judge: async (c) => listsOpen(c, ["t2", "t7"], ["t8", "t5", "t4"]),
    golden: {
      "3x": `mu sql "SELECT local_id FROM blocked WHERE blocker_id = 't1'" -w ${WS} || mu task tree t1 -w ${WS} --down`,
      next: `mu task tree t1 -w ${WS} --down`,
    },
    bad: `mu task list -w ${WS}`,
  },
  {
    id: "close_with_evidence",
    group: "tasks",
    text: `Declare t4 in the initiative called auth complete; the proof is: ${PROOF}.`,
    role: "headline",
    payload: PROOF,
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t4", "close me"), add("t5", "leave me")]);
      return {};
    },
    allow: onTasks("t4"),
    async judge(c) {
      const t = openProbe(c.sb).task(WS, "t4");
      const notes = openProbe(c.sb).notes(WS, "t4").join("\n");
      const why: string[] = [];
      if (t?.status !== "CLOSED" || t.substate !== "done")
        why.push(`t4 is ${t?.status}/${t?.substate}`);
      if (!notes.includes(PROOF)) why.push("evidence not recorded");
      return done(why);
    },
    golden: {
      "3x": `mu task close t4 -w ${WS} --evidence '${PROOF}'`,
      next: `mu task close t4 -w ${WS} --evidence '${PROOF}'`,
    },
    bad: `mu task close t5 -w ${WS} --evidence '${PROOF}'`,
  },
  {
    id: "spawn_remote",
    group: "host",
    text: "Launch a worker for t5 (initiative called auth) on the other machine dev, so that it works there.",
    role: "headline",
    families: ALL,
    async seed(sb, f) {
      await seedViaMu(sb, [init(), add("t5", "remote job")]);
      await devHost(sb, f);
      return {};
    },
    // the spawn, its send and its claim are the intent
    allow: (o) => o.intent?.startsWith("agent.") === true || onTasks("t5")(o),
    async judge(c) {
      const agents = openProbe(c.sb).agents(WS);
      const sessions = await sh(c.sb, `cat ${shq(join(hostRoot(c.sb), "sessions.log"))}`, {
        allowFail: true,
      });
      const why: string[] = [];
      if (agents.length === 0) why.push("no agent registered");
      if (!/pane=%\d+/.test(sessions.stdout)) why.push("no pane session on dev");
      return done(why);
    },
    golden: {
      "3x": SPAWN_3X("worker-1"),
      next: `mu agent spawn worker-1 -w ${WS} --host dev --worktree --task t5 --send 'do t5'`,
    },
    bad: `mu agent spawn worker-1 -w ${WS}`,
  },
  {
    id: "spawn_remote_named",
    group: "host",
    text: "Launch a worker called worker-1 for t5 (initiative called auth) on the other machine dev, so that it works there.",
    role: "control",
    families: ALL,
    async seed(sb, f) {
      await seedViaMu(sb, [init(), add("t5", "remote job")]);
      await devHost(sb, f);
      return {};
    },
    // the spawn, its send and its claim are the intent
    allow: (o) => o.intent?.startsWith("agent.") === true || onTasks("t5")(o),
    async judge(c) {
      const agents = openProbe(c.sb).agents(WS);
      const sessions = await sh(c.sb, `cat ${shq(join(hostRoot(c.sb), "sessions.log"))}`, {
        allowFail: true,
      });
      const why: string[] = [];
      if (agents.length === 0) why.push("no agent registered");
      if (!/pane=%\d+/.test(sessions.stdout)) why.push("no pane session on dev");
      return done(why);
    },
    golden: {
      "3x": SPAWN_3X("worker-1"),
      next: `mu agent spawn worker-1 -w ${WS} --host dev --worktree --task t5 --send 'do t5'`,
    },
    bad: `mu agent spawn worker-1 -w ${WS}`,
  },
  {
    id: "collect_commits",
    group: "host",
    text: "Bring worker-2's unmerged work from machine dev into the git repository here; the worker belongs to the initiative called auth.",
    role: "headline",
    families: ALL,
    async seed(sb, f) {
      await seedViaMu(sb, [init()]);
      await devHost(sb, f);
      let dir: string;
      if (f === "next") {
        dir = await pane(sb, "worker-2", "W2", ["--host", "dev", "--worktree"]);
      } else {
        await sh(sb, SPAWN_3X("worker-2"));
        dir = join(hostRoot(sb), "home", "ws", "worker-2");
      }
      return { sha: await commitIn(sb, dir, "w2"), dir };
    },
    async judge(c) {
      const r = await sh(c.sb, `git cat-file -e ${c.state.sha}^{commit}`, { allowFail: true });
      return done(r.code === 0 ? [] : ["the worker's commit is not in this repo"]);
    },
    golden: {
      "3x": "git fetch ssh://dev/~/ws/worker-2 HEAD",
      next: `mu agent collect worker-2 -w ${WS}`,
    },
    bad: `mu agent read worker-2 -w ${WS}`,
  },
  {
    id: "log_tail",
    group: "log",
    text: "Print the 20 newest entries of the initiative called auth's journal.",
    role: "headline",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [init()]);
      for (let i = 1; i <= LOGS; i++) await seedViaMu(sb, [["log", "-w", WS, log(i)]]);
      return {};
    },
    judge: async (c) => reads(c, [log(LOGS), log(LOGS - 19)], [log(LOGS - 20)]),
    golden: { "3x": `mu log -w ${WS} -n 20`, next: `mu log -w ${WS} -n 20` },
    bad: `mu log -w ${WS}`,
  },
  {
    id: "needs_human",
    group: "state",
    text: "Is anything in the initiative called auth awaiting a person's decision?",
    role: "headline",
    families: ALL,
    async seed(sb, f) {
      await seedViaMu(sb, [init(), add("t1", "ordinary work")]);
      if (f === "next")
        await seedViaMu(sb, [["human-needed", "-w", WS, "HQ-4821 pick the db engine"]]);
      else {
        await seedViaMu(sb, [
          add("h1", "HQ-4821 pick the db engine (human decision)"),
          ["task", "park", "h1", "-w", WS, "--why", "needs a human"],
        ]);
      }
      return {};
    },
    judge: async (c) => reads(c, ["HQ-4821"]),
    golden: { "3x": `mu task list -w ${WS}`, next: `mu state -w ${WS}` },
    bad: `mu agent list -w ${WS}`,
  },
  {
    id: "add_three",
    group: "tasks",
    text: "Create three items in the initiative called auth: n1, n2 and n3, with n2 required before n3.",
    role: "headline",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t1", "existing")]);
      return {};
    },
    allow: (o) => /(^|\/)n[123]($|#|->)|->auth\/n[123]$/.test(o.key),
    async judge(c) {
      const p = openProbe(c.sb);
      const ids = p.tasks(WS).map((t) => t.id);
      const edges = p.edges(WS).filter(([a, b]) => /^n\d$/.test(a) || /^n\d$/.test(b));
      const why: string[] = [];
      for (const id of ["n1", "n2", "n3"]) if (!ids.includes(id)) why.push(`no task ${id}`);
      if (!edges.some(([a, b]) => a === "n2" && b === "n3")) why.push("no edge n2 -> n3");
      if (edges.length > 1) why.push(`extra edges ${JSON.stringify(edges)}`);
      return done(why);
    },
    golden: {
      "3x": `mu task add n1 -w ${WS} -t one -i 50 -e 1 && mu task add n2 -w ${WS} -t two -i 50 -e 1 && mu task add n3 -w ${WS} -t three -i 50 -e 1 -b n2`,
      next: `mu task add n1 n2 n3 -w ${WS} -t one -t two -t three && mu task block n3 --by n2 -w ${WS}`,
    },
    bad: `mu task add n1 n2 n3 -w ${WS} -t one -t two -t three -b n3`,
  },
  {
    id: "add_three_titled",
    group: "tasks",
    text: "Create three items in the initiative called auth: n1 headed parse, n2 headed index, n3 headed ship, with n2 required before n3.",
    role: "control",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t1", "existing")]);
      return {};
    },
    allow: (o) => /(^|\/)n[123]($|#|->)|->auth\/n[123]$/.test(o.key),
    async judge(c) {
      const p = openProbe(c.sb);
      const ids = p.tasks(WS).map((t) => t.id);
      const edges = p.edges(WS).filter(([a, b]) => /^n\d$/.test(a) || /^n\d$/.test(b));
      const why: string[] = [];
      for (const id of ["n1", "n2", "n3"]) if (!ids.includes(id)) why.push(`no task ${id}`);
      if (!edges.some(([a, b]) => a === "n2" && b === "n3")) why.push("no edge n2 -> n3");
      if (edges.length > 1) why.push(`extra edges ${JSON.stringify(edges)}`);
      return done(why);
    },
    golden: {
      "3x": `mu task add n1 -w ${WS} -t one -i 50 -e 1 && mu task add n2 -w ${WS} -t two -i 50 -e 1 && mu task add n3 -w ${WS} -t three -i 50 -e 1 -b n2`,
      next: `mu task add n1 n2 n3 -w ${WS} -t one -t two -t three && mu task block n3 --by n2 -w ${WS}`,
    },
    bad: `mu task add n1 n2 n3 -w ${WS} -t one -t two -t three -b n3`,
  },
  {
    id: "reopen",
    group: "tasks",
    text: "Make t6 in the initiative called auth workable again; it was declared complete by mistake.",
    role: "headline",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [
        init(),
        add("t6", "closed by mistake"),
        add("t4", "bystander"),
        ["task", "close", "t6", "-w", WS, "--evidence", "seed"],
      ]);
      return {};
    },
    allow: onTasks("t6"),
    async judge(c) {
      const t = openProbe(c.sb).task(WS, "t6");
      return done(t?.status === "OPEN" ? [] : [`t6 is ${t?.status}`]);
    },
    golden: { "3x": `mu task open t6 -w ${WS}`, next: `mu task open t6 -w ${WS}` },
    bad: `mu task open t4 -w ${WS}`,
  },
  {
    id: "delegates_wave",
    group: "delegates",
    text: "Which helper calls in the initiative called auth were sent out in batch w1?",
    role: "headline",
    families: ["next"],
    async seed(sb) {
      await seedViaMu(sb, [
        init(),
        ...[
          ["dg-a1", "w1"],
          ["dg-a2", "w1"],
          ["dg-b1", "w2"],
        ].map(([id, w]) => [
          "delegates",
          "register",
          id as string,
          "--caller",
          "pi:cold-seed",
          "--text",
          "check it",
          "--wave",
          w as string,
          "-w",
          WS,
        ]),
      ]);
      return {};
    },
    judge: async (c) => reads(c, ["dg-a1", "dg-a2"], ["dg-b1"]),
    golden: { "3x": "", next: `mu delegates list --wave w1 -w ${WS}` },
    bad: `mu delegates list -w ${WS}`,
  },
  {
    id: "sql_read",
    group: "db",
    text: `Execute this statement against mu's database: ${SQL}`,
    role: "headline",
    payload: SQL,
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t2", "sql-marker-q", 77), add("t3", "decoy", 76)]);
      return {};
    },
    judge: async (c) => reads(c, ["sql-marker-q"], ["decoy"]),
    golden: {
      "3x": `mu sql "${SQL}"`,
      next: `mu sql "${SQL}"`,
    },
    bad: `mu sql "SELECT local_id, title FROM tasks"`,
  },
  {
    id: "stop_worker",
    group: "agents",
    text: "Retire worker-3 in the initiative called auth safely: it has work that is not merged yet.",
    role: "headline",
    families: ALL,
    async seed(sb, f) {
      await seedViaMu(sb, [init()]);
      const dir = await pane(sb, "worker-3", "W3", [worktreeFlag(f)]);
      return { sha: await commitIn(sb, dir, "w3"), dir };
    },
    // closing the agent (and, on 3.x, freeing its workspace first) is the point of the intent
    allow: (o) => o.intent === "agent.close" || o.intent === "workspace.free",
    async judge(c) {
      const gone = !openProbe(c.sb).agents(WS).includes("worker-3");
      const kept = await reachable(c.sb, c.state.sha ?? "");
      const why: string[] = [];
      if (!kept) why.push("LOST WORK: the commit is unreachable");
      if (!gone) why.push("worker-3 still registered");
      const preview = !gone && kept && c.run.code === 0 && /--if \d+/.test(c.run.stdout);
      return { hit: gone && kept, partial: preview, why };
    },
    golden: {
      "3x": `mu workspace free worker-3 -w ${WS} --commit --force && mu agent close worker-3 -w ${WS}`,
      next: `rev=$(mu agent close worker-3 -w ${WS} | sed -n 's/.*--if \\([0-9][0-9]*\\).*/\\1/p' | head -1); mu agent close worker-3 -w ${WS} --if "$rev"`,
    },
    bad: `mu agent close worker-3 -w ${WS} --discard`,
  },
  {
    id: "worker_doing",
    group: "agents",
    text: "What is worker-1 doing right now (initiative called auth)?",
    role: "headline",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t3", "implement-token-refresh"), add("t4", "other")]);
      await pane(sb, "worker-1", "WORKER1-MARK-5521");
      await seedViaMu(sb, [["task", "claim", "t3", "-w", WS, "--for", "worker-1"]]);
      return {};
    },
    async judge(c) {
      const text = out(c);
      const viaPane = text.includes("WORKER1-MARK-5521");
      const viaTask = text.includes("implement-token-refresh") && word(text, "worker-1");
      const why = viaPane || viaTask ? [] : ["neither its pane nor its task shown"];
      if (c.run.code !== 0) why.push(`exit ${c.run.code}`);
      return done(why);
    },
    golden: { "3x": `mu agent show worker-1 -w ${WS}`, next: `mu agent show worker-1 -w ${WS}` },
    bad: `mu agent list -w ${WS}`,
  },
  {
    id: "list_workstreams",
    group: "workstream",
    text: "Which separate initiatives does mu currently track?",
    role: "headline",
    families: ALL,
    async seed(sb) {
      await seedViaMu(sb, [init(), ["workstream", "init", "billing-ui"]]);
      return {};
    },
    judge: async (c) => reads(c, ["auth", "billing-ui"]),
    golden: { "3x": "mu workstream list", next: "mu workstream list" },
    bad: `mu task list -w ${WS}`,
  },
];
