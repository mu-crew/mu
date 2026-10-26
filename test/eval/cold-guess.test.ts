import { describe, expect, it } from "vitest";
import type { ColdRow } from "../../tools/eval/cold-guess.ts";
import {
  extractCommand,
  firstReach,
  muInText,
  parsePiJson,
  systemPrompt,
} from "../../tools/eval/cold-guess.ts";
import { neutralityLeaks, optionNames, subcommands } from "../../tools/eval/cold-help.ts";
import { INTENTS } from "../../tools/eval/cold-intents.ts";
import { reachLabel, toColdMarkdown, versus } from "../../tools/eval/cold-report.ts";

describe("extractCommand", () => {
  it("takes the fenced block and drops $ prompts and comments", () => {
    expect(extractCommand("Sure:\n```sh\n# list\n$ mu task list -w auth\n```\nThat lists.")).toBe(
      "mu task list -w auth",
    );
  });
  it("keeps a multi-line fenced command whole", () => {
    expect(
      extractCommand("```bash\nrev=$(mu agent close w -w a)\nmu agent close w -w a --if $rev\n```"),
    ).toBe("rev=$(mu agent close w -w a)\nmu agent close w -w a --if $rev");
  });
  it("without a fence takes the first line that runs mu", () => {
    expect(extractCommand("I would run\nmu state -w auth\nthen read it")).toBe("mu state -w auth");
  });
  it("is null for prose and for an empty block", () => {
    expect(extractCommand("I cannot tell.")).toBeNull();
    expect(extractCommand("```sh\n```")).toBeNull();
  });
});

describe("firstReach", () => {
  it("names the noun and subcommand, flags without values, and ignores arguments", () => {
    expect(firstReach("task show t3 -w auth --json")).toEqual({
      verb: "task show",
      flags: ["--json", "-w"],
      tables: [],
    });
  });
  it("a leading global -w does not hide the verb", () => {
    expect(firstReach("-w auth task close t4 --evidence x").verb).toBe("task close");
  });
  it("a bare verb keeps no argument words (mu log text)", () => {
    expect(firstReach("log -w auth some text").verb).toBe("log");
  });
  it("collects the tables of a sql guess", () => {
    const r = firstReach(`sql "SELECT t.id FROM tasks t JOIN agents a ON 1 JOIN edges e"`);
    expect(r.verb).toBe("sql");
    expect(r.tables).toEqual(["agents", "edges", "tasks"]);
  });
});

describe("muInText", () => {
  it("finds every mu call of a pipeline or a $(...) substitution", () => {
    expect(muInText("rev=$(mu agent close w -w a | head -1); mu agent close w --if 1")).toEqual([
      "agent close w -w a ",
      "agent close w --if 1",
    ]);
  });
  it("does not take the word mu inside another word", () => {
    expect(muInText("echo menu mu-x")).toEqual([]);
  });
});

describe("parsePiJson", () => {
  const ev = (message: object): string => JSON.stringify({ type: "message_end", message });
  it("sums assistant text and tokens", () => {
    const out = [
      ev({ role: "user", content: [{ type: "text", text: "q" }] }),
      ev({
        role: "assistant",
        content: [{ type: "text", text: "```sh\nmu x\n```" }],
        usage: { totalTokens: 46 },
      }),
      "not json",
    ].join("\n");
    expect(parsePiJson(out)).toEqual({ text: "```sh\nmu x\n```", tokens: 46 });
  });
  it("reports a model error and a silent reply", () => {
    const err = ev({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "529 overloaded",
    });
    expect(parsePiJson(err).error).toBe("529 overloaded");
    expect(parsePiJson("", "boom\n", 1).error).toBe("boom");
  });
});

describe("the model sees only --help", () => {
  it("system prompt holds the help and no skill words", () => {
    const p = systemPrompt("Usage: mu [options]");
    expect(p).toContain("<help>\nUsage: mu [options]\n</help>");
    expect(p).not.toMatch(/skill|recipe/i);
  });
});

describe("intents", () => {
  it("ids are unique and every family a golden is needed for has one", () => {
    const ids = INTENTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of INTENTS)
      for (const f of i.families) expect(i.golden[f], `${i.id} ${f}`).not.toBe("");
  });
  it("covers the surfaces the spec names", () => {
    expect(new Set(INTENTS.map((i) => i.group))).toEqual(
      new Set(["tasks", "agents", "state", "log", "db", "host", "workstream", "delegates"]),
    );
    expect(INTENTS.length).toBeGreaterThanOrEqual(15);
  });
});

