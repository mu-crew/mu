// Designer isolation (spec docs/specs/2026-11-07-hill-r2-tournament.md §3.2, unit B3b): the pack a
// designer works in, its BRIEF.md and the refusal rules, the designer launch (empty HOME, provider
// extension only, own session dir, a PATH without mu or museum), and the isolation audit of its
// session files. The designer never sees a case, a judge or a lead-in.
import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Group, NextCase, St } from "./nextstep.ts";
import { variantsOf } from "./nextstep.ts";
import { launcherEnv, REAL_PI, systemPathDirs } from "./sandbox.ts";
import { cloneDir } from "./tournament-build.ts";
import { parseManifest } from "./tournament-patch.ts";
import type { Sandbox } from "./types.ts";

const EVAL_CACHE = join(homedir(), ".cache", "mu", "eval");
export const PACKS_DIR = join(EVAL_CACHE, "packs");
export const DESIGNERS_DIR = join(EVAL_CACHE, "designers");

/** What `pack` deletes from the base tree (§3.2). */
export const PACK_DELETE = [
  "tools/eval",
  "test/eval",
  "docs/eval",
  "docs/specs/2026-11-07-hill-r2-tournament.md",
  "docs/history",
  "CHANGELOG.md",
];

// ---- deny list ----------------------------------------------------------------------------------

/** Where the audit looks, and what it lets through. All paths absolute. */
export interface DenyContext {
  /** The real HOME (the catch-all's root). */
  home: string;
  /** The main checkout. */
  repo: string;
  /** Crew worktrees: `~/.local/state/mu-next/worktrees/`. */
  worktrees: string;
  surfaces: string;
  packs: string;
  transcripts: string;
  /** The museum store and the museum skill checkout. */
  museum: string[];
  /** The session's own pack and its own `<ddir>`: the catch-all lets them through. */
  ownPack: string;
  ownDdir: string;
  /**
   * Further dirs the catch-all lets through: node's install dir (an `~/.nvm` or mise node prints
   * its own paths in an ordinary stack trace), the provider extension, pi's install dir.
   */
  allow: string[];
  caseIds: string[];
}

export function defaultDenyContext(o: {
  repo: string;
  ownPack: string;
  ownDdir: string;
  caseIds: string[];
  providerExt?: string;
  home?: string;
}): DenyContext {
  const home = o.home ?? homedir();
  const state = join(home, ".local", "state", "mu-next");
  return {
    home,
    repo: resolve(o.repo),
    worktrees: join(state, "worktrees"),
    surfaces: join(home, ".cache", "mu", "eval", "surfaces"),
    packs: join(home, ".cache", "mu", "eval", "packs"),
    transcripts: join(state, "eval-transcripts"),
    museum: [join(home, "museum"), join(home, "hacking", "crew", "museum")],
    ownPack: resolve(o.ownPack),
    ownDdir: resolve(o.ownDdir),
    allow: [
      nodeInstallDir(),
      ...(o.providerExt ? [resolve(o.providerExt)] : []),
      dirname(realpathOr(REAL_PI)),
    ],
    caseIds: o.caseIds,
  };
}

const realpathOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** node's install dir: the prefix above `bin/node` (`~/.nvm/versions/node/v22`, a mise install), else its dir. */
export function nodeInstallDir(execPath: string = process.execPath): string {
  const real = realpathOr(execPath);
  const dir = dirname(real);
  return basename(dir) === "bin" ? dirname(dir) : dir;
}

export interface DenyHit {
  rule: string;
  /** The path resolved to its literal form, or the matched text. */
  match: string;
  /** The text as it stood (`~/.pi/x`, `$HOME/y`): what `auditSession` looks up in the pack. */
  raw: string;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + sep);

