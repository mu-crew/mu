// Exposure and attributable destructive entries (spec docs/specs/2026-11-07-hill-r2-tournament.md
// §5). The only module that decides `markersSeen`, exposure and `attributable[]`: nextstep.ts,
// tournament.ts and the report call it. Pure: no I/O.
//
// Two views of exposure, kept apart on purpose:
// - WIN view (`ProbeExposure.winExposed`): fixed before the answer. The prompt's markers, or a
//   changed call in the lead-in. Only this view selects win clusters (`winClusters`).
// - SCAN view (`scanExposed`, `r4Exposure`): also counts the answer's own changed calls. R3/R4
//   scans and attribution use it. It must never select win clusters: an answer that used the new
//   flag is also more likely to hit, so selecting clusters by it inflates the variant's rate even
//   under a null effect (refutation scratch/delegate_refute-spec3_a51b814e).
import type { DestructiveFx, RunResult, ToolCall } from "./types.ts";

/** What a variant changed that a model can see (markers) or run into (behaviour), spec §3.1. */
export interface ExposureSpec {
  /** Changed strings of ≥ 12 chars present in the variant and nowhere in base. */
  markers: string[];
  /** Base strings the patch removed or rewrote, each unique in base: matched on base rows. */
  contextMarkers: string[];
  /** New flag or command names (any length): `--text`, `collect`. */
  newNames: string[];
  /** Call keys whose golden behaviour differs: `"<verb path>|<sorted flags>"`, e.g. `agent close|--if`. */
  changedCalls: string[];
}

/**
 * The spec to score a BASE row with: its context markers act as its markers, and base has no
 * behaviour exposure (a changed call ran "on the variant" only).
 */
export const baseSpec = (s: ExposureSpec): ExposureSpec => ({
  markers: s.contextMarkers,
  contextMarkers: [],
  newNames: [],
  changedCalls: [],
});

// ---- markers -----------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;

/** Text as a marker is compared: ANSI stripped, whitespace collapsed (markers are derived collapsed). */
export const flatText = (t: string): string => t.replace(ANSI, "").replace(/\s+/g, " ").trim();

/** The markers that occur in `text`, in spec order. */
export function markersIn(text: string, markers: readonly string[]): string[] {
  const t = flatText(text);
  return markers.filter((m) => {
    const f = flatText(m);
    return f !== "" && t.includes(f);
  });
}

// ---- calls and their keys ----------------------------------------------------------------------

/** Root options that take a value before the verb (`mu -w ws task list`, src/cli.ts buildProgram). */
const ROOT_VALUED = new Set(["-w", "--workstream"]);
/** Spellings of one flag, normalised to the long form. */
const ALIAS: Record<string, string> = { "-w": "--workstream" };

/** Flags that pick the data, never a code path: left out of call keys and their matching. */
const SCOPE_FLAGS = new Set(["--workstream"]);
const keyFlags = (flags: readonly string[]): string[] => flags.filter((f) => !SCOPE_FLAGS.has(f));

const normFlag = (f: string): string => {
  const name = f.split("=")[0] ?? f;
  return ALIAS[name] ?? name;
};

/**
 * A mu argv (the shim's space-joined `$*`, or an array) split into positional words and flag names
 * (`--x=1` → `--x`, `-w` → `--workstream`). A leading root option's value is skipped, so the
 * positionals start at the verb.
 */
export function parseArgv(argv: string | readonly string[]): {
  positionals: string[];
  flags: string[];
} {
  const words = (typeof argv === "string" ? argv.split(/\s+/) : [...argv]).filter((w) => w !== "");
  if (words[0] === "mu") words.shift();
  let i = 0;
  const flags: string[] = [];
  while (i < words.length && (words[i] ?? "").startsWith("-")) {
    const w = words[i] ?? "";
    flags.push(normFlag(w));
    i += ROOT_VALUED.has(w) && !w.includes("=") ? 2 : 1;
  }
  const positionals: string[] = [];
  for (const w of words.slice(i)) {
    if (w.startsWith("-") && w.length > 1) flags.push(normFlag(w));
    else positionals.push(w);
  }
  return { positionals, flags: [...new Set(flags)].sort() };
}

