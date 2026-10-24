/**
 * The delegate extension against pi's real `AgentSession` (queue, deferred
 * settle actions, compaction, abort) with a faux model. Only mu is
 * simulated. The checked-in fakePi tests cannot cover this: they do not
 * model pi's follow-up queue or the sends it defers while it settles.
 *
 * Needs a pi install (`pi` on PATH, or `$MU_TEST_PI_ROOT`); skipped without.
 * Scenarios come from the review probes of bug_delegate_followup_lost.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { registerDelegate } from "../extension/delegate.js";

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
const flush = () => new Promise<void>((r) => setImmediate(r));
const until = async (fn: () => boolean) => {
  for (let n = 0; n < 500; n++) {
    if (fn()) return;
    await flush();
  }
  throw new Error("condition never reached");
};
const ok = (data: unknown) => ({
  code: 0,
  stdout: typeof data === "string" ? data : JSON.stringify({ ok: true, data, next: null }),
  stderr: "",
});

/** The slice of pi's AgentSession these tests use. */
type PiSession = {
  clearQueue(): void;
  abort(): Promise<void>;
  prompt(t: string): Promise<void>;
  waitForIdle(): Promise<void>;
  bindExtensions(o: unknown): Promise<void>;
  subscribe(f: (e: Record<string, unknown>) => void): void;
  dispose(): void;
  sendCustomMessage(m: unknown, o: unknown): Promise<void>;
  sessionManager: { getSessionId(): string; getEntries(): unknown[] };
  messages: { role: string; content: unknown }[];
};
/** The slice of pi's ExtensionAPI the extension factory uses. */
type PiApi = {
  on(e: string, h: (...a: never[]) => unknown): void;
  events: never;
  registerTool(t: unknown): void;
  sendMessage(m: unknown, o: unknown): void;
};

type Scenario = {
  name: string;
  n: number;
  /** pi's dequeue key (clearQueue) while the answers are queued. */
  clear?: boolean;
  /** Escape (clearQueue + abort) while the answers are queued. */
  escape?: boolean;
  /** Escape during the second run (the first resend). */
  resendEscape?: boolean;
  /** clearQueue during the second run (answers already started must not be resent). */
  twice?: boolean;
  /** Answers queue during post-run compaction. */
  compact?: boolean;
  /** Answers finish inside an async agent_settled handler (pi's deferred list). */
  settlement?: boolean;
  /** Only 3 of n finish in the first run; the rest during settlement. */
  late?: boolean;
  /** Expected answer sends: n (no loss), or n + resends. */
  sends?: number;
  /** Expected deliveries (default n; escape 0; resendEscape 1). */
  delivered?: number;
};

