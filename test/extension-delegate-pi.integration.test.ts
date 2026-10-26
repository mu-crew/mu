/**
 * Delegate answers on pi's real `AgentSession` (queue, before-settle boundary,
 * deferred settle actions, abort) with a faux model, the real settle wait and
 * the real mu: `delegates`, `state`, `wait` and `task notes` run `dist/cli.js`
 * on a temp DB. Only the panes are simulated (`agent spawn|wait|close`). The
 * fakePi tests cannot cover this: they model neither pi's boundary nor a real
 * `mu wait` child and its cursor.
 *
 * Needs a pi install (`pi` on PATH, or `$MU_TEST_PI_ROOT`) and `npm run build`;
 * skipped without either.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { registerDelegate } from "../extension/delegate.js";
import { type MuResult, runChild } from "../extension/mu-run.js";
import { parallelSettle, registerNudge, withQueuedInput } from "../extension/nudge.js";
import { openDb } from "../src/db.js";
import { listDelegates } from "../src/delegates.js";
import { addTask } from "../src/tasks/edit.js";

function piRoot(): string | undefined {
  try {
    const fromEnv = process.env.MU_TEST_PI_ROOT;
    if (fromEnv) return existsSync(join(fromEnv, "dist", "index.js")) ? fromEnv : undefined;
    // <root>/dist/bundle/cli.js, via the `pi` symlink
    const bin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
    const root = dirname(dirname(dirname(bin)));
    return existsSync(join(root, "dist", "index.js")) ? root : undefined;
  } catch {
    return undefined;
  }
}

const root = piRoot();
const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "mu", "SKILL.md"), "utf8");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Poll (50ms) until `fn` holds; a real `mu` child answers in ~0.2s, a wait polls each 1s. */
const until = async (fn: () => boolean, what: string) => {
  for (let n = 0; n < 300; n++) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`never: ${what}`);
};
const ok = (data: unknown): MuResult => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data, next: null }),
  stderr: "",
});

type PiSession = {
  abort(): Promise<void>;
  prompt(t: string): Promise<void>;
  waitForIdle(): Promise<void>;
  bindExtensions(o: unknown): Promise<void>;
  subscribe(f: (e: Record<string, unknown>) => void): void;
  dispose(): void;
  sessionManager: { getSessionId(): string };
  messages: { role: string; customType?: string; content: unknown }[];
};
type PiApi = {
  on(e: string, h: (...a: never[]) => unknown): void;
  events: never;
  registerTool(t: unknown): void;
  sendMessage(m: unknown, o: unknown): void;
};
type Tool = { execute: (...a: unknown[]) => Promise<{ details: { call_id: string } }> };
type Model = (n: number, h: Harness) => Promise<void> | void;