describe("neutral wording", () => {
  const vocab = { a: new Set(["collect", "agent", "tail", "human", "needed"]) };
  it("flags a request that uses a verb, a noun or a flag name of a surface", () => {
    const leaks = neutralityLeaks(
      [
        { id: "x", text: "Collect worker-2's commits." },
        { id: "y", text: "Print the entries; --tail 20" },
        { id: "z", text: "What is human-needed here?" },
        { id: "ok", text: "Bring worker-2's work home." },
      ],
      vocab,
    );
    expect(leaks.map((l) => `${l.intent}:${l.word}`).sort()).toEqual([
      "x:collect",
      "y:tail",
      "z:human",
      "z:needed",
    ]);
  });
  it("matches plurals, ignores grammar words and the quoted payload", () => {
    const l = neutralityLeaks(
      [
        { id: "p", text: "List the agents for me" },
        { id: "q", text: "Run: SELECT collect FROM agent", payload: "SELECT collect FROM agent" },
      ],
      vocab,
    );
    expect(l.map((x) => x.word)).toEqual(["agents"]);
  });
  it("reads subcommands and long flags from commander help", () => {
    const help =
      "Usage: mu task\n\nOptions:\n  -h, --help  x\n  --note <n>  y\n\nCommands:\n  add [options]  a\n  help [cmd]  h\n  tree <id>  t\n";
    expect(subcommands(help)).toEqual(["add", "tree"]);
    expect(optionNames(help)).toEqual(["help", "note"]);
  });
  // The lint over the REAL surfaces runs in cold-guess.integration.test.ts (it needs the builds).
  it("every intent has a role, and only controls are outside the headline", () => {
    for (const i of INTENTS) expect(["headline", "control"]).toContain(i.role);
    expect(INTENTS.filter((i) => i.role === "control").map((i) => i.id)).toEqual([
      "spawn_remote_named",
      "add_three_titled",
    ]);
  });
});

const row = (o: Partial<ColdRow>): ColdRow => ({
  intent: "owner_of",
  group: "tasks",
  role: "headline",
  surface: "next",
  family: "next",
  version: "x",
  model: "m/haiku",
  rep: 1,
  helpSha: "h",
  reply: "",
  command: "mu task show t3",
  parsed: true,
  multiLine: false,
  exit: 0,
  timedOut: false,
  hit: true,
  partial: false,
  destructive: false,
  stray: [],
  why: [],
  reach: { verb: "task show", flags: ["-w"], tables: [] },
  muCalls: [],
  firstError: "",
  tokens: 100,
  ms: 1,
  ...o,
});

describe("report", () => {
  const rows = [
    row({}),
    row({
      rep: 2,
      hit: false,
      why: ["output lacks worker-1"],
      command: "mu agent list -w auth",
      reach: { verb: "agent list", flags: ["-w"], tables: [] },
    }),
    row({ surface: "3.13.3", family: "3x", rep: 1 }),
  ];
  const md = toColdMarkdown(rows);
  it("has the per-surface, per-intent and per-group tables", () => {
    expect(md).toContain("## Headline: the 1 pre-registered intents");
    expect(md).toContain("## Hit rate per intent");
    expect(md).toContain("## Hit rate per verb group");
    expect(md).toContain("50% (1/2)");
    expect(md).toContain("100% (1/1)");
  });
  it("headline counts pre-registered intents only; controls are a separate table", () => {
    const withControl = toColdMarkdown([
      ...rows,
      row({ intent: "add_three_titled", role: "control" }),
      row({
        intent: "add_three_titled",
        role: "control",
        surface: "3.13.3",
        family: "3x",
        hit: false,
      }),
    ]);
    expect(withControl).toContain("## Headline: the 1 pre-registered intents");
    expect(withControl).toContain("## Controls");
    expect(withControl).toMatch(/\| add_three_titled \| 100% \(1\/1\) \| 0% \(0\/1\) \|/);
  });
  it("ranks the wrong guesses with their first reach", () => {
    expect(md).toContain("## Top wrong guesses");
    expect(md).toContain("owner_of · agent list");
  });
  it("labels reaches without the noise flags", () => {
    expect(
      reachLabel(
        row({ reach: { verb: "task list", flags: ["--json", "-w", "--status"], tables: [] } }),
      ),
    ).toBe("task list --status");
    expect(reachLabel(row({ reach: null, command: null }))).toBe("(no command)");
  });
});

describe("versus", () => {
  const rs = (surface: string, intent: string, hits: boolean[]): ColdRow[] =>
    hits.map((hit, k) => row({ surface, intent, hit, rep: k + 1 }));
  const rows = [
    ...rs("n", "big", [true, true, true]),
    ...rs("x", "big", [false, false, true]),
    ...rs("n", "one", [true, false, false]),
    ...rs("x", "one", [false, false, false]),
    ...rs("n", "lose", [false, false, false]),
    ...rs("x", "lose", [true, true, false]),
    ...rs("n", "ctl", [true, true, true]),
    ...rs("x", "ctl", [false, false, false]),
  ].map((r) => (r.intent === "ctl" ? { ...r, role: "control" as const } : r));
  it("needs a gap of two hits to call a win or a loss, and skips controls", () => {
    expect(versus(rows, "n", "x", "headline").map((v) => `${v.intent}:${v.result}`)).toEqual([
      "big:win",
      "one:tie",
      "lose:loss",
    ]);
    expect(versus(rows, "n", "x", "control").map((v) => v.result)).toEqual(["win"]);
  });
});
