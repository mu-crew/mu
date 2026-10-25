// Sandbox fixtures: git repo + gate, the scripted worker driver, the ssh shim, seeding via mu.
// Scenario files import these; they never edit this file.
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunsLog, type RunRecord } from "./provenance.ts";
import { mu, sh } from "./sandbox.ts";
import type { Family, Sandbox } from "./types.ts";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

/** tools/eval/scenarios: the default scenario root. */
export function scenarioDir(): string {
  return join(EVAL_DIR, "scenarios");
}

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function write(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mode !== undefined) chmodSync(path, mode);
}

/** Commit `files` (path -> content) on main in sb.repoDir. */
export async function makeRepo(sb: Sandbox, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) write(join(sb.repoDir, name), content);
  await sh(sb, "git add -A && git commit -q --allow-empty -m 'fixture files'");
}

/** ./gate.sh: exits 0 iff every *.txt file in the repo ends in a newline. */
export async function gateScript(sb: Sandbox): Promise<void> {
  write(
    join(sb.repoDir, "gate.sh"),
    [
      "#!/bin/sh",
      "bad=0",
      'for f in $(git ls-files "*.txt"); do',
      '  [ -s "$f" ] || continue',
      '  [ -z "$(tail -c1 "$f")" ] || { echo "no trailing newline: $f"; bad=1; }',
      "done",
      '[ "$bad" = 0 ] && echo "gate ok" && exit 0',
      'echo "gate fail"; exit 1',
      "",
    ].join("\n"),
    0o755,
  );
  await sh(sb, "git add gate.sh && git commit -q -m 'add gate'");
}

