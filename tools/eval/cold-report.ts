// cold-guess.jsonl -> the short markdown of docs/mu-next/eval/cold-guess.md. Pure.
import type { ColdRow } from "./cold-guess.ts";
import { INTENTS } from "./cold-intents.ts";

const pct = (hit: number, n: number): string =>
  n === 0 ? "-" : `${Math.round((100 * hit) / n)}% (${hit}/${n})`;
const hits = (rs: ColdRow[]): number => rs.filter((r) => r.hit).length;
/** `67% (4/6)`, plus `+2 partial` when some misses were the right first step (a close preview). */
const rate = (rs: ColdRow[]): string => {
  const part = rs.filter((r) => !r.hit && r.partial).length;
  return `${pct(hits(rs), rs.length)}${part > 0 ? ` +${part} partial` : ""}`;
};
const short = (m: string): string => m.split("/").pop() ?? m;
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

/** What a reach looks like in a table: `task show -w`, `sql [tasks]`. */
export function reachLabel(r: ColdRow): string {
  if (r.reach === null) return r.command === null ? "(no command)" : "(no mu call)";
  const flags = r.reach.flags.filter((f) => f !== "-w" && f !== "--workstream" && f !== "--json");
  const sql =
    r.reach.verb === "sql" && r.reach.tables.length > 0 ? ` [${r.reach.tables.join(",")}]` : "";
  return `${r.reach.verb || "?"}${flags.length ? ` ${flags.join(" ")}` : ""}${sql}`;
}

/** Most common value; ties go to the one seen first. */
function modal(xs: string[]): { value: string; n: number } {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  let best = { value: "", n: 0 };
  for (const [value, n] of c) if (n > best.n) best = { value, n };
  return best;
}

