import { describe, expect, it } from "vitest";
import type { ColdRow } from "../../tools/eval/cold-guess.ts";
import {
  extractCommand,
  firstReach,
  muInText,
  parsePiJson,
  systemPrompt,
} from "../../tools/eval/cold-guess.ts";
import { INTENTS } from "../../tools/eval/cold-intents.ts";
import { reachLabel, toColdMarkdown } from "../../tools/eval/cold-report.ts";

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

const row = (o: Partial<ColdRow>): ColdRow => ({
  intent: "owner_of",
  group: "tasks",
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
    expect(md).toContain("## Hit rate per surface and model");
    expect(md).toContain("## Hit rate per intent");
    expect(md).toContain("## Hit rate per verb group");
    expect(md).toContain("50% (1/2)");
    expect(md).toContain("100% (1/1)");
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
