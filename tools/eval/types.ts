// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Shared types for the eval harness. Black box: nothing here imports src/ or extension/.

/** Command dialect of a surface: the released 3.x verbs, or the mu-next verbs. Exactly these two. */
export type Family = "3x" | "next";

/** A mu build under test: a directory holding dist/ and skills/. */
export interface Surface {
  name: string;
  root: string;
  /** Command dialect; reaches scenarios as EVAL_SURFACE_FAMILY in the sandbox env. Default "3x". */
  family?: Family;
  /** Where this surface's `<id>.<kind>.<family>.json` scripts and optional scenario overrides live; never inside SURFACES_DIR. Default tools/eval/scenarios. */
  scenarioRoot?: string;
  /** <root>/dist/cli.js */
  cli: string;
  /** <root>/dist/extension/mu-pi.js */
  extension: string;
  /** <root>/skills/mu */
  skillDir: string;
}

export interface Sandbox {
  dir: string;
  env: Record<string, string>;
  binDir: string;
  repoDir: string;
  workerDir: string;
  tmuxSocket: string;
  dbPath: string;
  surface: Surface;
  close(opts?: { keep?: boolean }): Promise<void>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  output: string;
  /** The tool result's structured `details` (what the tool recorded), when it returned any. */
  details?: Record<string, unknown>;
  exitCode: number | null;
  durationMs: number | null;
  /**
   * The index (from 0) of the assistant message that issued the call, over every assistant message
   * of the run, and the call's position in that message. MetricsCollector fills both; a synthetic
   * call (a probe answer's, nextstep.ts `answerMetrics`) or an old row has neither, and is then
   * unplaceable for attribution (exposure.ts).
   */
  turn?: number;
  idx?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export type Aborted = null | "timeout" | "token-cap" | "exit" | "crash";

/** One observed moment of the AUT's life, stamped when the harness read it from the rpc stream. */
export type LifecycleKind =
  | "prompt" // the harness sent the scenario prompt or a prod
  | "agent_start"
  | "agent_end" // the AUT's run ended: a turn end
  | "agent_settled"
  | "tool_start"
  | "tool_end"
  | "delegate_msg" // a custom message (mu-delegate delivery, a settle entry) entered the conversation
  | "assistant_text"; // an assistant message with text and no tool call: a stop attempt

export interface LifecycleEvent {
  /** Epoch ms at which the harness read the event. */
  t: number;
  kind: LifecycleKind;
  /** tool_start/tool_end: the toolCallId (matches ToolCall.id). */
  id?: string;
  /** tool_start/tool_end: tool name; delegate_msg: the custom message type. */
  name?: string;
  /** delegate_msg / assistant_text: the message text; prompt: what the harness sent. */
  text?: string;
}

export interface RunMetrics {
  usage: Usage;
  turns: number;
  toolCalls: ToolCall[];
  muCalls: number;
  muErrors: number;
  prods: number;
  wallMs: number;
  aborted: Aborted;
  lastError: string | null;
  finalText: string;
  /** Timestamped lifecycle record. Observed only: the observer never repairs or injects. */
  events: LifecycleEvent[];
}

/** Where a destructive entry came from (spec §5.2): the four effect rules, or a scenario's own `extra.destructive`. */
export type DestructiveSource =
  | "genericDestructive"
  | "destructiveOps"
  | "localWrites"
  | "lostWork"
  | "scenario"
  /** A `destructive[]` entry with no `destructiveFx` counterpart (an old row, a judge that threw): unplaced. */
  | "unknown";

/**
 * One destructive entry with its placement: the tool call (assistant message `turn`, position
 * `idx`) that ran it, or null when it has no time (lostWork, a scenario's entry) or falls in no
 * placed tool call. exposure.ts `attribute` decides attribution from it.
 */
export interface DestructiveFx {
  entry: string;
  at: { turn: number; idx: number } | null;
  source: DestructiveSource;
}

/** One of the AUT's mu invocations (the shim's log) and the tool call it ran in (`muIn`), if any. */
export interface VerdictMuCall {
  argv: string;
  exit: number;
  toolCallId: string | null;
}

export interface Verdict {
  completed: boolean;
  /** Native guarantees the surface cannot give (baseline 3.x): "completed" is then a manual workaround, never the guarantee. */
  na?: string[];
  wrong: string[];
  destructive: string[];
  /** `destructive` entries with placement, same order. Absent on old rows and hand-built verdicts. */
  destructiveFx?: DestructiveFx[];
  /** The AUT's mu calls placed in their tool calls (verdictFx), for behaviour exposure. */
  muCalls?: VerdictMuCall[];
  /** The AUT's rig reads (rig-guard.ts): set means an invalid run, `completed` false, out of every count. */
  rigReads?: string[];
  notes: string[];
}

export interface Scenario {
  id: string;
  title: string;
  prompt: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  tokenCap?: number;
  quietMs?: number;
  maxProds?: number;
  /** `check` run mode of this scenario (default quietMs 2000, maxProds 0): prod-enabled when a bad needs a prod to recover. */
  check?: { quietMs?: number; maxProds?: number };
  /** The families this scenario has scripts for; `check` skips it on the others. Default: both. */
  families?: Family[];
  /** The workstream the scenario seeds and a pane AUT orchestrates (default `eval`). */
  workstream?: string;
  /**
   * Hook-harness scenario: the sandbox gets claude, codex, cursor-agent and Muse Code binaries
   * (fake in `check`, the user's in a live run) and the rig's hook entries (harness.ts).
   */
  hookHarnesses?: {
    /** The worker mix the prompt asks for, for the docs and the report: `claude`, `pi@dev`, ... */
    workers: string[];
    /** The AUT harnesses the case runs under; default all five (harness.ts AUT_HARNESSES). */
    aut?: ("pi" | "claude" | "codex" | "cursor-agent" | "muse")[];
    /**
     * A case whose worker mix a run may choose (`--workers`, mix.ts): its roles in order (E1's
     * `d1`, `d2`; E3's `implementer`, `reviewer`) and the harness each runs in this binding.
     * Absent: the mix is fixed.
     */
    mix?: { roles: string[]; harnesses: string[] };
  };
  /**
   * This case for one run: the AUT's harness and model (`--model`, as the rig passes it; absent:
   * unknown) and, for a case with a `mix`, the worker harnesses (in `roles` order; absent: the
   * case's own). The prompt, title and judge name the bound harnesses. mix.ts `bindScenario` calls
   * it; absent: the case reads the same for every run.
   */
  bind?(o: { aut: string; model?: string; workers?: readonly string[] }): Scenario;
  /**
   * A crash and a replacement orchestrator: the AUT dies (its script's `{die}` in `check`, or the
   * rig kills it once `crashWhen` holds in a live run), and a second AUT gets `prompt`.
   */
  replacement?: { prompt: string; crashWhen?: (sb: Sandbox) => Promise<boolean> };
  setup(sb: Sandbox): Promise<void>;
  judge(sb: Sandbox, run: RunMetrics): Promise<Verdict>;
}

export interface RunResult {
  scenario: string;
  surface: string;
  model: string;
  /** The AUT's harness (absent: pi, every result before hook-harness scenarios). */
  harness?: string;
  /** The worker harnesses of a case with a chosen mix (`--workers`, or the case's own), in its roles' order. */
  workers?: string[];
  rep: number;
  startedAt: string;
  metrics: RunMetrics;
  verdict: Verdict;
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
