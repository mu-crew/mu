// mu — what a host can run: the harness probe `mu host check` takes through
// the profile's own shell mode, the record it leaves on the profile, and the
// refusal of a spawn for a harness the host lacks (spec D17, D8).
//
// A spawn on a host runs its LITERAL command (`--cli claude` runs `claude`): a
// remote spawn never reads the local `MU_<KEY>_COMMAND`, and a lease job runs
// `sh -c` without rc files, so a variable set in a remote shell rc proves
// nothing there. So `host check` resolves each harness's launcher by name
// (`command -v`) in the shell a spawn's command gets: a session profile's
// login shell (`$SHELL -ilc`, as the ssh starter runs it), a lease job's bare
// `sh -c`. In the same exec it reads each hook harness's own config file (D6
// `hookConfig`) for murmur's `murmur hook <harness>` entries and mu's
// `mu hook stop <harness>` entry (D7, D13). The result and its probe time go
// in `host_profiles.capabilities` (JSON, machine-local).
//
// A spawn is refused (HostHarnessMissingError) only when a probe is recorded,
// the spawn's argv0 is the launcher the probe resolved by name, and the probe
// found no such command. An unprobed host, or a wrapper command the probe did
// not try (`claude-big`, `/opt/x/claude`), is never refused: mu does not guess.

import type { Db } from "./db.js";
import { HARNESSES, type Harness, homeHookConfig, takesMuStopHook } from "./harnesses.js";
import type { HostCheckStep, HostProfile } from "./hosts.js";
import { say } from "./messages.js";
import { shellQuote } from "./shell-quote.js";

/** One harness on one host, as the probe found it. */
export interface HarnessProbe {
  /** The launcher as the profile's shell resolved it (`command -v`); null: not found. */
  command: string | null;
  /** murmur's `murmur hook <harness>` entries in the harness's own config; null: pi (its extension is its own step). */
  murmurHooks: boolean | null;
  /** mu's `mu hook stop <harness>` entry; null where mu installs none (muse cannot block a stop, pi has its nudge). */
  muHooks: boolean | null;
}

/** What `host check` recorded for a host (`host_profiles.capabilities`). */
export interface HostCapabilities {
  /** ISO time of the probe. */
  probedAt: string;
  /** The shell the probe ran in: `login` (a session profile's `$SHELL -ilc`) or `sh` (a lease job's). */
  shell: "login" | "sh";
  harnesses: Record<Harness, HarnessProbe>;
}

/** A spawn for a harness the host's recorded probe did not find. Exit 2, refused before any effect. */
export class HostHarnessMissingError extends Error {
  override readonly name = "HostHarnessMissingError";
  constructor(
    public readonly host: string,
    public readonly harness: Harness,
    public readonly probedAt: string,
  ) {
    super(say("host.harness_missing", host, harness, probedAt));
  }
}

/** The line each harness's answer starts with (a login shell may print rc noise first). */
const MARK = "MU_HARNESS";

/** An ERE matching `<words> <harness>` as one command, not a longer harness name. */
function commandRe(words: string, h: Harness): string {
  return `${words.split(" ").join("[[:space:]]+")}[[:space:]]+${h}([^A-Za-z0-9_.-]|$)`;
}

/**
 * The remote script of the probe (the exec template's `{cmd}`, wrapped in the
 * profile's shell mode by the caller). One line per harness:
 * `MU_HARNESS <harness> <murmur 0|1|-> <mu 0|1|-> <path, empty when not found>`.
 * Hook entries are read for every hook harness, found or not. Never exits 3.
 */
export function harnessProbeScript(): string {
  const lines: string[] = [];
  for (const h of HARNESSES) {
    lines.push(`p=$(command -v ${shellQuote(h)} 2>/dev/null) || p=`);
    const cfg = homeHookConfig(h);
    if (cfg === undefined) {
      lines.push(`printf '${MARK} %s - - %s\\n' ${shellQuote(h)} "$p"`);
      continue;
    }
    const file = `"$HOME"/${shellQuote(cfg)}`;
    lines.push(
      `m=0; grep -Eq ${shellQuote(commandRe("murmur hook", h))} ${file} 2>/dev/null && m=1`,
    );
    lines.push(
      takesMuStopHook(h)
        ? `u=0; grep -Eq ${shellQuote(`(^|[^A-Za-z0-9_.-])${commandRe("mu hook stop", h)}`)} ${file} 2>/dev/null && u=1`
        : "u=-",
    );
    lines.push(`printf '${MARK} %s %s %s %s\\n' ${shellQuote(h)} "$m" "$u" "$p"`);
  }
  return lines.join("\n");
}

const flag = (s: string): boolean | null => (s === "-" ? null : s === "1");

/**
 * The probe's answer, or undefined when stdout holds no line for some
 * harness (a template that ran something else, a shell that died part way).
 */
export function parseHarnessProbe(
  stdout: string,
  shell: HostCapabilities["shell"],
  now: Date = new Date(),
): HostCapabilities | undefined {
  const found = new Map<Harness, HarnessProbe>();
  const re = new RegExp(`^${MARK} (\\S+) ([01-]) ([01-]) ?(.*)$`);
  for (const line of stdout.split("\n")) {
    const m = re.exec(line.trim());
    const h = HARNESSES.find((x) => x === m?.[1]);
    if (m === null || h === undefined) continue;
    const path = (m[4] ?? "").trim();
    found.set(h, {
      command: path === "" ? null : path,
      murmurHooks: flag(m[2] ?? "-"),
      muHooks: flag(m[3] ?? "-"),
    });
  }
  const harnesses = {} as Record<Harness, HarnessProbe>;
  for (const h of HARNESSES) {
    const p = found.get(h);
    if (p === undefined) return undefined;
    harnesses[h] = p;
  }
  return { probedAt: now.toISOString(), shell, harnesses };
}