interface Harness {
  session: PiSession;
  tool: Tool;
  /** Start one delegate call (as the model's tool call would). */
  call(params: Record<string, unknown>): Promise<string>;
  /** Let delegate `name` (or the oldest unanswered) answer with `text`; resolves once recorded. */
  answer(text: string, name?: string): Promise<void>;
  /** Escape: the settle wait's terminal hook, then pi's abort (what the TUI key does). */
  escape(): Promise<void>;
  /** Every send this extension made, with its options. */
  sent: { content: string; o: { triggerTurn?: boolean } }[];
  events: Record<string, unknown>[];
  mainCalls(): number;
  pending(): boolean;
  /** How often `needle` reached the model's context (custom messages). */
  seen(needle: string): number;
  db: ReturnType<typeof openDb>;
}

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** A real AgentSession with the delegate side and the settle wait wired as mu-pi.ts does. */
async function harness(name: string, model: Model, opts: { nudge?: boolean } = {}) {
  if (!root) throw new Error("no pi");
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const ai = await import(
    pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href
  );
  const dir = mkdtempSync(join(tmpdir(), `mu-pi-${name}-`));
  tmps.push(dir);
  const saved = { ...process.env };
  Object.assign(process.env, {
    MU_DB_PATH: join(dir, "mu.db"),
    MU_STATE_DIR: join(dir, "state"),
    MU_SYNC_DIR: "",
    MU_MUX: "tmux",
    XDG_CACHE_HOME: join(dir, "cache"),
  });
  if (opts.nudge === false) process.env.MU_NUDGE = "0";
  const db = openDb({ path: join(dir, "mu.db") });
  addTask(db, { workstream: "probe", localId: "f1", title: "judged" });
  const waits = new Map<string, (r: MuResult) => void>();
  let spawned = 0;
  // The panes are simulated; every other verb is the real mu on the temp DB.
  const run = async (
    args: readonly string[],
    signal?: AbortSignal,
    stdin?: string,
    o?: { env?: Record<string, string | undefined>; drainMs?: number },
  ): Promise<MuResult> => {
    const [ns, verb, who = ""] = args;
    if (ns === "agent" && verb === "spawn")
      return ok({
        agent: { name: `delegate-${++spawned}` },
        ctl: "ok",
        send: { ok: true, transport: "ctl", runs: 0 },
      });
    if (ns === "agent" && verb === "wait") return new Promise((r) => waits.set(who, r));
    if (ns === "agent") return ok({ kind: "none", revision: 0 });
    return runChild(process.execPath, [CLI, ...args], signal, stdin, o);
  };
  const sent: Harness["sent"] = [];
  const events: Record<string, unknown>[] = [];
  let tool: Tool | undefined;
  let handle: { answerPending(): boolean } | undefined;
  let onKey: ((d: string) => undefined) | undefined;
  let main = 0;
  let session: PiSession | undefined;
  const faux = ai.fauxProvider({
    provider: `probe-${name}`,
    api: `probe-${name}`,
    models: [{ id: "probe", contextWindow: 128000, maxTokens: 2048 }],
  });
  const h: Harness = {
    get session() {
      if (!session) throw new Error("no session");
      return session;
    },
    get tool() {
      if (!tool) throw new Error("no tool");
      return tool;
    },
    async call(params) {
      const r = await h.tool.execute(`c${spawned}`, params, undefined, undefined, {
        cwd: dir,
        sessionManager: h.session.sessionManager,
      });
      return r.details.call_id;
    },
    async answer(text, who) {
      const key = who ?? [...waits.keys()][0];
      const resolve = key === undefined ? undefined : waits.get(key);
      if (key === undefined || !resolve) throw new Error("no delegate waiting");
      waits.delete(key);
      resolve(ok({ agents: [{ outcome: "done", lastText: text }] }));
      await until(
        () => listDelegates(db).some((c) => c.agent === key && c.state === "done"),
        `${key} recorded`,
      );
    },
    async escape() {
      onKey?.("\u001b");
      await h.session.abort();
    },
    sent,
    events,
    mainCalls: () => main,
    pending: () => handle?.answerPending() ?? false,
    seen: (needle) =>
      h.session.messages.filter(
        (m) => m.role === "custom" && JSON.stringify(m.content).includes(needle),
      ).length,
    db,
  };
  faux.setResponses(
    Array.from({ length: 40 }, () => async () => {
      main++;
      await model(main, h);
      return ai.fauxAssistantMessage(`turn ${main}`);
    }),
  );
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settings = pi.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new pi.DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "probe",
    extensionFactories: [
      (api: PiApi) => {
        const delegates = registerDelegate(
          {
            on: (e: string, f: never) => api.on(e, f),
            events: api.events,
            registerTool(t: { name: string }) {
              if (t.name === "mu_delegate") tool = t as never;
              api.registerTool(t);
            },
            sendMessage(m: { content: string }, o: { triggerTurn?: boolean }) {
              sent.push({ content: m.content, o: { ...o } });
              api.sendMessage(m, o);
            },
          },
          run,
        );
        handle = delegates;
        const hold = withQueuedInput(() => (delegates.answerPending() ? "wake" : undefined));
        const settle = parallelSettle(api as never, hold);
        registerNudge(settle.api, run, SKILL, undefined, hold, delegates.delivered);
        settle.flush();
      },
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  ({ session } = await pi.createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    resourceLoader: loader,
    sessionManager: pi.SessionManager.inMemory(dir),
    settingsManager: settings,
    modelRuntime,
    model: faux.getModel(),
    thinkingLevel: "off",
    tools: [],
  }));
  const errors: unknown[] = [];
  await h.session.bindExtensions({
    mode: "interactive",
    onError: (e: unknown) => errors.push(e),
    uiContext: {
      setStatus: () => {},
      notify: () => {},
      onTerminalInput: (f: (d: string) => undefined) => {
        onKey = f;
        return () => {
          if (onKey === f) onKey = undefined;
        };
      },
    },
  });
  h.session.subscribe((e) => {
    if (["agent_start", "agent_end", "agent_settled", "message_start"].includes(String(e.type)))
      events.push(e);
  });
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
  return {
    h,
    errors,
    dispose: () => {
      h.session.dispose();
      db.close();
      restore();
    },
  };
}

const settledCount = (h: Harness) => h.events.filter((e) => e.type === "agent_settled").length;
const wakes = (h: Harness) => h.sent.filter((s) => s.o.triggerTurn === true);