// A delegate with no keyed answer (answers/N.txt for claim-N, answers/<task>.txt for a task id its prompt
// names) gets a CONFIRMED whose evidence is specific to its prompt and repo, after a short wait: identical
// text in 0 s is what a skeptical AUT rightly rejects. Keep comments out of the script body below: the
// AUT can read it from the sandbox bin.
// Worker driver: what a faux worker's bash call `eval-worker` does. The SQL is verbatim from the
// e_0 design (core columns only, stable across surfaces).
const DRIVER = String.raw`#!/bin/bash
W="$EVAL_WORKER_DIR"
DB="\${MU_DB_PATH:-$EVAL_DB_PATH}"
AGENT="\${MU_AGENT_NAME:-}"
SQLITE() { sqlite3 -readonly -cmd ".timeout 5000" "$DB" "$1"; }
claimed() { SQLITE "SELECT t.local_id FROM tasks t JOIN agents a ON a.id=t.owner_id JOIN workstreams w ON w.id=t.workstream_id WHERE a.name='$MU_AGENT_NAME' AND w.name='$MU_WORKSTREAM' AND t.status='IN_PROGRESS' LIMIT 1"; }
# A delegate (spawned by mu_delegate as delegate-<label>) answers a check and owns no task. Which claim
# it is asked about: the claim-N token in its prompt, else the c<N>/claim-<N> label in its name.
n=$(grep -oE 'claim-[0-9]+' "$W/last-prompt.$AGENT" 2>/dev/null | head -n1 | cut -d- -f2)
[ -n "$n" ] || n=$(echo "$AGENT" | sed -nE 's/^delegate-(claim-|c)([0-9]+)(-[0-9]+)?$/\2/p')
T=$(claimed)
# mu-next spawns a delegate bound to its own delegate task (claimed for it): that task is not work to run.
[ "\${AGENT#delegate-}" = "$AGENT" ] || T=""
# A worker prompted before its task is claimed (3.x cannot claim for an agent not yet spawned, so
# spawn --send always comes first) waits for the claim like a real pi would wait on its queue,
# instead of answering with delegate text.
if [ -z "$T" ] && [ -z "$n" ] && [ "\${AGENT#delegate-}" = "$AGENT" ] && ! grep -q " $AGENT " "$W/runs.log" 2>/dev/null; then
  for _ in $(seq 1 "$(cat "$W/claim-wait" 2>/dev/null || echo 30)"); do
    T=$(claimed); [ -n "$T" ] && break; sleep 1
  done
  [ -n "$T" ] || { echo "No task is claimed for me, so there is nothing to do."; exit 0; }
fi
if [ -z "$T" ]; then
  sleep "$(cat "$W/delegate-delay" 2>/dev/null || echo 0)"
  if [ -n "$n" ] && [ -f "$W/answers/$n.txt" ]; then
    echo "$(date +%s%3N) $AGENT $n" >> "$W/answers.log"; cat "$W/answers/$n.txt"; exit 0
  fi
  for f in "$W"/answers/*.txt; do
    k=$(basename "$f" .txt)
    case "$k" in *[!A-Za-z0-9_]*|[0-9]*) continue ;; esac
    if grep -qw -- "$k" "$W/last-prompt.$AGENT" 2>/dev/null; then echo "$(date +%s%3N) $AGENT $k" >> "$W/answers.log"; cat "$f"; exit 0; fi
  done
  [ -f "$W/delegate-delay" ] || sleep 3
  ask=$(tr '\n' ' ' < "$W/last-prompt.$AGENT" 2>/dev/null | cut -c1-90)
  echo "VERDICT: CONFIRMED"
  echo "EVIDENCE: asked: \"$ask\"; read it against the repo at $(pwd): HEAD $(git log --oneline -1 2>/dev/null), tree $([ -z "$(git status --porcelain 2>/dev/null)" ] && echo clean || echo dirty); no contradiction found"
  exit 0
fi
# runs.log line: <ms> <agent> <task> <action> <sha|-> <patch-id|-> <cwd>. sha and patch-id are the commit
# this worker's task script produced (see tools/eval/provenance.ts); "-" when it made none.
log() { echo "$(date +%s%3N) $AGENT $T $1 $(cat "$W/tasks/$T.commit" 2>/dev/null || echo '- -') $(pwd)" >> "$W/runs.log"; }
if [ -e "$W/tasks/$T.die-once" ]; then
  rm -f "$W/tasks/$T.die-once"; touch "$W/die-next.$AGENT"; log die; echo dying; exit 0
fi
if [ -e "$W/tasks/$T.lose-once" ]; then
  rm -f "$W/tasks/$T.lose-once"; log lost; exit 0
fi
if [ -e "$W/tasks/$T.error-once" ]; then
  rm -f "$W/tasks/$T.error-once"; touch "$W/error-next.$AGENT"; log error; exit 0
fi
mode=$(cat "$W/close-mode" 2>/dev/null || echo verb)
nonce=$(cat "$W/nonce" 2>/dev/null)
evidence="eval: $T.sh exit 0 run=$nonce"
if [ -e "$W/tasks/$T.done" ]; then
  out=$(cat "$W/tasks/$T.done")
else
  out=""
  if [ -f "$W/tasks/$T.sh" ]; then
    before=$(git rev-parse HEAD 2>/dev/null)
    out=$(GIT_AUTHOR_NAME="$AGENT" GIT_AUTHOR_EMAIL="$AGENT@worker.eval.invalid" bash "$W/tasks/$T.sh"); rc=$?
    if [ "$rc" != 0 ]; then log fail; echo "$T.sh exit $rc"; echo "$out"; exit 0; fi
    after=$(git rev-parse HEAD 2>/dev/null)
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      echo "$after $(git show --format= HEAD | git patch-id --stable | cut -d' ' -f1)" > "$W/tasks/$T.commit"
    fi
  fi
  printf '%s' "$out" > "$W/tasks/$T.done"
fi
case "$mode" in
  verb)
    if [ "$(SQLITE "SELECT t.status FROM tasks t JOIN workstreams w ON w.id=t.workstream_id WHERE t.local_id='$T' AND w.name='$MU_WORKSTREAM'")" = CLOSED ]; then
      echo "$T already CLOSED"; log already-closed
    else
      "$W/close.sh" "$T" "$evidence"; log close
    fi ;;
  block)
    echo "CLOSE: task=$T evidence=\"$evidence\""
    echo "REPORT:"
    echo "$out"
    log block ;;
  *)
    echo "DONE: $T"
    echo "$out"
    log done ;;
esac
exit 0
`;

const CLOSE_SCRIPT = '#!/bin/bash\nmu task close "$1" -w "$MU_WORKSTREAM" --evidence "$2"\n';