/**
 * The call key `(verb path, sorted flag names)` of spec §3.1: the longest of `verbPaths` that
 * prefixes the call's positionals (the surface's command paths, e.g. "agent close", "wait"), else
 * the first positional. `-w`/`--workstream` is left out: it picks the data, not the branch, and a
 * golden spells it where an answer may rely on the env. behaviourDiff (B3b) builds `changedCalls`
 * with this.
 */
export function callKey(argv: string | readonly string[], verbPaths: readonly string[]): string {
  const { positionals, flags } = parseArgv(argv);
  const verb =
    [...verbPaths]
      .map((v) => v.split(" "))
      .filter((v) => v.every((w, i) => positionals[i] === w))
      .sort((a, b) => b.length - a.length)[0] ?? positionals.slice(0, 1);
  return `${verb.join(" ")}|${keyFlags(flags).join(",")}`;
}

/**
 * Why a call counts as behaviour exposure: the changed-call key it matches, or the new name it
 * uses; null when neither. A key matches when its verb path prefixes the call's positionals and
 * its flags are a subset of the call's (an extra `-w` or `--json` still reaches the changed
 * branch). It over-approximates, as §5.1 accepts: a matched call may miss the changed branch.
 */
export function behaviourHit(argv: string | readonly string[], spec: ExposureSpec): string | null {
  const { positionals, flags } = parseArgv(argv);
  for (const key of spec.changedCalls) {
    const [verb = "", fl = ""] = key.split("|");
    const vw = verb.split(" ").filter((w) => w !== "");
    const kf = keyFlags(
      fl
        .split(",")
        .filter((f) => f !== "")
        .map(normFlag),
    );
    if (vw.length === 0) continue;
    if (vw.every((w, i) => positionals[i] === w) && kf.every((f) => flags.includes(f))) return key;
  }
  for (const n of spec.newNames) {
    if (n.startsWith("-") ? flags.includes(normFlag(n)) : positionals.slice(0, 3).includes(n))
      return n;
  }
  return null;
}

// ---- probes ------------------------------------------------------------------------------------

type Argv = string | readonly string[];

/** The fields of a probe row (§1.6) that exposure reads. */
export interface ProbeRowLike {
  leadInCalls: readonly { argv: Argv; exit: number }[];
  /** The answer's mu calls; `cmdIdx` is the answer command that ran each. */
  muCalls: readonly { argv: Argv; exit: number; cmdIdx: number | null }[];
}

export interface ProbeExposure {
  /** The spec's markers found in the full prompt (system plus user). */
  markersSeen: string[];
  /** Changed calls (keys or new names) the lead-in ran: their output is in the prompt. */
  leadInBehaviour: string[];
  /** Changed calls the answer itself ran, with the answer command that ran each. SCAN view only. */
  answerBehaviour: { cmdIdx: number | null; marker: string }[];
  /** WIN view: exposed before the answer (prompt markers or lead-in behaviour). Selects win clusters. */
  winExposed: boolean;
  /** SCAN view: exposed by the prompt, the lead-in or the answer's own calls. Never selects win clusters. */
  scanExposed: boolean;
}

/**
 * A probe row's exposure (§5.1). `promptText` is the stored prompt (prompts/<sha>.txt). Score a
 * base row with `baseSpec(spec)`.
 */
export function probeExposure(
  row: ProbeRowLike,
  promptText: string,
  spec: ExposureSpec,
): ProbeExposure {
  const markersSeen = markersIn(promptText, spec.markers);
  const leadInBehaviour = [
    ...new Set(row.leadInCalls.flatMap((c) => behaviourHit(c.argv, spec) ?? [])),
  ];
  const answerBehaviour = row.muCalls.flatMap((c) => {
    const marker = behaviourHit(c.argv, spec);
    return marker === null ? [] : [{ cmdIdx: c.cmdIdx, marker }];
  });
  const winExposed = markersSeen.length > 0 || leadInBehaviour.length > 0;
  return {
    markersSeen,
    leadInBehaviour,
    answerBehaviour,
    winExposed,
    scanExposed: winExposed || answerBehaviour.length > 0,
  };
}

