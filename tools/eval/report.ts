// results JSONL -> markdown table: one row per scenario x surface x model, then totals per surface x model.
import type { RunResult } from "./types.ts";

export const HEADERS = [
  "Scenario",
  "Surface",
  "Model",
  "Completed",
  "N/A",
  "Mean tokens",
  "Mean mu calls",
  "Mean mu errors",
  "Wrong",
  "Destructive",
  "Prods",
  "Aborted",
];

function row(label: string, surface: string, model: string, rs: RunResult[]): string[] {
  const n = rs.length;
  const sum = (f: (r: RunResult) => number): number => rs.reduce((a, r) => a + f(r), 0);
  const mean = (f: (r: RunResult) => number, digits: number): string =>
    n === 0 ? "0" : (sum(f) / n).toFixed(digits);
  return [
    label,
    surface,
    model,
    `${rs.filter((r) => r.verdict.completed).length}/${n}`,
    String(sum((r) => r.verdict.na?.length ?? 0)),
    mean((r) => r.metrics.usage.total, 0),
    mean((r) => r.metrics.muCalls, 1),
    mean((r) => r.metrics.muErrors, 1),
    String(sum((r) => r.verdict.wrong.length)),
    String(sum((r) => r.verdict.destructive.length)),
    String(sum((r) => r.metrics.prods)),
    String(rs.filter((r) => r.metrics.aborted !== null).length),
  ];
}

function groupBy(rs: RunResult[], key: (r: RunResult) => string): Map<string, RunResult[]> {
  const m = new Map<string, RunResult[]>();
  for (const r of rs) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

export function toMarkdown(results: RunResult[]): string {
  const lines = [`| ${HEADERS.join(" | ")} |`, `|${HEADERS.map(() => " --- ").join("|")}|`];
  const add = (cells: string[]): void => {
    lines.push(`| ${cells.join(" | ")} |`);
  };
  for (const rs of groupBy(
    results,
    (r) => `${r.scenario}\u0000${r.surface}\u0000${r.model}`,
  ).values()) {
    const first = rs[0];
    if (first) add(row(first.scenario, first.surface, first.model, rs));
  }
  for (const rs of groupBy(results, (r) => `${r.surface}\u0000${r.model}`).values()) {
    const first = rs[0];
    if (first) add(row("**total**", first.surface, first.model, rs));
  }
  // N/A: native guarantees a surface cannot give. Its Completed is a manual workaround, not the guarantee.
  const na = new Map<string, Set<string>>();
  for (const r of results) {
    for (const x of r.verdict.na ?? []) {
      const key = `${r.scenario} on ${r.surface}`;
      na.set(key, (na.get(key) ?? new Set()).add(x));
    }
  }
  if (na.size > 0) {
    lines.push(
      "",
      "N/A = native guarantee the surface does not have. Completed on such a row is a manual workaround, not the guarantee:",
    );
    for (const [key, set] of na) lines.push(`- ${key}: ${[...set].join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}