const DEFAULT_WORKER_SCRIPT = [
  { calls: [{ bash: "eval-worker" }] },
  { textFromLastResult: true },
  { calls: [{ bash: "eval-worker" }] },
  { textFromLastResult: true },
  { calls: [{ bash: "eval-worker" }] },
  { textFromLastResult: true },
];

/** The surface family of this sandbox (EVAL_SURFACE_FAMILY, set from Surface.family; default 3x). */
export function sandboxFamily(sb: Sandbox): Family {
  const f = sb.env.EVAL_SURFACE_FAMILY;
  if (f === undefined || f === "3x") return "3x";
  if (f === "next") return "next";
  throw new Error(`EVAL_SURFACE_FAMILY must be 3x or next, got ${JSON.stringify(f)}`);
}

/**
 * Scripted worker driver. The family comes from the sandbox (never from the scenario): on 3x the
 * worker closes its task with the verb, on next it prints the CLOSE/REPORT block. An explicit
 * closeMode wins.
 */
export async function writeWorkerDriver(
  sb: Sandbox,
  opts: { closeMode?: "verb" | "block" | "none" } = {},
): Promise<void> {
  const w = sb.workerDir;
  const closeMode = opts.closeMode ?? (sandboxFamily(sb) === "next" ? "block" : "verb");
  // The template literal above keeps \${ so String.raw does not expand it; undo that escape.
  write(join(sb.binDir, "eval-worker"), DRIVER.replace(/\\\$\{/g, "${"), 0o755);
  write(join(w, "close.sh"), CLOSE_SCRIPT, 0o755);
  write(join(w, "default.json"), JSON.stringify(DEFAULT_WORKER_SCRIPT));
  write(join(w, "close-mode"), closeMode);
  write(join(w, "nonce"), randomBytes(4).toString("hex"));
  mkdirSync(join(w, "tasks"), { recursive: true });
  mkdirSync(join(w, "answers"), { recursive: true });
}

export async function workerTask(
  sb: Sandbox,
  id: string,
  opts: { sh?: string; dieOnce?: boolean; errorOnce?: boolean; loseOnce?: boolean },
): Promise<void> {
  const dir = join(sb.workerDir, "tasks");
  if (opts.sh !== undefined) write(join(dir, `${id}.sh`), `${opts.sh}\n`);
  if (opts.dieOnce) write(join(dir, `${id}.die-once`), "");
  if (opts.errorOnce) write(join(dir, `${id}.error-once`), "");
  // the prompt is delivered but silently dropped: the worker does nothing, no error (runs.log: lost)
  if (opts.loseOnce) write(join(dir, `${id}.lose-once`), "");
}

/** Seconds every delegate holds its answer, so a delegate cap stays saturated while the AUT issues calls. */
export async function delegateDelay(sb: Sandbox, seconds: number): Promise<void> {
  write(join(sb.workerDir, "delegate-delay"), `${seconds}\n`);
}

export async function delegateAnswer(sb: Sandbox, n: number, text: string): Promise<void> {
  write(join(sb.workerDir, "answers", `${n}.txt`), `${text}\n`);
}

/** Answer for any delegate whose prompt names `task` (a task id such as rt2), for AUTs that word the delegate's prompt freely. */
export async function delegateAnswerFor(sb: Sandbox, task: string, text: string): Promise<void> {
  write(join(sb.workerDir, "answers", `${task}.txt`), `${text}\n`);
}

export async function runsLog(sb: Sandbox): Promise<RunRecord[]> {
  const file = join(sb.workerDir, "runs.log");
  return existsSync(file) ? parseRunsLog(readFileSync(file, "utf8")) : [];
}

export async function nonce(sb: Sandbox): Promise<string> {
  return readFileSync(join(sb.workerDir, "nonce"), "utf8").trim();
}

/** Run mu commands for setup; throws on the first failure. */
export async function seedViaMu(sb: Sandbox, cmds: string[][]): Promise<void> {
  for (const args of cmds) {
    const r = await mu(sb, args);
    if (r.code !== 0) throw new Error(`seed failed (${r.code}): mu ${args.join(" ")}\n${r.stderr}`);
  }
}

/** One `mu task note <id> -w <ws> -` per note, text on stdin; {author} adds --author. */
export async function seedNotes(
  sb: Sandbox,
  ws: string,
  id: string,
  notes: (string | { text: string; author: string })[],
): Promise<void> {
  let i = 0;
  for (const n of notes) {
    const o = typeof n === "string" ? { text: n, author: undefined } : n;
    const file = join(sb.dir, `note-${id}-${i++}.txt`);
    write(file, o.text);
    const author = o.author === undefined ? "" : ` --author ${shq(o.author)}`;
    await sh(sb, `mu task note ${shq(id)} -w ${shq(ws)}${author} - < ${shq(file)}`);
  }
}

/**
 * A fake ssh host on this machine: <dir>/bin/ssh (node, tools/eval/ssh-shim.ts) and
 * <dir>/hosts/<host>/{home/repo,bin,shim.json}. See ssh-args.ts for the rules.
 */
export async function sshShim(
  sb: Sandbox,
  opts: { host: string; maxSessions?: number },
): Promise<{ hostRoot: string; sessionsLog: string }> {
  const hostRoot = join(sb.dir, "hosts", opts.host);
  const sessionsLog = join(hostRoot, "sessions.log");
  const hostSock = `${sb.tmuxSocket}-h-${opts.host}`;
  mkdirSync(join(hostRoot, "home"), { recursive: true });
  mkdirSync(join(hostRoot, "bin"), { recursive: true });
  mkdirSync(join(hostRoot, "tmp"), { recursive: true });
  writeFileSync(sessionsLog, "");
  if (!existsSync(join(hostRoot, "home", "repo"))) {
    await sh(sb, `git clone -q ${shq(sb.repoDir)} ${shq(join(hostRoot, "home", "repo"))}`);
  }
  const realTmux = (await sh(sb, "command -v tmux")).stdout.trim();
  write(
    join(hostRoot, "bin", "tmux"),
    `#!/bin/sh\nexec ${shq(realTmux)} -L ${shq(hostSock)} -f /dev/null "$@"\n`,
    0o755,
  );
  // $SHELL on the host: `$SHELL -ilc "pi"` must not reread /etc/profile and reorder PATH.
  write(
    join(hostRoot, "bin", "eval-shell"),
    '#!/bin/bash\n[ $# -eq 0 ] && exec bash\nfor last; do :; done\nexec bash -c "$last"\n',
    0o755,
  );
  write(
    join(hostRoot, "shim.json"),
    JSON.stringify({
      host: opts.host,
      hostRoot,
      maxSessions: opts.maxSessions,
      sessionsLog,
      tmuxSocket: hostSock,
    }),
  );
  appendFileSync(join(sb.dir, "tmux-sockets"), `${hostSock}\n`);
  // EVAL_DB_PATH: mu-next strips MU_DB_PATH from the pane's env (the remote pi never gets the DB), but
  // eval-worker still reads the task table (read-only) to know which task is claimed for it.
  write(
    join(sb.binDir, "ssh"),
    `#!/bin/sh\nEVAL_DB_PATH=${shq(sb.dbPath)} EVAL_SANDBOX_DIR=${shq(sb.dir)} exec node ${shq(join(EVAL_DIR, "ssh-shim.ts"))} "$@"\n`,
    0o755,
  );
  return { hostRoot, sessionsLog };
}

/**
 * mu-next family: the host profile a user would have stored for an ssh host (`mu host add`), with
 * the starter templates of `mu host init <host> --ssh`. The shim is the `ssh` on PATH. 3.x has no
 * host profiles (its goldens spell the ssh command out), so a scenario calls this only on `next`.
 */
export async function hostProfile(
  sb: Sandbox,
  host: string,
  opts: { maxSessions?: number } = {},
): Promise<void> {
  const o = "-o ControlMaster=no -o ControlPath=none";
  await seedViaMu(sb, [
    [
      "host",
      "add",
      host,
      "--shell",
      `ssh ${o} -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L {local_sock}:{remote_sock} ${host} -t 'cd {cwd:sh} && {env} "$SHELL" -ilc {cmd:sh}'`,
      "--exec",
      `ssh ${o} -o BatchMode=yes ${host} {cmd}`,
      "--fetch",
      `git fetch ssh://${host}{cwd} HEAD`,
      "--repo",
      "~/repo",
      ...(opts.maxSessions === undefined ? [] : ["--max-sessions", String(opts.maxSessions)]),
    ],
  ]);
}