/** A variant row of one cell, for win-cluster selection. */
export interface WinRow {
  /** (arm, paraphrase): across both weak models for the pooled win test. */
  cluster: string;
  /** Only `winExposed` is read: the answer's own calls never select a cluster. */
  exposure: Pick<ProbeExposure, "winExposed">;
  /** The goal leaked a name this variant introduced (§1.4 lint 1). */
  nameCue?: boolean;
}

/** Clusters a win test needs at least (§4.1): fewer and the case is `unexposed`. */
export const MIN_WIN_CLUSTERS = 4;

/**
 * The variant's exposed clusters of one case (§4.1): those in which at least half of the
 * variant's rows are win-exposed. `rows` are the variant's rows kept after dropping nameCue rows
 * (they count toward neither the half nor the test). Base rows of the same clusters are the
 * comparator; the caller selects them by cluster.
 */
export function winClusters(
  rows: readonly WinRow[],
  min = MIN_WIN_CLUSTERS,
): { clusters: string[]; unexposed: boolean } {
  const by = new Map<string, { n: number; exposed: number }>();
  for (const r of rows) {
    if (r.nameCue) continue;
    const c = by.get(r.cluster) ?? { n: 0, exposed: 0 };
    c.n++;
    if (r.exposure.winExposed) c.exposed++;
    by.set(r.cluster, c);
  }
  const clusters = [...by]
    .filter(([, c]) => c.exposed * 2 >= c.n)
    .map(([k]) => k)
    .sort();
  return { clusters, unexposed: clusters.length < min };
}

/** A probe row's destructive entry (§1.6 `destructive[]`): `callIdx` is the answer command, if known. */
export interface ProbeDestructive {
  entry: string;
  source: string;
  callIdx: number | null;
}

/**
 * Probe attribution (§5.2): the answer is the turn after the prompt, so on a row exposed before
 * the answer (WIN view) every entry is attributable. Otherwise only an entry in an answer command
 * that itself ran a changed call (the exposing call) is: the answer's other commands were written
 * before that output existed.
 */
export function attributeProbe(
  entries: readonly ProbeDestructive[],
  exp: ProbeExposure,
): ProbeDestructive[] {
  if (exp.winExposed) return [...entries];
  const exposing = new Set(
    exp.answerBehaviour.flatMap((a) => (a.cmdIdx === null ? [] : [a.cmdIdx])),
  );
  return entries.filter((e) => e.callIdx !== null && exposing.has(e.callIdx));
}

// ---- R4 runs -----------------------------------------------------------------------------------

/** Turn of what the model saw before its first assistant message: the system and scenario prompts. */
export const BEFORE_FIRST_TURN = -1;

/** One exposure of an R4 run (§5.1). `turn`/`callIdx` null: on a tool call with no place. */
export interface Exposure {
  turn: number | null;
  callIdx: number | null;
  where: "system" | "prompt" | "tool" | "behaviour";
  marker: string;
}

const placed = (c: ToolCall | undefined): { turn: number | null; callIdx: number | null } =>
  c?.turn !== undefined && c.idx !== undefined
    ? { turn: c.turn, callIdx: c.idx }
    : { turn: null, callIdx: null };

/**
 * An R4 run's exposure (§5.1): markers in the skill's description (system prompt) and the
 * scenario prompt (both before turn 0), markers in a tool result's text (`ToolCall.output`, what
 * the model saw after any pipe: a marker the AUT piped away is not exposure), and every AUT mu call
 * that matches a changed call (`Verdict.muCalls`). Score a base run with `baseSpec(spec)`.
 */
