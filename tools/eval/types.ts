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
