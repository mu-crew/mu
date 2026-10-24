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
  exitCode: number | null;
  durationMs: number | null;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export type Aborted = null | "timeout" | "token-cap" | "exit";

/** One observed moment of the AUT's life, stamped when the harness read it from the rpc stream. */
export type LifecycleKind =
  | "prompt" // the harness sent the scenario prompt or a prod
  | "agent_start"
  | "agent_end" // the AUT's run ended: a turn end
  | "agent_settled"
  | "tool_start"
  | "tool_end"
  | "delegate_msg" // a custom message (mu-delegate delivery) entered the conversation
  | "assistant_text"; // an assistant message with text and no tool call: a stop attempt

export interface LifecycleEvent {
  /** Epoch ms at which the harness read the event. */
  t: number;
  kind: LifecycleKind;
  /** tool_start/tool_end: the toolCallId (matches ToolCall.id). */
  id?: string;
  /** tool_start/tool_end: tool name; delegate_msg: the custom message type. */
  name?: string;
  /** delegate_msg / assistant_text: the message text. */
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

export interface Verdict {
  completed: boolean;
  wrong: string[];
  destructive: string[];
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
  setup(sb: Sandbox): Promise<void>;
  judge(sb: Sandbox, run: RunMetrics): Promise<Verdict>;
}

export interface RunResult {
  scenario: string;
  surface: string;
  model: string;
  rep: number;
  startedAt: string;
  metrics: RunMetrics;
  verdict: Verdict;
}
