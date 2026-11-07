// Cold-guess intents (e_cold_guess): short things an orchestrator really asks of mu. Each has a seed
// (what the sandbox holds before the guess), a judge that reads STATE and the guess's own output
// (never its spelling), and one golden command per surface family plus one plausible-but-wrong bad,
// so `cold-guess check` proves the judge before any model is paid for.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  add,
  type ColdIntent,
  checksOn,
  commitIn,
  delegateTask,
  devHost,
  done,
  hostRoot,
  init,
  listsOpen,
  onTasks,
  out,
  pane,
  reachable,
  reads,
  SPAWN_3X,
  verdictOf,
  WS,
  word,
  worktreeFlag,
} from "./cold-kit.ts";
import { hostProfile, seedDelegate, seedNotes, seedViaMu, shq } from "./fixtures.ts";
import { openProbe } from "./probe.ts";
import { sh } from "./sandbox.ts";
import type { Family } from "./types.ts";

export {
  ANSI,
  type ColdCtx,
  type ColdEffect,
  type ColdIntent,
  type GuessRun,
  WS,
} from "./cold-kit.ts";

// ---- the intents -------------------------------------------------------------------------------

const PROOF = "gate green: npm test exit 0";
const SQL = "SELECT local_id, title FROM tasks WHERE impact = 77";
const BRIEF_END = "BRIEF-END-7731";
const LOGS = 24;
const log = (i: number): string => `LOGREC-${String(i).padStart(2, "0")}`;
const ALL: Family[] = ["3x", "next"];
const NEXT: Family[] = ["next"];
const CHECK_ANSWER = "VERDICT: CONFIRMED - the four fixes hold";
const REPORT_CALL = "rv-7";
const REPORT_TASK = delegateTask(REPORT_CALL, "rev");
const NOTE = (t: string): string => `NOTE-${t.toUpperCase()}-4417`;

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
    text: "Print the original instructions that t3 in the initiative called auth was handed.",
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
        dir = await pane(sb, "worker-2", "W2", ["--host", "dev", "--worktree", "--cli", "pi"]);
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
  // ---- 4.x verbs since 4.0 (hill-r2 spec §2.1) ----
  {
    id: "check_record",
    group: "tasks",
    text: "Ask a claude reviewer for an independent second opinion on t4 in the initiative called auth, and have mu track that request.",
    role: "headline",
    families: NEXT,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t4", "four fixes"), add("t5", "bystander")]);
      return {};
    },
    allow: (o) => o.intent === "check.issue",
    async judge(c) {
      const rows = checksOn(c.sb, WS, "t4");
      return done(rows.length > 0 ? [] : ["no check recorded on t4"]);
    },
    golden: {
      "3x": "",
      next: `mu task check t4 -w ${WS} --by claude --brief "Re-check t4's four fixes and end with a VERDICT: line"`,
    },
    bad: `mu task note t4 -w ${WS} "claude: please review t4 independently"`,
  },
  {
    id: "verdict_record",
    group: "tasks",
    text: `The claude reviewer asked to re-examine t4 (initiative called auth) came back with: ${CHECK_ANSWER}. Store that result on the pending request.`,
    payload: CHECK_ANSWER,
    role: "headline",
    families: NEXT,
    async seed(sb) {
      await seedViaMu(sb, [
        init(),
        add("t4", "four fixes"),
        ["task", "check", "t4", "-w", WS, "--by", "claude", "--brief", "re-check t4's fixes"],
      ]);
      return {};
    },
    allow: (o) => o.intent === "check.verdict",
    async judge(c) {
      const rows = checksOn(c.sb, WS, "t4");
      const ok = rows.some((r) => verdictOf(r.verdict) === "CONFIRMED");
      return done(ok ? [] : ["t4's check carries no CONFIRMED verdict"]);
    },
    golden: {
      "3x": "",
      next: `c=$(mu state -w ${WS} --json | grep -o '"checks":\\[{"id":"[0-9A-Z]*' | grep -o '[0-9A-Z]*$'); mu task verdict t4 -w ${WS} --check "$c" '${CHECK_ANSWER}'`,
    },
    bad: `mu task note t4 -w ${WS} '${CHECK_ANSWER}'`,
  },
  {
    id: "wave_outcome",
    group: "delegates",
    text: "How did the helper calls of batch w1 in the initiative called auth turn out? Give each one's tag and result.",
    role: "headline",
    families: NEXT,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t4", "four fixes"), add("t5", "token cache")]);
      const call = (callId: string, wave: string, label: string, record: string, answer: string) =>
        seedDelegate(sb, {
          callId,
          caller: "pi:cold-seed",
          wave,
          label,
          record,
          brief: `check ${record}`,
          agent: `delegate-${label}`,
          answer,
        });
      await call("wo-1", "w1", "review-t4", `${WS}/t4`, "VERDICT: CONFIRMED\nEVIDENCE: tests pass");
      await call("wo-2", "w1", "review-t5", `${WS}/t5`, "VERDICT: REFUTED\nEVIDENCE: cache leaks");
      await call("wo-3", "w2", "audit-t4", `${WS}/t4`, "VERDICT: CONFIRMED\nEVIDENCE: ok");
      return {};
    },
    judge: async (c) => reads(c, ["review-t4", "review-t5", "CONFIRMED", "REFUTED"], ["audit-t4"]),
    golden: { "3x": "", next: `mu delegates list --wave w1 -w ${WS}` },
    bad: `mu delegates tally --wave w1 -w ${WS}`,
  },
  {
    id: "host_list",
    group: "host",
    text: "Which other machines can mu reach, and how is each one set up?",
    role: "headline",
    families: NEXT,
    async seed(sb, f) {
      await seedViaMu(sb, [init()]);
      await devHost(sb, f);
      await hostProfile(sb, "gpu", { repo: "~/src/gpu-repo" });
      return {};
    },
    judge: async (c) => reads(c, ["dev", "gpu", "~/repo", "~/src/gpu-repo"]),
    golden: { "3x": "", next: "mu host list" },
    bad: "mu host show dev",
  },
  {
    id: "lease_show",
    group: "host",
    text: "On machine dev, which worker currently occupies a connection slot (initiative called auth)?",
    role: "headline",
    families: NEXT,
    async seed(sb, f) {
      await seedViaMu(sb, [init()]);
      await devHost(sb, f);
      await pane(sb, "worker-2", "W2", ["--host", "dev", "--worktree", "--cli", "pi"]);
      await pane(sb, "worker-3", "W3");
      return {};
    },
    judge: async (c) => reads(c, ["worker-2"], ["worker-3"]),
    golden: { "3x": "", next: "mu host show dev" },
    bad: `mu agent list -w ${WS}`,
  },
  {
    id: "notes_two",
    group: "tasks",
    text: "Print the remarks left on t1 and on t2 in the initiative called auth.",
    role: "headline",
    families: NEXT,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t1", "one"), add("t2", "two"), add("t3", "three")]);
      for (const t of ["t1", "t2", "t3"]) await seedNotes(sb, WS, t, [`${NOTE(t)} about ${t}`]);
      return {};
    },
    judge: async (c) => reads(c, [NOTE("t1"), NOTE("t2")], [NOTE("t3")]),
    golden: { "3x": "", next: `mu task notes t1 -w ${WS}; mu task notes t2 -w ${WS}` },
    bad: `mu task notes t1 -w ${WS}`,
  },
  {
    id: "close_apply_clean",
    group: "agents",
    text: "worker-3 in the initiative called auth has finished and its work is already on main; retire it and tidy up behind it.",
    role: "headline",
    families: NEXT,
    async seed(sb, f) {
      await seedViaMu(sb, [init()]);
      const dir = await pane(sb, "worker-3", "W3", [worktreeFlag(f)]);
      const sha = await commitIn(sb, dir, "w3");
      await sh(sb, `git merge -q --ff-only ${sha}`);
      return { sha, dir };
    },
    allow: (o) => o.intent === "agent.close",
    async judge(c) {
      const gone = !openProbe(c.sb).agents(WS).includes("worker-3");
      const kept = await reachable(c.sb, c.state.sha ?? "");
      const tidy = !existsSync(c.state.dir ?? "");
      const why: string[] = [];
      if (!kept) why.push("LOST WORK: the commit is unreachable");
      if (!gone) why.push("worker-3 still registered");
      if (!tidy) why.push("its worktree is still there");
      const preview = !gone && c.run.code === 0 && /--if \d+/.test(c.run.stdout);
      return { hit: gone && kept && tidy, partial: preview, why };
    },
    golden: {
      "3x": "",
      next: [
        `mu agent close worker-3 -w ${WS}`,
        `mu agent close worker-3 -w ${WS} --if "$(mu agent close worker-3 -w ${WS} | sed -n 's/^next: .*--if \\([0-9][0-9]*\\).*/\\1/p')"`,
      ].join("\n"),
    },
    bad: `mu agent close worker-3 -w ${WS}`,
  },
  {
    id: "report_only",
    group: "delegates",
    text: `Print only the findings that helper ${REPORT_TASK} (initiative called auth) came back with, not the instructions it was given.`,
    payload: REPORT_TASK,
    role: "headline",
    families: NEXT,
    async seed(sb) {
      await seedViaMu(sb, [init(), add("t4", "four fixes")]);
      const { task } = await seedDelegate(sb, {
        callId: REPORT_CALL,
        caller: "pi:cold-seed",
        label: "rev",
        brief: "Review t4's four fixes. BRIEF-MARK-2291",
        agent: "delegate-rev",
        answer: "Fix 3 drops the expiry check. RPT-MARK-2291\nFixes 1, 2 and 4 hold.",
      });
      if (task !== REPORT_TASK) throw new Error(`report_only: seeded ${task}, want ${REPORT_TASK}`);
      return {};
    },
    judge: async (c) => reads(c, ["RPT-MARK-2291"], ["BRIEF-MARK-2291"]),
    golden: { "3x": "", next: `mu task notes ${REPORT_TASK} -w ${WS} | grep '^report'` },
    bad: `mu task notes ${REPORT_TASK} -w ${WS}`,
  },
];
