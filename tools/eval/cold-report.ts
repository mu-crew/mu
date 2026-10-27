// cold-guess.jsonl -> the short markdown of docs/eval/cold-guess.md. Pure.
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

/** Per intent, a surface wins when it hits at least this many more of the guesses (a 1-guess gap is noise: reps are correlated). */
export const DECISIVE = 2;

export interface Versus {
  intent: string;
  a: { hit: number; n: number };
  b: { hit: number; n: number };
  /** `win` = the first surface hits DECISIVE or more guesses over the second. */
  result: "win" | "loss" | "tie";
}

/** Per intent every surface ran, `a` against `b`, over both models and all reps. */
export function versus(rows: ColdRow[], a: string, b: string, role: ColdRow["role"]): Versus[] {
  const ids = uniq(rows.filter((r) => r.role === role).map((r) => r.intent));
  const out: Versus[] = [];
  for (const intent of ids) {
    const ra = rows.filter((r) => r.intent === intent && r.surface === a);
    const rb = rows.filter((r) => r.intent === intent && r.surface === b);
    if (ra.length === 0 || rb.length === 0) continue;
    const d = hits(ra) - hits(rb);
    out.push({
      intent,
      a: { hit: hits(ra), n: ra.length },
      b: { hit: hits(rb), n: rb.length },
      result: d >= DECISIVE ? "win" : d <= -DECISIVE ? "loss" : "tie",
    });
  }
  return out;
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
    `${rows.length} guesses; builds: ${builds.join("; ")}; models: ${models.map(short).join(", ")}; ${uniq(rows.map((r) => r.rep)).length} reps. The model got only the bundled help (\`mu --help\` plus \`mu <group> --help\` of every group, the same depth on every surface; no skill, no tools) and one sentence; its single command ran in a fresh seeded sandbox. **Hit** = the state or the command's own output shows the effect, with no stray write (judged by state, never spelling). **Partial** = a miss that was the right first step (a close preview whose \`--if\` apply was not run).`,
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
  // the headline: pre-registered intents every surface ran; controls and one-surface intents are reported apart
  const shared = (role: ColdRow["role"]): string[] =>
    intents.filter(
      (i) =>
        of((r) => r.intent === i)[0]?.role === role &&
        surfaces.every((s) => of((r) => r.intent === i && r.surface === s).length > 0),
    );
  const headline = shared("headline");
  const controls = shared("control");
  const only = intents.filter(
    (i) =>
      !headline.includes(i) &&
      !controls.includes(i) &&
      of((r) => r.intent === i)[0]?.role === "headline",
  );
  const rowsOf = (ids: string[], s: string, m: string | null): ColdRow[] =>
    of((r) => ids.includes(r.intent) && r.surface === s && (m === null || r.model === m));
  const [first, second] = surfaces;
  out.push(`## Headline: the ${headline.length} pre-registered intents every surface ran`, "");
  out.push(
    table(
      [
        "Surface",
        "Model",
        `Hit (${headline.length} intents)`,
        "Parsed",
        "Exit 0",
        "Destructive",
        "Stray ops",
        "Mean tokens",
      ],
      surfaces.flatMap((s) =>
        [...models, null].map((m) => {
          const rs = rowsOf(headline, s, m);
          const n = rs.length;
          return [
            s,
            m === null ? "both" : short(m),
            pct(hits(rs), n),
            pct(rs.filter((r) => r.parsed).length, n),
            pct(rs.filter((r) => r.exit === 0).length, n),
            String(rs.filter((r) => r.destructive).length),
            String(rs.filter((r) => r.stray.length > 0).length),
            n === 0 ? "-" : String(Math.round(rs.reduce((a, r) => a + r.tokens, 0) / n)),
          ];
        }),
      ),
    ),
    "",
  );
  if (first !== undefined && second !== undefined) {
    const v = versus(rows, first, second, "headline");
    const count = (k: Versus["result"]): number => v.filter((x) => x.result === k).length;
    out.push(
      `**Per intent, ${first} vs ${second}: ${count("win")} wins, ${count("loss")} losses, ${count("tie")} ties.** The intent, not the guess, is the unit: reps and models of one intent share a cause, so the guess-level percentage above is not an interval. A win or loss needs a gap of at least ${DECISIVE} hits (of ${v[0]?.a.n ?? 0} guesses); a smaller gap is a tie.`,
      "",
    );
    out.push(
      table(
        ["Intent", `${first} hit`, `${second} hit`, "Result"],
        v.map((x) => [
          x.intent,
          `${x.a.hit}/${x.a.n}`,
          `${x.b.hit}/${x.b.n}`,
          x.result === "win" ? `${first} wins` : x.result === "loss" ? `${second} wins` : "tie",
        ]),
      ),
      "",
    );
  }
  if (only.length > 0)
    out.push(
      `Pre-registered but run on one surface only (not in the headline): ${only
        .map(
          (i) =>
            `${i} (${surfaces
              .map((s) => rate(of((r) => r.intent === i && r.surface === s)))
              .filter((x) => x !== "-")
              .join("; ")})`,
        )
        .join(", ")}.`,
      "",
    );
  if (controls.length > 0) {
    out.push("## Controls (added after the first pass; not in the headline)", "");
    out.push(
      table(
        ["Control", ...surfaces.map((s) => `${s} hit`)],
        controls.map((i) => [
          i,
          ...surfaces.map((s) => rate(of((r) => r.intent === i && r.surface === s))),
        ]),
      ),
      "",
    );
  }

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
        "Role",
        ...surfaces.map((s) => `${s} hit`),
        ...surfaces.map((s) => `${s} modal miss`),
      ],
      intents.map((i) => {
        const g = of((r) => r.intent === i)[0]?.group ?? "";
        return [
          i,
          g,
          of((r) => r.intent === i)[0]?.role ?? "",
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

  out.push("## Hit rate per verb group (headline intents)", "");
  out.push(
    table(
      ["Group", ...surfaces.map((s) => `${s} hit`)],
      groups.map((g) => [
        g,
        ...surfaces.map((s) => {
          const rs = of((r) => r.group === g && r.surface === s && headline.includes(r.intent));
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
