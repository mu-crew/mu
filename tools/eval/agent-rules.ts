// Pure helpers for scenario judges over the driver's runs.log. (Judging what mu's verbs did is
// observe.ts: effects in the ops log, the repo and the sandbox's mu-call record, not their spelling.)

export interface RunEntry {
  agent: string;
  task: string;
  action: string;
}

/** Tasks closed by more than one distinct agent: one task was run twice. */
export function tasksRunTwice(runs: RunEntry[]): string[] {
  const by = new Map<string, Set<string>>();
  for (const r of runs)
    if (r.action === "close") by.set(r.task, (by.get(r.task) ?? new Set()).add(r.agent));
  return [...by]
    .filter(([, a]) => a.size > 1)
    .map(([t, a]) => `${t} ran under ${[...a].join(" and ")}`);
}