const scenarios: Scenario[] = [
  { name: "normal-one", n: 1, sends: 1 },
  { name: "normal-six", n: 6, sends: 6 },
  { name: "clear-one", n: 1, clear: true, sends: 2 },
  { name: "clear-six", n: 6, clear: true, sends: 12 },
  { name: "escape-six", n: 6, escape: true, delivered: 0 },
  { name: "clear-escape-six", n: 6, clear: true, escape: true, delivered: 0 },
  { name: "clear-escape-resend", n: 6, clear: true, resendEscape: true, delivered: 1 },
  { name: "clear-twice", n: 1, clear: true, twice: true, sends: 2 },
  { name: "clear-followup-twice", n: 2, clear: true, twice: true },
  { name: "normal-compaction", n: 1, compact: true, sends: 1 },
  { name: "clear-during-compaction", n: 1, compact: true, clear: true, sends: 2 },
  { name: "escape-compaction", n: 1, compact: true, escape: true, delivered: 0 },
  { name: "settlement-two", n: 2, settlement: true, sends: 2 },
  { name: "settlement-six", n: 6, settlement: true, sends: 6 },
  { name: "settlement-escape", n: 6, settlement: true, resendEscape: true, delivered: 1 },
  { name: "clear-late-settlement-escape", n: 6, clear: true, late: true, resendEscape: true },
];

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** Run one scenario on a real AgentSession; returns what the model session saw. */
async function runScenario(s: Scenario) {
  if (!root) throw new Error("no pi");
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const ai = await import(
    pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href
  );
  const dir = mkdtempSync(join(tmpdir(), `mu-pi-${s.name}-`));
  tmps.push(dir);
  mkdirSync(dir, { recursive: true });
  const saved = { ...process.env };
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  process.env.MU_MUX = "tmux";
  const taken = new Set<string>();
  const waits = new Map<string, (r: unknown) => void>();
  const sent: { m: { details?: Record<string, unknown> }; o: unknown }[] = [];
  const events: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  let session: PiSession;
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  let handle: { answerPending(): boolean } | undefined;
  let mainCall = 0;
  let abortedPromise: Promise<unknown> | undefined;
  const run = async (args: string[]) => {
    const [ns, verb, name = ""] = args;
    if (ns === "task")
      return ok(verb === "show" ? { task: { name, workstreamName: "probe" } } : {});
    if (verb === "spawn") {
      let actual = name;
      for (let i = 2; taken.has(actual); i++) actual = `${name}-${i}`;
      taken.add(actual);
      return ok({
        agent: { name: actual },
        ctl: "ok",
        send: { ok: true, transport: "ctl", runs: 0 },
      });
    }
    if (verb === "list") return ok({ agents: [...taken].map((n) => ({ name: n })) });
    if (verb === "wait") return new Promise((resolve) => waits.set(name, resolve));
    if (verb === "close") {
      taken.delete(name);
      return ok({});
    }
    return ok(verb === "read" ? "pane" : {});
  };
  const finish = async (count = s.n) => {
    for (const [name, resolve] of [...waits].slice(0, count))
      resolve(
        ok({
          agents: [
            {
              outcome: "done",
              lastText: `VERDICT: ${name} CONFIRMED\nEVIDENCE:\n- source\n\n  detail`,
            },
          ],
        }),
      );
    await until(() => sent.filter((x) => x.m.details?.delivery !== undefined).length >= count);
    for (let n = 0; n < 8; n++) await flush();
  };
  const interrupt = () => {
    session.clearQueue();
    abortedPromise = session.abort();
  };
  const faux = ai.fauxProvider({
    provider: `probe-${s.name}`,
    api: `probe-${s.name}`,
    models: [{ id: "probe", contextWindow: s.compact ? 20000 : 128000, maxTokens: 2048 }],
    tokenSize: { min: 100000, max: 100000 },
  });
  let compactCall = 0;
  const response = async (_ctx: unknown, options: { sessionId?: string } | undefined) => {
    if (options?.sessionId !== session.sessionManager.getSessionId()) {
      compactCall++;
      if (compactCall === 1) {
        await finish();
        if (s.clear) session.clearQueue();
        if (s.escape) interrupt();
      }
      return ai.fauxAssistantMessage("summary");
    }
    mainCall++;
    if (mainCall === 1 && !s.compact && !s.settlement) {
      await finish(s.late ? 3 : s.n);
      if (s.clear) session.clearQueue();
      if (s.escape) interrupt();
    }
    if (mainCall === 2 && s.resendEscape) interrupt();
    if (mainCall === 2 && s.twice) session.clearQueue();
    return ai.fauxAssistantMessage(s.compact && mainCall === 1 ? "x".repeat(100000) : "done");
  };
  faux.setResponses(Array.from({ length: 30 }, () => response));
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settings = pi.SettingsManager.inMemory({
    compaction: { enabled: !!s.compact, reserveTokens: 1024, keepRecentTokens: 512 },
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
        handle = registerDelegate(
          {
            on: (e: string, h: never) => api.on(e, h),
            events: api.events,
            registerTool(t: { name: string }) {
              if (t.name === "mu_delegate") tool = t as never;
              api.registerTool(t);
            },
            sendMessage(m: { details?: unknown }, o: unknown) {
              sent.push({
                m: { details: m.details as Record<string, unknown> | undefined },
                o: { ...(o as object) },
              });
              // pi's extension API is fire-and-forget; AgentSession owns the queue.
              api.sendMessage(m, o);
            },
          },
          run as never,
        );
        if (s.settlement || s.late) {
          let first = true;
          api.on("agent_settled", async () => {
            if (first) {
              first = false;
              await finish();
            }
          });
        }
      },
    ],
  });
  try {
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
    await session.bindExtensions({
      mode: "json",
      onError: (e: unknown) => errors.push(e),
      uiContext: { setStatus: () => {} },
    });
    session.subscribe((e: Record<string, unknown>) => {
      if (["agent_start", "agent_end", "agent_settled", "message_start"].includes(String(e.type)))
        events.push(e);
    });
    for (let i = 0; i < s.n; i++)
      await tool?.execute(
        `call-${i}`,
        { task: "probe", label: `probe-${i}`, keep: true },
        undefined,
        undefined,
        { cwd: dir, hasUI: true, ui: { setStatus: () => {} } },
      );
    await session.prompt("original");
    await session.waitForIdle();
    if (abortedPromise) await abortedPromise;
    for (let n = 0; n < 12; n++) await flush();
    const custom = events
      .filter((e) => e.type === "message_start")
      .map((e) => e.message as { role?: string; details?: { delivery?: unknown; name?: unknown } })
      .filter((m) => m.role === "custom" && typeof m.details?.delivery === "number");
    return {
      delivered: custom.map((m) => ({
        id: m.details?.delivery as number,
        name: String(m.details?.name),
      })),
      dropped: sent.flatMap(
        (x) => (x.m.details?.dropped as { name: string; copy?: string }[] | undefined) ?? [],
      ),
      answerSends: sent.filter((x) => x.m.details?.delivery !== undefined).length,
      pending: handle?.answerPending(),
      names: [...waits.keys()],
      mainCall,
      errors,
      session,
      send: (m: unknown, o: unknown) => session.sendCustomMessage(m, o),
      dispose: () => session.dispose(),
    };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe.skipIf(!root)("delegate answers on a real pi AgentSession", () => {
  for (const s of scenarios) {
    it(s.name, { timeout: 30_000 }, async () => {
      const r = await runScenario(s);
      try {
        expect(r.errors).toEqual([]);
        const expected = s.delivered ?? s.n;
        if (s.name === "clear-late-settlement-escape") {
          // Whatever arrives before the Escape arrives once; the rest is dropped.
          expect(r.delivered.length).toBeGreaterThanOrEqual(1);
        } else expect(r.delivered).toHaveLength(expected);
        // Exactly one start per id, and the dropped note names exactly what never started.
        expect(new Set(r.delivered.map((d) => d.id)).size).toBe(r.delivered.length);
        expect(r.pending).toBe(false);
        expect(r.dropped.map((d) => d.name).sort()).toEqual(
          r.names.filter((n) => !r.delivered.some((d) => d.name === n)).sort(),
        );
        for (const d of r.dropped) {
          expect(d.copy).toBeTruthy();
          expect(readFileSync(d.copy as string, "utf8")).toContain(
            "EVIDENCE:\n- source\n\n  detail",
          );
        }
        if (s.sends !== undefined) expect(r.answerSends).toBe(s.sends);
        if (s.resendEscape) expect(r.mainCall).toBe(2); // Escape stops every later run
      } finally {
        r.dispose();
      }
    });
  }

  it("a repeat of a delivered id reaches the model and the session file as a one-line stub", async () => {
    const r = await runScenario({ name: "normal-one", n: 1, sends: 1 });
    try {
      const first = r.delivered[0];
      expect(first).toBeDefined();
      await r.send(
        {
          customType: "mu-delegate",
          content: "FULL ANSWER AGAIN ".repeat(50),
          display: true,
          details: { delivery: first?.id, name: first?.name },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      await r.session.waitForIdle();
      const custom = r.session.messages.filter((m) => m.role === "custom");
      expect(custom).toHaveLength(2);
      expect(JSON.stringify(custom[1]?.content)).not.toContain("FULL ANSWER AGAIN");
      expect(JSON.stringify(custom[1]?.content)).toContain("already handled");
      // the session file keeps the stub, not the repeat
      const entries = JSON.stringify(r.session.sessionManager.getEntries());
      expect(entries).not.toContain("FULL ANSWER AGAIN");
    } finally {
      r.dispose();
    }
  });
});
