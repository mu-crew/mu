// Channel behaviour comes from the registry and capabilities (plugins spec D9,
// unit P4). Outside src/channels/, a decision by a channel's NAME is either a
// capability check (`channelNamed(x)?.caps...`, which this scan does not
// match) or one of the features pinned below, each of which belongs to one
// built-in channel. A new name comparison, or one more in a pinned function,
// fails here. Also: no channel or ctl module decides an agent's liveness from
// its own answer alone; that is the job kind's word (src/jobs/, the P1 ruling).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { channelNameHits, literalLivenessHits } from "./_channel-names.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

const rel = (path: string): string => relative(ROOT, path).split(sep).join("/");

/**
 * The pinned features (P4's brief): `file#function form` → how many times.
 * Each is a feature of one built-in channel that a plugin channel never gets.
 */
const PINNED: Readonly<Record<string, number>> = {
  // 1. The hooks brief file and session wait.
  'src/agents/task-spawn.ts#drive === "hooks"': 2,
  // 2. The hooks turn failure: its read and its acknowledgement.
  'src/next-recover.ts#idleAtError === "hooks"': 1,
  'src/next-recover.ts#observeWorkers === "hooks"': 1,
  'src/next-recover.ts#scanRecovery === "hooks"': 1,
  'src/next.ts#recover === "hooks"': 1,
  // 3. The Stop hook.
  'src/hook-stop.ts#applyStopClose !== "hooks"': 1,
  // 4. The pi fallback (`MU_PI_CHANNEL=hooks`), and pi's harness read from its channel.
  'src/agents/spawn.ts#piHooksRequested === "hooks"': 1,
  'src/agent-output.ts#harnessOf === "ctl"': 1,
  'src/agent-output.ts#harnessOf === "hooks"': 1,
  // 5. ctl-only `mu agent wait --after-runs` and `--inc`.
  'src/cli/agents.ts#cmdAgentWait !== "ctl"': 2,
  // 6. The hooks send gate's override: `mu agent send --force` on a plain send.
  'src/cli/agent-send.ts#cmdSend !== "hooks"': 1,
  // 7. doctor's control-socket row: every pane that serves one, pi's fallback marked.
  "src/doctor-summary.ts#ctlSocketsDoctorCheck servesCtl()": 1,
  "src/doctor-summary.ts#ctlSocketsDoctorCheck piOnHooks()": 1,
  // 8. The dispatch hint's send form: ctl's `--fresh`, mux's backend send.
  "src/next-hints.ts#outcomeMove expectsCtl()": 1,
  'src/next-hints.ts#outcomeMove !== "hooks"': 1,
};

describe("channel names outside src/channels/", () => {
  it("every name decision is on the pinned list, exactly as often as pinned", () => {
    const found: Record<string, number> = {};
    const lines: string[] = [];
    for (const path of sources(SRC)) {
      const file = rel(path);
      if (file.startsWith("src/channels/")) continue;
      for (const h of channelNameHits(file, readFileSync(path, "utf8"))) {
        const key = `${file}#${h.where} ${h.form}`;
        found[key] = (found[key] ?? 0) + 1;
        if (PINNED[key] === undefined) lines.push(`${file}:${h.line} ${h.form} (in ${h.where})`);
      }
    }
    expect(lines).toEqual([]);
    expect(found).toEqual(PINNED);
  });

  it("each form is caught, one planted line per form; a name that is only held is not", () => {
    const planted: ReadonlyArray<readonly [string, string]> = [
      ["===", 'function f(r) { return r.transport === "ctl"; }'],
      ["!==", 'function f(r) { return "mux" !== r.channel; }'],
      ["==", 'function f(r) { return r.source == "ctl"; }'],
      ["case", 'function f(r) { switch (r.channel) { case "hooks": return 1; } }'],
      ["includes", 'function f(r) { return ["ctl", "hooks"].includes(r.channel); }'],
      ["singleton", "function f(c) { return c === ctlChannel; }"],
      ["helper", "function f(a) { return expectsCtl(a); }"],
      ["template", "function f(r) { return r.channel === `hooks`; }"],
    ];
    for (const [form, line] of planted) {
      const hits = channelNameHits("src/planted.ts", line);
      expect(hits.length, form).toBeGreaterThan(0);
      expect(hits[0]?.where, form).toBe("f");
    }
    // An arrow bound to a name is that name; an anonymous callback is its encloser's.
    expect(
      channelNameHits("x.ts", 'const g = (r) => [r].filter((x) => x.channel === "ctl");')[0]?.where,
    ).toBe("g");
    // Not decisions: a name held in a property, printed in a message, compared as a cli, a comment.
    for (const line of [
      'const sent = { transport: "ctl" };',
      'say("agent.empty_send_on", name, "hooks");',
      'if (agent.cli === "pi") return;',
      'if (r.ctl === "ok") return; // r.channel === "ctl"',
      'channelNamed(r.transport)?.caps.receipt === "exact";',
    ]) {
      expect(channelNameHits("src/planted.ts", line), line).toEqual([]);
    }
  });
});

describe("liveness is the job's word, not a channel's", () => {
  it("no channel or ctl module sets `alive` to a literal", () => {
    const out: string[] = [];
    for (const path of sources(SRC)) {
      const file = rel(path);
      if (!file.startsWith("src/channels/") && !file.startsWith("src/ctl/")) continue;
      for (const h of literalLivenessHits(file, readFileSync(path, "utf8"))) {
        out.push(`${file}:${h.line} ${h.form} (in ${h.where})`);
      }
    }
    expect(out).toEqual([]);
  });

  it("ctl's answered reading takes its liveness from the job kind", () => {
    const ctl = readFileSync(join(SRC, "channels/ctl.ts"), "utf8");
    expect(ctl).toMatch(/import \{ answerProvesRunning \} from "\.\.\/jobs\/kinds\.js";/);
    expect(ctl).toMatch(/alive: await answeredAlive\(agent\)/);
  });

  it("the literal form is caught; a computed one is not", () => {
    expect(literalLivenessHits("x.ts", "const r = { state, alive: true };")).toHaveLength(1);
    expect(literalLivenessHits("x.ts", "const r = { state, alive: false };")).toHaveLength(1);
    expect(literalLivenessHits("x.ts", "const r = { state, alive: up !== false };")).toEqual([]);
  });
});