/** Terms the pack and every session must never carry (paths aside). */
function termRules(ctx: Pick<DenyContext, "caseIds">): { rule: string; re: RegExp }[] {
  return [
    ...ctx.caseIds.map((id) => ({ rule: "case id", re: new RegExp(`\\b${esc(id)}\\b`) })),
    // `nextsteps` (test/error-nextsteps.test.ts, a real file of the pack) is not the probe
    { rule: "nextstep", re: /nextstep(?!s)/i },
    { rule: "cold-intents", re: /cold-intents/ },
    { rule: "hill-r2-tournament", re: /hill-r2-tournament/ },
    { rule: "docs/eval", re: /docs\/eval/ },
    { rule: "tools/eval", re: /tools\/eval/ },
    { rule: "test/eval", re: /test\/eval/ },
    { rule: "museum skill", re: /skills\/museum/ },
    {
      rule: "task notes",
      re: /task\s+notes\s+(?:hill2|b[\w-]*|delegate_friction-[\w-]*)(?![\w-])/,
    },
  ];
}

/**
 * A bash call that runs `museum` (at a command position of the call's `command` argument, as pi's
 * session file records it). A file that merely names the museum hook (mu's own init tests do) is
 * not a call.
 */
export function runsMuseum(text: string): string | null {
  for (const m of text.matchAll(/"command"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    let cmd = "";
    try {
      cmd = JSON.parse(m[1] ?? '""') as string;
    } catch {
      continue;
    }
    if (/(?:^|[;&|(`\n]|\$\()\s*(?:\S*\/)?museum(?=\s|$)/.test(cmd)) return cmd;
  }
  return null;
}

/**
 * Every absolute path under the real HOME in `text`, in its literal, `~/` and `$HOME` forms:
 * `raw` as written, `path` resolved to the literal form.
 */
export function homePaths(text: string, home: string): { raw: string; path: string }[] {
  const re = new RegExp(
    `(?:${esc(home)}|~(?=/)|\\$\\{HOME\\}|\\$HOME(?![A-Za-z0-9_]))(/[^\\s"'\`\\\\)(;|&<>,]*)?`,
    "g",
  );
  return [...text.matchAll(re)].map((m) => {
    const rest = (m[1] ?? "").replace(/[.:]+$/, "");
    return { raw: m[0].replace(/[.:]+$/, ""), path: rest === "" ? home : resolve(home + rest) };
  });
}

/**
 * Every relative path in `text` that climbs (`..` segments), resolved against `cwd`: from the pack,
 * `cat ../../../../../../../.pi/agent/sessions/x` names no absolute path but reads one.
 */
export function climbingPaths(text: string, cwd: string): { raw: string; path: string }[] {
  return text
    .split(/[\s"'`\\)(;|&<>,=]+/)
    .filter((t) => !/^[/~$]/.test(t) && /(?:^|\/)\.\.(?:\/|$)/.test(t))
    .map((t) => ({ raw: t, path: resolve(cwd, t) }));
}

/**
 * Every deny-list hit in one text (§3.2 isolation audit). With `cwd` (a strict part: what the
 * designer did), relative paths that climb are resolved against it and checked like absolute ones.
 */
export function denyHits(text: string, ctx: DenyContext, cwd?: string): DenyHit[] {
  const hits: DenyHit[] = [];
  for (const t of termRules(ctx)) {
    const m = t.re.exec(text);
    if (m) hits.push({ rule: t.rule, match: m[0].trim(), raw: m[0].trim() });
  }
  const museum = runsMuseum(text);
  if (museum !== null) hits.push({ rule: "museum command", match: museum, raw: museum });
  const named: { rule: string; dir: string }[] = [
    { rule: "main checkout", dir: ctx.repo },
    { rule: "crew worktrees", dir: ctx.worktrees },
    { rule: "built surfaces", dir: ctx.surfaces },
    { rule: "eval transcripts", dir: ctx.transcripts },
    { rule: "pi sessions", dir: join(ctx.home, ".pi", "agent", "sessions") },
    { rule: "claude projects", dir: join(ctx.home, ".claude", "projects") },
    { rule: "codex sessions", dir: join(ctx.home, ".codex", "sessions") },
    ...ctx.museum.map((dir) => ({ rule: "museum", dir })),
  ];
  // the main checkout and the museum may live outside HOME: their literal form is a path of its own
  for (const n of named)
    if (!under(n.dir, ctx.home) && text.includes(n.dir))
      hits.push({ rule: n.rule, match: n.dir, raw: n.dir });
  const allowed = [ctx.ownPack, ctx.ownDdir, ...ctx.allow];
  const seen = new Set<string>();
  const paths = [
    ...homePaths(text, ctx.home),
    ...(cwd === undefined ? [] : climbingPaths(text, cwd)),
  ];
  for (const { raw, path: p } of paths) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const n = named.find((x) => under(p, x.dir));
    if (n) hits.push({ rule: n.rule, match: p, raw });
    else if (under(p, ctx.packs) && !under(p, ctx.ownPack) && !under(p, ctx.ownDdir))
      hits.push({ rule: "another pack", match: p, raw });
    else if (!allowed.some((a) => under(p, a)))
      hits.push({ rule: "under the real HOME", match: p, raw });
  }
  return hits;
}

function textFile(p: string): boolean {
  return !readFileSync(p).subarray(0, 8000).includes(0);
}

function filesUnder(dir: string, skip: (p: string) => boolean = () => false): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (skip(p)) return [];
    return e.isDirectory() ? filesUnder(p, skip) : e.isFile() ? [p] : [];
  });
}

const notDeps = (p: string): boolean => /[\\/](node_modules|\.git|dist)$/.test(p);

/**
 * The deny-list text the pristine pack itself carries (mu's own docs and help strings name
 * `~/.local/state/mu-next`, `~/.claude/projects`, …): a tool result or the model's own words that
 * repeat it reveal nothing from outside the pack.
 */
export function packTokens(pack: string, ctx: DenyContext): Set<string> {
  const out = new Set<string>();
  for (const f of filesUnder(pack, notDeps)) {
    if (!textFile(f)) continue;
    for (const h of denyHits(readFileSync(f, "utf8"), ctx)) out.add(h.raw);
  }
  return out;
}

/**
 * The parts of one session-file line, each strict (every hit counts: what the designer DID, its
 * bash commands and the paths it read or wrote) or lenient (what it was shown or said: tool
 * results, its text and thinking, the content it wrote; a hit that the pristine pack carries
 * too is excused). A line that is not pi's JSON is strict.
 */
export function sessionParts(line: string): { text: string; strict: boolean }[] {
  let ev: { type?: string; message?: { role?: string; content?: unknown } };
  try {
    ev = JSON.parse(line);
  } catch {
    return [{ text: line, strict: true }];
  }
  const m = ev.message;
  if (ev.type !== "message" || !m) return [{ text: line, strict: true }];
  if (m.role === "toolResult") return [{ text: JSON.stringify(m.content ?? ""), strict: false }];
  if (m.role !== "assistant" || !Array.isArray(m.content)) return [{ text: line, strict: true }];
  return (
    m.content as { type?: string; name?: string; arguments?: Record<string, unknown> }[]
  ).flatMap((c) => {
    if (c.type !== "toolCall") return [{ text: JSON.stringify(c), strict: false }];
    const args = c.arguments ?? {};
    if (c.name === "edit" || c.name === "write") {
      const { path, ...rest } = args;
      return [
        { text: JSON.stringify({ path }), strict: true },
        { text: JSON.stringify(rest), strict: false },
      ];
    }
    return [{ text: JSON.stringify(c), strict: true }];
  });
}

/** The cwd pi's session header records (`{"type":"session",…,"cwd":…}`); null without one. */
function sessionCwd(lines: readonly string[]): string | null {
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as { type?: string; cwd?: unknown };
      if (ev.type === "session" && typeof ev.cwd === "string") return ev.cwd;
    } catch {}
  }
  return null;
}

/**
 * §3.2 audit: every deny hit in a designer's session files. `excused` (packTokens of the pristine
 * pack) lets a lenient part repeat what the pack itself says; an edit or write's content is
 * lenient too (a variant may reword a help string that names a state dir), its path is not.
 * Strict parts resolve climbing relative paths against the session's cwd (its header; else the
 * pack, where runDesigner starts pi).
 */
export function auditSession(
  sessionDir: string,
  ctx: DenyContext,
  excused: ReadonlySet<string> = new Set(),
): (DenyHit & { file: string })[] {
  const out: (DenyHit & { file: string })[] = [];
  for (const f of filesUnder(sessionDir)) {
    const lines = readFileSync(f, "utf8").split("\n");
    const cwd = sessionCwd(lines) ?? ctx.ownPack;
    for (const line of lines) {
      if (line.trim() === "") continue;
      for (const part of sessionParts(line))
        for (const h of denyHits(part.text, ctx, part.strict ? cwd : undefined))
          if (part.strict || !excused.has(h.raw)) out.push({ ...h, file: relative(sessionDir, f) });
    }
  }
  return out;
}

// ---- BRIEF.md -----------------------------------------------------------------------------------

/** A stand-in sandbox and state for listing a lead-in without running it (placeholders `<k>`). */
const STUB_SB: Sandbox = {
  dir: "<sb>",
  env: {},
  binDir: "<sb>/bin",
  repoDir: "<sb>/repo",
  workerDir: "<sb>/workers",
  tmuxSocket: "<sb>",
  dbPath: "<sb>/mu.db",
  surface: { name: "stub", root: "<sb>", cli: "", extension: "", skillDir: "" },
  close: async () => {},
};
const STUB_ST: St = new Proxy({}, { get: (_t, k) => `<${String(k)}>` });

/** Every lead-in step command of the cases, every variant, with `<placeholder>`s. */
export function leadInCommands(cases: readonly NextCase[]): string[] {
  return [
    ...new Set(
      cases.flatMap((c) =>
        variantsOf(c).flatMap(({ v }) => c.leadIn(STUB_SB, STUB_ST, v).map((s) => s.cmd)),
      ),
    ),
  ];
}

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const goalWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Why a BRIEF.md text is refused (§3.2); empty when it may go into the pack. */
export function briefRefusals(
  text: string,
  o: { cases: readonly NextCase[]; judgeFiles: readonly string[]; deleted?: readonly string[] },
): string[] {
  const out: string[] = [];
  if (/^\s*(```|~~~)/m.test(text)) out.push("a fenced code block");
  if (/^\$ /m.test(text)) out.push("a line starting with `$ `");
  const body = flat(text);
  for (const cmd of leadInCommands(o.cases)) {
    const pieces = flat(cmd).split(/<[^>]*>/);
    const re = new RegExp(pieces.map(esc).join(".*?"));
    if (pieces.join("").trim() !== "" && re.test(body)) out.push(`lead-in command: ${cmd}`);
    for (const p of pieces)
      for (let i = 0; i + 16 <= p.length; i++) {
        const sub = p.slice(i, i + 16);
        if (sub.trim().length === 16 && body.includes(sub)) {
          out.push(`16 characters of a lead-in command: "${sub}"`);
          i = p.length;
        }
      }
  }
  const bw = ` ${goalWords(text).join(" ")} `;
  for (const c of o.cases) {
    if (new RegExp(`\\b${esc(c.id)}\\b`).test(text)) out.push(`case id ${c.id}`);
    for (const p of c.paraphrases) {
      if (body.toLowerCase().includes(flat(p.goal).toLowerCase())) out.push(`goal ${c.id}/${p.id}`);
      const w = goalWords(p.goal);
      for (let i = 0; i + 5 <= w.length; i++) {
        const run = w.slice(i, i + 5).join(" ");
        if (bw.includes(` ${run} `)) {
          out.push(`5 words of goal ${c.id}/${p.id}: "${run}"`);
          break;
        }
      }
    }
  }
  for (const f of o.judgeFiles) if (text.includes(f)) out.push(`judge file ${f}`);
  for (const d of o.deleted ?? PACK_DELETE) if (text.includes(d)) out.push(`deleted path ${d}`);
  return [...new Set(out)];
}

/** The judge files a BRIEF.md may not name: every file of the eval rig and its tests. */
export function judgeFileNames(repo: string): string[] {
  const names = ["tools/eval", "test/eval"].flatMap((d) =>
    filesUnder(join(repo, d), (p) => p.includes(`${sep}candidates`)).map((p) => basename(p)),
  );
  return [...new Set(names.filter((n) => /\.(ts|json)$/.test(n)))].sort();
}

/** BRIEF.md: the human-written source, then the caps and VISION (§3.2). */
export function renderBrief(src: string, group: Group): string {
  return [
    `# Brief: ${group}`,
    "",
    src.trim(),
    "",
    "## Caps",
    "",
    "- skills/mu/SKILL.md at most 600 words; every recipe under skills/mu/recipes together at most 4000 words (wc -w).",
    "- Each changed string (a string literal, a skill paragraph or list item) at most max(1.25 x its old length, old + 40) characters and never more than old + 120; a new string with no old counterpart at most 120.",
    "- A variant touches only src/, extension/ and skills/.",
    "- docs/VISION.md holds the design pillars a variant must not violate.",
    "",
  ].join("\n");
}

// ---- pack ---------------------------------------------------------------------------------------

/**
 * Remove what the deny list would catch from the remaining tree, so that reading an ordinary file
 * never discards a designer session: package.json scripts (or `&&` steps) that name a denied path
 * go, markdown, ignore-file and comment lines that do go. Returns what is left, as `path: hit`.
 */
export function scrubPack(dir: string, ctx: Pick<DenyContext, "caseIds">): string[] {
  const rules = termRules(ctx);
  const hit = (s: string): boolean => rules.some((r) => r.re.test(s));
  const left: string[] = [];
  for (const f of filesUnder(dir, (p) => /[\\/](node_modules|\.git)$/.test(p))) {
    if (!textFile(f)) continue;
    const rel = relative(dir, f);
    const text = readFileSync(f, "utf8");
    if (!hit(text) && !hit(rel)) continue;
    if (hit(rel)) {
      left.push(`${rel}: its path`);
      continue;
    }
    if (rel === "package.json") {
      const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
      for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
        const steps = v.split(" && ").filter((s) => !hit(s));
        if (steps.length === 0 || hit(k)) delete pkg.scripts?.[k];
        else if (pkg.scripts) pkg.scripts[k] = steps.join(" && ");
      }
      writeFileSync(f, `${JSON.stringify(pkg, null, 2)}\n`);
      continue;
    }
    const prose = /\.(md|txt)$|(^|\/)\.gitignore$/.test(rel);
    const lines = text.split("\n");
    const kept = lines.filter((l) => {
      if (!hit(l)) return true;
      return !(prose || /^\s*(\/\/|\*|\/\*|#)/.test(l));
    });
    writeFileSync(f, kept.join("\n"));
    for (const l of kept) if (hit(l)) left.push(`${rel}: ${l.trim().slice(0, 100)}`);
  }
  return left;
}

/**
 * §3.2 pack: base's tree as a fresh git repo (no history) under `packs/<group>/`, the deleted
 * paths gone, the rest scrubbed of deny terms, `node_modules` cloned from the base surface, and
 * BRIEF.md. Refuses a BRIEF.md that breaks a rule, and a pack in which a denied path or term is
 * left.
 */
export function packGroup(o: {
  repo: string;
  baseSha: string;
  group: Group;
  briefSrc: string;
  cases: readonly NextCase[];
  nodeModulesFrom: string;
  packsDir?: string;
}): { dir: string } {
  const brief = renderBrief(o.briefSrc, o.group);
  const why = briefRefusals(brief, { cases: o.cases, judgeFiles: judgeFileNames(o.repo) });
  if (why.length > 0) throw new Error(`BRIEF.md refused:\n  ${why.join("\n  ")}`);
  const dir = join(o.packsDir ?? PACKS_DIR, o.group);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = execFileSync("git", ["-C", o.repo, "archive", o.baseSha], {
    maxBuffer: 1 << 30,
  });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  for (const d of PACK_DELETE) rmSync(join(dir, d), { recursive: true, force: true });
  const left = scrubPack(dir, { caseIds: o.cases.map((c) => c.id) });
  if (left.length > 0) throw new Error(`pack still carries denied text:\n  ${left.join("\n  ")}`);
  for (const d of PACK_DELETE) if (existsSync(join(dir, d))) throw new Error(`pack still has ${d}`);
  writeFileSync(join(dir, "BRIEF.md"), brief);
  const git = (args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["-c", "user.name=pack", "-c", "user.email=pack@localhost", "commit", "-q", "-m", "base"]);
  writeFileSync(join(dir, ".git", "info", "exclude"), "node_modules/\ndist/\nvariants/\n");
  const nm = join(o.nodeModulesFrom, "node_modules");
  if (existsSync(nm)) cloneDir(nm, join(dir, "node_modules"));
  return { dir };
}

// ---- the designer -------------------------------------------------------------------------------

/** First executable `name` on `pathEnv`. */
function which(name: string, pathEnv: string | undefined): string | null {
  for (const d of (pathEnv ?? "").split(":")) {
    if (!isAbsolute(d)) continue;
    try {
      accessSync(join(d, name), constants.X_OK);
      return join(d, name);
    } catch {}
  }
  return null;
}

/**
 * The designer's PATH (§3.2): its own bin (node, npm, npx linked from the caller's PATH), the
 * system dirs that hold neither `mu` nor `museum`, and the pack's `node_modules/.bin`.
 */
export function designerPath(
  binDir: string,
  pack: string,
  pathEnv: string | undefined,
  systemDirs: readonly string[] = systemPathDirs(pathEnv),
): string {
  mkdirSync(binDir, { recursive: true });
  for (const tool of ["node", "npm", "npx"]) {
    const p = tool === "node" ? process.execPath : which(tool, pathEnv);
    const link = join(binDir, tool);
    if (p !== null && !existsSync(link)) symlinkSync(p, link);
  }
  const system = systemDirs.filter(
    (d) => !existsSync(join(d, "mu")) && !existsSync(join(d, "museum")),
  );
  return [binDir, ...system, join(pack, "node_modules", ".bin")].join(":");
}

/** The designer's whole env: nothing of the caller's but what the pi launcher needs to start. */
export function designerEnv(o: {
  ddir: string;
  pack: string;
  pathEnv: string | undefined;
  base?: NodeJS.ProcessEnv;
  systemDirs?: readonly string[];
}): Record<string, string> {
  const home = join(o.ddir, "home");
  mkdirSync(home, { recursive: true });
  const settings = join(home, "settings.json");
  if (!existsSync(settings))
    writeFileSync(settings, `${JSON.stringify({ retry: { enabled: false } })}\n`);
  mkdirSync(join(o.ddir, "state"), { recursive: true });
  return {
    PATH: designerPath(join(o.ddir, "bin"), o.pack, o.pathEnv, o.systemDirs),
    HOME: home,
    PI_CODING_AGENT_DIR: home,
    MU_DB_PATH: join(o.ddir, "state", "mu.db"),
    MU_SYNC_DIR: "",
    MU_STATE_DIR: join(o.ddir, "state"),
    TERM: "dumb",
    ...launcherEnv(o.base ?? process.env),
  };
}

export function designerPrompt(group: Group): string {
  return [
    "Read BRIEF.md in the current directory: this git repo is mu, the tool to improve.",
    "Propose 3 to 6 variants on your own. Each variant is one independent change against HEAD.",
    `For each variant <id> (lowercase letters, digits and -): make the change; check that \`npm run build\` and \`node dist/cli.js --help\` work; run \`mkdir -p variants && git diff -- src extension skills > variants/<id>.patch\`; write variants/<id>.json as {"id": "<id>", "group": "${group}", "kind": [one or more of "output", "verb", "error", "skill", "recipe"], "summary": "<one line>"}; then \`git checkout -- src extension skills\` before the next one.`,
    "Touch only src/, extension/ and skills/, within the caps in BRIEF.md.",
    "Read nothing outside this directory: no other path on this machine, no network.",
  ].join("\n");
}

export function designerArgs(o: {
  ddir: string;
  model: string;
  providerExt?: string;
  prompt: string;
}): string[] {
  return [
    "-p",
    "--mode",
    "json",
    "--no-extensions",
    ...(o.providerExt ? ["-e", o.providerExt] : []),
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--session-dir",
    join(o.ddir, "sessions"),
    "--model",
    o.model,
    o.prompt,
  ];
}

/**
 * `tournament design <group> --model <m>`: one designer session in `designers/<group>/<session>/`,
 * on its own copy of the group's pack. Resolves with pi's exit code.
 */
export async function runDesigner(o: {
  group: Group;
  model: string;
  session: string;
  pack: string;
  providerExt?: string;
  designersDir?: string;
}): Promise<{ ddir: string; pack: string; code: number }> {
  const ddir = join(o.designersDir ?? DESIGNERS_DIR, o.group, o.session);
  if (existsSync(join(ddir, "sessions")))
    throw new Error(`designer session ${ddir} already ran; remove it to run it again`);
  mkdirSync(ddir, { recursive: true });
  const pack = join(ddir, "pack");
  cloneDir(o.pack, pack);
  const env = designerEnv({ ddir, pack, pathEnv: process.env.PATH });
  const args = designerArgs({
    ddir,
    model: o.model,
    providerExt: o.providerExt,
    prompt: designerPrompt(o.group),
  });
  const code = await new Promise<number>((res) => {
    const child = spawn(REAL_PI, args, {
      cwd: pack,
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", () => res(127));
    child.on("close", (c) => res(c ?? 1));
  });
  return { ddir, pack, code };
}

/**
 * The designer's variants (`<pack>/variants/<id>.{json,patch}`) copied to
 * `candidates/<group>/<session>/`, each id prefixed with the session so two designers never
 * collide. Returns the new ids; a refused manifest is reported and skipped.
 */
export function collectVariants(
  pack: string,
  group: Group,
  session: string,
  candDir: string,
): { ids: string[]; refused: string[] } {
  const src = join(pack, "variants");
  const out = join(candDir, session);
  mkdirSync(out, { recursive: true });
  const ids: string[] = [];
  const refused: string[] = [];
  if (!existsSync(src)) return { ids, refused };
  for (const f of readdirSync(src)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const patch = join(src, f.replace(/\.json$/, ".patch"));
    try {
      const m = parseManifest(readFileSync(join(src, f), "utf8"), group);
      if (!existsSync(patch) || statSync(patch).size === 0) throw new Error("no patch");
      const id = `${session}-${m.id}`;
      writeFileSync(join(out, `${id}.json`), `${JSON.stringify({ ...m, id }, null, 2)}\n`);
      writeFileSync(join(out, `${id}.patch`), readFileSync(patch));
      ids.push(id);
    } catch (e) {
      refused.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ids, refused };
}