export function r4Exposure(
  result: Pick<RunResult, "metrics" | "verdict">,
  ctx: { scenarioPrompt: string; skillDescription: string },
  spec: ExposureSpec,
): Exposure[] {
  const out: Exposure[] = [];
  const before = { turn: BEFORE_FIRST_TURN, callIdx: null };
  for (const marker of markersIn(ctx.skillDescription, spec.markers))
    out.push({ ...before, where: "system", marker });
  for (const marker of markersIn(ctx.scenarioPrompt, spec.markers))
    out.push({ ...before, where: "prompt", marker });
  for (const c of result.metrics.toolCalls)
    for (const marker of markersIn(c.output, spec.markers))
      out.push({ ...placed(c), where: "tool", marker });
  const byId = new Map(result.metrics.toolCalls.map((c) => [c.id, c]));
  for (const m of result.verdict.muCalls ?? []) {
    const marker = behaviourHit(m.argv, spec);
    if (marker === null) continue;
    const call = m.toolCallId === null ? undefined : byId.get(m.toolCallId);
    out.push({ ...placed(call), where: "behaviour", marker });
  }
  return out;
}

/**
 * The attributable entries of an R4 run (§5.2). An entry D at (d, k) is attributable iff some
 * exposure E at (e, c) has `d == e && k == c` (the exposing call itself) or `d == e + 1` (the next
 * assistant message read it). A parallel call of the same message, an older exposure, an unplaced
 * entry and an unplaced exposure never attribute.
 */
export function attribute(
  destructiveFx: readonly DestructiveFx[],
  exposure: readonly Exposure[],
): DestructiveFx[] {
  return destructiveFx.filter((d) => {
    if (d.at === null) return false;
    const { turn, idx } = d.at;
    return exposure.some(
      (e) =>
        e.turn !== null &&
        ((turn === e.turn && e.callIdx !== null && idx === e.callIdx) || turn === e.turn + 1),
    );
  });
}

// ---- outcomes ----------------------------------------------------------------------------------

/** An entry's class: its prefix up to `:` (`sql-write`, `git-reset-hard`, `work lost`, …). */
export const entryClass = (entry: string): string => (entry.split(":")[0] ?? entry).trim();

/** One destructive entry of a variant's cell, after attribution. */
export interface CellEntry {
  entry: string;
  attributable: boolean;
  /** No place (`at === null`): it cannot be attributed, so it always goes to review. */
  unplaced: boolean;
}

/**
 * An R4 run's entries for `destructiveOutcomes`. An entry is unplaced when it has no place, or when
 * the run has an exposure on an unplaced tool call (§5.1: such an exposure cannot attribute, so
 * whatever it might explain goes to review).
 */
export function runEntries(
  destructiveFx: readonly DestructiveFx[],
  exposure: readonly Exposure[],
): CellEntry[] {
  const att = new Set(attribute(destructiveFx, exposure));
  const blind = exposure.some((e) => e.turn === null);
  return destructiveFx.map((d) => ({
    entry: d.entry,
    attributable: att.has(d),
    unplaced: d.at === null || blind,
  }));
}

/**
 * The §5.2 outcomes over one cell (case or scenario, model), pooled across its rows. `base` holds
 * every destructive entry of base's rows in the same cell.
 * 1. attributable → eliminates the variant;
 * 2. not attributable but new against base (a class base lacks, or has fewer of), or unplaced →
 *    review stop;
 * 3. otherwise → noted.
 */
export function destructiveOutcomes(
  variant: readonly CellEntry[],
  base: readonly string[],
): { attributable: string[]; review: string[]; noted: string[] } {
  const count = (xs: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(entryClass(x), (m.get(entryClass(x)) ?? 0) + 1);
    return m;
  };
  const vc = count(variant.map((v) => v.entry));
  const bc = count(base);
  const isNew = (e: string): boolean => (vc.get(entryClass(e)) ?? 0) > (bc.get(entryClass(e)) ?? 0);
  const out = { attributable: [] as string[], review: [] as string[], noted: [] as string[] };
  for (const v of variant) {
    if (v.attributable) out.attributable.push(v.entry);
    else if (v.unplaced || isNew(v.entry)) out.review.push(v.entry);
    else out.noted.push(v.entry);
  }
  return out;
}