export function toColdMarkdown(rows: ColdRow[], opts: { topWrong?: number } = {}): string {
  const surfaces = uniq(rows.map((r) => r.surface));
  const models = uniq(rows.map((r) => r.model));
  const intents = uniq(rows.map((r) => r.intent));
  const groups = uniq(rows.map((r) => r.group));
  const of = (f: (r: ColdRow) => boolean): ColdRow[] => rows.filter(f);
  const out: string[] = [];

  const builds = uniq(rows.map((r) => `${r.surface} = mu ${r.version} (help ${r.helpSha})`));
  out.push(
    "## Method (from the rows)",
    "",
    `${rows.length} guesses; builds: ${builds.join("; ")}; models: ${models.map(short).join(", ")}; ${uniq(rows.map((r) => r.rep)).length} reps. The model got only \`mu --help\` (no skill, no tools) and one sentence; its single command ran in a fresh seeded sandbox. **Hit** = the state or the command's own output shows the effect, with no stray write (judged by state, never spelling). **Partial** = a miss that was the right first step (a close preview whose \`--if\` apply was not run).`,
    "",
  );
  out.push("## Intents", "");
  out.push(
    table(
      ["Intent", "Group", "Request (verbatim)"],
      intents.map((i) => {
        const d = INTENTS.find((x) => x.id === i);
        return [i, d?.group ?? "", d?.text ?? ""];
      }),
    ),
    "",
  );
  out.push("## Hit rate per surface and model", "");
  out.push(
    table(
      [
        "Surface",
        "Version",
        "Model",
        "Hit",
        "Parsed",
        "Exit 0",
        "Partial",
        "Destructive",
        "Stray ops",
        "Mean tokens",
      ],
      surfaces.flatMap((s) =>
        models
          .map((m) => {
            const rs = of((r) => r.surface === s && r.model === m);
            if (rs.length === 0) return null;
            const n = rs.length;
            return [
              s,
              rs[0]?.version ?? "",
              short(m),
              pct(hits(rs), n),
              pct(rs.filter((r) => r.parsed).length, n),
              pct(rs.filter((r) => r.exit === 0).length, n),
              String(rs.filter((r) => r.partial).length),
              String(rs.filter((r) => r.destructive).length),
              String(rs.filter((r) => r.stray.length > 0).length),
              String(Math.round(rs.reduce((a, r) => a + r.tokens, 0) / n)),
            ];
          })
          .filter((r): r is string[] => r !== null),
      ),
    ),
    "",
  );

  // the comparison that matters: intents every surface ran (an intent one surface cannot express at all is not a shape comparison)
  const common = intents.filter((i) =>
    surfaces.every((s) => of((r) => r.intent === i && r.surface === s).length > 0),
  );
  out.push("## Hit rate on the intents every surface ran", "");
  out.push(
    table(
      ["Surface", "Model", `Hit (${common.length} intents)`],
      surfaces.flatMap((s) =>
        [...models, null].map((m) => {
          const rs = of(
            (r) => common.includes(r.intent) && r.surface === s && (m === null || r.model === m),
          );
          return [s, m === null ? "both" : short(m), pct(hits(rs), rs.length)];
        }),
      ),
    ),
    "",
  );
  out.push("## Hit rate per intent", "");
  out.push(
    "Each cell: hits/guesses over both models and all reps; then the modal first reach of the misses. `-` = the surface has no way to do it.",
    "",
  );
  out.push(
    table(
      [
        "Intent",
        "Group",
        ...surfaces.map((s) => `${s} hit`),
        ...surfaces.map((s) => `${s} modal miss`),
      ],
      intents.map((i) => {
        const g = of((r) => r.intent === i)[0]?.group ?? "";
        return [
          i,
          g,
          ...surfaces.map((s) => rate(of((r) => r.intent === i && r.surface === s))),
          ...surfaces.map((s) => {
            const miss = of((r) => r.intent === i && r.surface === s && !r.hit);
            if (miss.length === 0) return "";
            const m = modal(miss.map(reachLabel));
            return `${m.value} (${m.n}/${miss.length})`;
          }),
        ];
      }),
    ),
    "",
  );

  out.push("## Hit rate per intent and model", "");
  out.push(
    table(
      ["Intent", ...surfaces.flatMap((s) => models.map((m) => `${s} ${short(m)}`))],
      intents.map((i) => [
        i,
        ...surfaces.flatMap((s) =>
          models.map((m) => {
            const rs = of((r) => r.intent === i && r.surface === s && r.model === m);
            return rs.length ? `${hits(rs)}/${rs.length}` : "-";
          }),
        ),
      ]),
    ),
    "",
  );

  out.push("## Hit rate per verb group", "");
  out.push(
    table(
      ["Group", ...surfaces.map((s) => `${s} hit`)],
      groups.map((g) => [
        g,
        ...surfaces.map((s) => {
          const rs = of((r) => r.group === g && r.surface === s);
          return pct(hits(rs), rs.length);
        }),
      ]),
    ),
    "",
  );

  out.push("## First verb reached (all guesses)", "");
  out.push(
    table(
      ["Intent", ...surfaces.map((s) => `${s} first reach (count)`)],
      intents.map((i) => [
        i,
        ...surfaces.map((s) => {
          const rs = of((r) => r.intent === i && r.surface === s);
          if (rs.length === 0) return "";
          const c = new Map<string, number>();
          for (const r of rs) c.set(reachLabel(r), (c.get(reachLabel(r)) ?? 0) + 1);
          return [...c]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, n]) => `${k} ×${n}`)
            .join("; ");
        }),
      ]),
    ),
    "",
  );

  out.push("## Top wrong guesses", "");
  for (const s of surfaces) {
    const miss = of((r) => r.surface === s && !r.hit);
    const byKey = new Map<string, { n: number; why: string; err: string; cmd: string }>();
    for (const r of miss) {
      const k = `${r.intent} · ${reachLabel(r)}`;
      const cur = byKey.get(k);
      if (cur) cur.n++;
      else
        byKey.set(k, {
          n: 1,
          why: r.why[0] ?? "",
          err: r.firstError,
          cmd: r.command?.split("\n")[0] ?? "",
        });
    }
    out.push(`### ${s}`, "");
    const top = [...byKey].sort((a, b) => b[1].n - a[1].n).slice(0, opts.topWrong ?? 12);
    out.push(
      table(
        ["×", "Intent · first reach", "Example command", "Why it missed", "First error line"],
        top.map(([k, v]) => [String(v.n), k, `\`${v.cmd.slice(0, 110)}\``, v.why, v.err]),
      ),
      "",
    );
  }

  const bad = of((r) => r.destructive || r.modelError !== undefined);
  if (bad.length > 0) {
    out.push("## Destructive guesses and model errors", "");
    out.push(
      table(
        ["Surface", "Model", "Intent", "Note"],
        bad.map((r) => [
          r.surface,
          short(r.model),
          r.intent,
          r.destructive
            ? `destructive: ${r.command?.split("\n")[0] ?? ""}`
            : `model error: ${r.modelError}`,
        ]),
      ),
      "",
    );
  }
  return `${out.join("\n").trimEnd()}\n`;
}