describe.skipIf(!root || !existsSync(CLI))("delegate answers on a real pi AgentSession", () => {
  it("starvation: answers mid-turn and during the settle wait each reach the model once, in ONE run", {
    timeout: 60_000,
  }, async () => {
    const t = await harness("starve", async (n, h) => {
      if (n === 1) await h.answer("ANSWER-ONE"); // recorded mid-turn
      if (n === 2) setTimeout(() => void h.answer("ANSWER-TWO"), 300); // lands while the hook waits
      if (n === 3) await h.answer("ANSWER-THREE");
    });
    try {
      for (const _ of [1, 2, 3]) await t.h.call({ task: "probe", keep: true });
      await t.h.session.prompt("go");
      await t.h.session.waitForIdle();
      expect(t.errors).toEqual([]);
      for (const a of ["ANSWER-ONE", "ANSWER-TWO", "ANSWER-THREE"]) expect(t.h.seen(a)).toBe(1);
      // One prompt, one run: no turn ended between the first dispatch and the last report.
      expect(settledCount(t.h)).toBe(1);
      expect(t.h.mainCalls()).toBe(4);
      expect(t.h.sent).toEqual([]); // no echo, no wake
      expect(t.h.pending()).toBe(false);
    } finally {
      t.dispose();
    }
  });

  it("a wave of three reaches the model as ONE summary", { timeout: 60_000 }, async () => {
    const t = await harness("wave", async (n, h) => {
      if (n === 1) {
        await h.answer("VERDICT: CONFIRMED\nEVIDENCE: a");
        setTimeout(() => void h.answer("VERDICT: REFUTED\nEVIDENCE: b"), 200);
        setTimeout(() => void h.answer("NO VERDICT HERE"), 1400);
      }
    });
    try {
      for (const _ of [1, 2, 3])
        await t.h.call({ task: "probe", keep: true, wave: "w", record: { task: "probe/f1" } });
      await t.h.session.prompt("go");
      await t.h.session.waitForIdle();
      expect(t.errors).toEqual([]);
      const driving = t.h.session.messages.filter((m) => m.customType === "mu-keep-driving");
      expect(driving).toHaveLength(1);
      const text = JSON.stringify(driving[0]?.content);
      expect(text).toContain("Wave w: 1/3 CONFIRMED, 1 REFUTED, 1 UNVERIFIED, 0 pending");
      expect(t.h.seen("NO VERDICT HERE")).toBe(1);
      expect(t.h.mainCalls()).toBe(2);
      expect(t.h.sent).toEqual([]);
    } finally {
      t.dispose();
    }
  });

  it("interruption: Esc mid-wait drains the child, strands no wake; the next prompt's settle shows the report", {
    timeout: 60_000,
  }, async () => {
    let escaped: Promise<void> | undefined;
    const t = await harness("escape", async (n, h) => {
      if (n === 1)
        setTimeout(() => {
          escaped = h.answer("KEPT-ANSWER").then(async () => {
            await sleep(100);
            await h.escape();
          });
        }, 600);
    });
    try {
      await t.h.call({ task: "probe", keep: true });
      await t.h.session.prompt("go");
      await t.h.session.waitForIdle();
      await escaped;
      await t.h.session.waitForIdle();
      await sleep(100);
      expect(t.errors).toEqual([]);
      expect(wakes(t.h)).toEqual([]); // the user stopped: nothing starts a turn
      expect(t.h.pending()).toBe(false);
      expect(t.h.seen("KEPT-ANSWER")).toBe(0);
      const calls = t.h.mainCalls();
      await t.h.session.prompt("again");
      await t.h.session.waitForIdle();
      expect(t.h.seen("KEPT-ANSWER")).toBe(1);
      expect(t.h.mainCalls()).toBe(calls + 2); // the prompt, then the report's continuation
    } finally {
      t.dispose();
    }
  });

  it("no settle wait (MU_NUDGE=0): one wake per idle answer, a pointer only; its turn runs", {
    timeout: 60_000,
  }, async () => {
    const t = await harness("nonudge", () => {}, { nudge: false });
    try {
      await t.h.call({ task: "probe", keep: true });
      await t.h.session.prompt("go");
      await t.h.session.waitForIdle();
      const before = t.h.mainCalls();
      await t.h.answer("IDLE-ANSWER");
      await until(() => t.h.mainCalls() > before, "the wake's turn");
      await t.h.session.waitForIdle();
      expect(t.errors).toEqual([]);
      expect(wakes(t.h)).toHaveLength(1);
      expect(wakes(t.h)[0]?.content).toContain("mu task notes ");
      expect(t.h.seen("IDLE-ANSWER")).toBe(0); // the wake carries no answer text
      expect(t.h.pending()).toBe(false);
      await sleep(100);
      expect(wakes(t.h)).toHaveLength(1); // its turn's settle owes nothing more
    } finally {
      t.dispose();
    }
  });
});
