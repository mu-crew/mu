// `nextstep report` (spec §7 B2): raw counts of a probe.jsonl, for B5's readout and the check and
// selftest summaries. No DEFF, exposure or test here: those are `tournament report`'s.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProbeRow } from "./nextstep.ts";

export interface ReportFilter {
  round?: string;
  surface?: string;
  model?: string;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();
const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

function cell(rows: ProbeRow[]): string {
  if (rows.length === 0) return "";
  const n = (f: (r: ProbeRow) => boolean): number => rows.filter(f).length;
  return `${n((r) => r.hit)}/${rows.length} (p${n((r) => r.partial)} i${n((r) => r.invalid)} k${n((r) => r.perCommand.some((c) => c.killed))} e${n((r) => r.modelError !== undefined)})`;
}

const table = (head: string[], body: string[][]): string[] => [
  `| ${head.join(" | ")} |`,
  `|${head.map(() => "---").join("|")}|`,
  ...body.map((r) => `| ${r.join(" | ")} |`),
];

/** The report text; code 2 (and a message) on an unreadable or empty jsonl. */
export function nextReport(file: string, f: ReportFilter): { code: number; text: string } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return { code: 2, text: `nextstep report: cannot read ${file}: ${(e as Error).message}\n` };
  }
  let rows: ProbeRow[];
  try {
    rows = raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as ProbeRow)
      .filter((r) => r.kind === "probe");
  } catch (e) {
    return { code: 2, text: `nextstep report: ${file} is not jsonl: ${(e as Error).message}\n` };
  }
  rows = rows.filter(
    (r) =>
      (f.round === undefined || r.round === f.round) &&
      (f.surface === undefined || r.surface === f.surface) &&
      (f.model === undefined || r.model === f.model),
  );
  if (rows.length === 0) return { code: 2, text: `nextstep report: no probe rows in ${file}\n` };
  const models = uniq(rows.map((r) => r.model));
  const out: string[] = [
    "# nextstep probe report",
    "",
    `- file: ${file}`,
    `- sha256: ${createHash("sha256").update(raw).digest("hex")}`,
    `- rows: ${rows.length}`,
    `- rounds: ${uniq(rows.map((r) => r.round)).join(", ")}`,
    `- surfaces: ${uniq(rows.map((r) => r.surface)).join(", ")}`,
    `- models: ${models.join(", ")}`,
    `- systemSha: ${uniq(rows.map((r) => r.systemSha)).join(", ")}`,
    "",
    "Cells: hits/n (p partial, i invalid, k killed, e modelError).",
  ];
  for (const round of uniq(rows.map((r) => r.round)))
    for (const surface of uniq(rows.filter((r) => r.round === round).map((r) => r.surface))) {
      const rs = rows.filter((r) => r.round === round && r.surface === surface);
      const keys = uniq(rs.map((r) => `${r.case}\u0000${r.arm}`));
      out.push(
        "",
        `## ${round} / ${surface}`,
        "",
        ...table(
          ["case", "arm", ...models],
          keys.map((k) => {
            const [c, arm] = k.split("\u0000") as [string, string];
            const here = rs.filter((r) => r.case === c && r.arm === arm);
            return [c, arm, ...models.map((m) => cell(here.filter((r) => r.model === m)))];
          }),
        ),
      );
    }
  out.push("", "## By paraphrase");
  for (const c of uniq(rows.map((r) => r.case))) {
    const rs = rows.filter((r) => r.case === c);
    out.push(
      "",
      `<details><summary>${c}</summary>`,
      "",
      ...table(
        ["paraphrase", ...models],
        uniq(rs.map((r) => r.paraphrase)).map((p) => [
          p,
          ...models.map((m) => {
            const h = rs.filter((r) => r.paraphrase === p && r.model === m);
            return h.length === 0 ? "" : `${h.filter((r) => r.hit).length}/${h.length}`;
          }),
        ]),
      ),
      "",
      "</details>",
    );
  }
  out.push(
    "",
    "## Per model",
    "",
    ...table(
      ["model", "rows", "mean tokens", "mean row ms"],
      models.map((m) => {
        const h = rows.filter((r) => r.model === m);
        return [
          m,
          String(h.length),
          String(mean(h.map((r) => r.tokens))),
          String(mean(h.map((r) => r.ms))),
        ];
      }),
    ),
    "",
  );
  return { code: 0, text: out.join("\n") };
}