/** The harnesses the probe found, in table order. */
export function advertised(caps: HostCapabilities): Harness[] {
  return HARNESSES.filter((h) => caps.harnesses[h].command !== null);
}

/** The `harnesses` step's detail when at least one was found, else undefined. */
export function harnessesDetail(caps: HostCapabilities): string | undefined {
  const found = advertised(caps);
  if (found.length === 0) return undefined;
  const missing = HARNESSES.filter((h) => !found.includes(h));
  const listed = found.map((h) => `${h} (${caps.harnesses[h].command})`).join(", ");
  return missing.length === 0 ? listed : `${listed}; not found: ${missing.join(", ")}`;
}

/** The `harnesses` step's failure when the probe found none. */
export function noHarnessDetail(caps: HostCapabilities | undefined): string {
  if (caps === undefined) return "the host printed no harness report";
  const where = caps.shell === "login" ? "the login shell ($SHELL -ilc)" : "a bare sh -c";
  return `none of ${HARNESSES.join(", ")} resolves in ${where}, where a spawn's command runs`;
}

/**
 * The `hooks` step: every hook harness the host has needs murmur's entries in
 * its own config, or its worker reports no state (a spawn ends `unknown`).
 * mu's Stop hook entry is advice only: it never acts for a remote worker (D7),
 * only for an orchestrator started on that host.
 */
export function hooksStep(caps: HostCapabilities): { step: HostCheckStep; warnings: string[] } {
  const hookHarnesses = advertised(caps).filter((h) => h !== "pi");
  if (hookHarnesses.length === 0) {
    return {
      step: { step: "hooks", ok: null, detail: "skipped: no hook harness on the host" },
      warnings: [],
    };
  }
  const missing: string[] = [];
  const warnings: string[] = [];
  for (const h of hookHarnesses) {
    const p = caps.harnesses[h];
    const cfg = `~/${homeHookConfig(h) ?? ""}`;
    if (p.murmurHooks !== true) missing.push(`${h}: no \`murmur hook ${h}\` entry in ${cfg}`);
    if (p.muHooks === false) {
      warnings.push(
        `${h}: no \`mu hook stop ${h}\` entry in ${cfg}: an orchestrator started on this host gets no keep-driving (a remote worker never uses it; run mu init on the host)`,
      );
    }
  }
  const step: HostCheckStep =
    missing.length === 0
      ? {
          step: "hooks",
          ok: true,
          detail: hookHarnesses.map((h) => `${h}: murmur hook ${h}`).join("; "),
        }
      : {
          step: "hooks",
          ok: false,
          detail: `${missing.join("; ")} (its workers would report no state: run murmur init on the host)`,
        };
  return { step, warnings };
}

/**
 * Store a probe on the profile it was taken through: only while the stored
 * templates and transport are still the ones probed (a profile removed and
 * re-added mid-check keeps no stale answer). False when nothing was stored.
 */
export function recordHostCapabilities(
  db: Db,
  profile: Pick<HostProfile, "name" | "shell" | "exec" | "transport">,
  caps: HostCapabilities,
): boolean {
  return (
    db
      .prepare(
        "UPDATE host_profiles SET capabilities = ? WHERE name = ? AND shell = ? AND exec = ? AND transport = ?",
      )
      .run(JSON.stringify(caps), profile.name, profile.shell, profile.exec, profile.transport)
      .changes === 1
  );
}

const isDoc = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The recorded probe of a profile, or undefined: never probed, or a record this build cannot read. */
export function hostCapabilities(
  profile: Pick<HostProfile, "capabilities">,
): HostCapabilities | undefined {
  const raw = profile.capabilities;
  if (raw === null || raw === undefined) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isDoc(doc) || typeof doc.probedAt !== "string" || !isDoc(doc.harnesses)) return undefined;
  if (doc.shell !== "login" && doc.shell !== "sh") return undefined;
  const harnesses = {} as Record<Harness, HarnessProbe>;
  for (const h of HARNESSES) {
    const p = doc.harnesses[h];
    if (!isDoc(p)) return undefined;
    const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    harnesses[h] = {
      command: typeof p.command === "string" ? p.command : null,
      murmurHooks: bool(p.murmurHooks),
      muHooks: bool(p.muHooks),
    };
  }
  return { probedAt: doc.probedAt, shell: doc.shell, harnesses };
}

/**
 * Refuse a spawn of `harness` by its literal `command` on `profile` when the
 * recorded probe resolved that launcher by name and found none. Nothing is
 * touched. A spawn with no harness (a command gate, a CLI outside the five),
 * an unprobed host, or an argv0 other than the launcher's name passes.
 */
export function refuseMissingHarness(
  profile: Pick<HostProfile, "name" | "capabilities">,
  harness: Harness | undefined,
  command: string,
): void {
  if (harness === undefined) return;
  const caps = hostCapabilities(profile);
  if (caps === undefined) return;
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  if (argv0 !== harness) return;
  if (caps.harnesses[harness].command !== null) return;
  throw new HostHarnessMissingError(profile.name, harness, caps.probedAt);
}
