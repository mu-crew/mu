#!/usr/bin/env bash
# Operator smoke for a mixed crew (docs/specs/2026-11-20-ladder-placement.md,
# the D15 rungs only): ONE orchestrator, ONE loopback `sshd MaxSessions 1`, and
# at once a rung-0 worker (local tmux pane), rung-1 calls (`mu host exec`
# through the mule link) and a rung-4 worker (`--plugin mule` lease job).
# Explicitly invoked, never picked up by vitest; Linux only (it runs sshd):
#
#   MU=/path/to/mu MULE=/path/to/mule bash scripts/smoke-hybrid.sh
#
# Cases:
#   H1. both rungs at once: a rung-4 worker (job on the "remote") and a rung-0
#       worker (local pane) run side by side in one workstream, one DB
#   H2. remote -> local: the rung-4 worker commits in its remote tree (its own
#       shell, through a send), `mu agent collect` pins it, the orchestrator
#       merges refs/mu/collect/<ws>/<agent>, and a rung-0 reviewer spawned
#       from the merged HEAD finds the commit and its file in its worktree
#   H3. rung 1 alongside: concurrent `mu host exec` calls plus a collect while
#       both workers run: every call exits 0, sshd refuses no session (the cap
#       is shown real first), no `exec:*` holder ever appears in host_channels
#       (the slots:"self" mule link owns its slots), the collect's template fetch
#       holds at most its one row, every sample read succeeds, 0 rows afterwards
#   H4. local -> remote (spec §3.3): a rung-0 worker commits; merged locally,
#       its commit is local-only, so a rung-4 spawn from it is refused (exit 5,
#       RemoteBaseMissingError naming host, repo, sha and both fixes) before any
#       effect; the caller does the named remedy (push to a remote the host can
#       fetch, then `mu host exec <h> -- git -C <repo> fetch <remote> <sha>`),
#       the spawn then works, the rung-4 worker sees that base, commits on top,
#       and the collect merges fast-forward into the orchestrator's checkout
#   H5. orchestrator mu verbs never run remotely: the remote PATH's `mu` is a
#       tripwire that records any call, and no mu.db appears on the remote side
#   H6. after EVERY close: no forward, remote job or tree, local tree, socket,
#       job file, or row of that agent in carrier_jobs, agents, remote_recovery;
#       no effects or host_channels row; and at the end nothing at all
#
# The private world and its rules are scripts/smoke-lease.sh's: own dir under
# /tmp, TMPDIR, HOME, XDG_*, MU_DB_PATH, MU_SYNC_DIR= blank, a private tmux
# server for mu and one for mule, mule --config, no host but 127.0.0.1. The
# pi on both sides is scripts/smoke-ext-pi.mjs (the REAL built ctl extension,
# no model); a "smoke-sh: <cmd>" send runs <cmd> in the worker's own cwd.
#
# Missing prerequisites FAIL (exit 2); they never count as a pass. Every
# process it starts, the timeout watchdog and its sleep included, is stopped by
# the EXIT trap, also on failure; a process still naming the private dir in its
# argv or environ after that sweep fails the run (Linux /proc scan). The whole
# run is bounded by SMOKE_TIMEOUT seconds (default 900). SMOKE_KEEP=1 keeps the dir.

set -euo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
MU=${MU:-$(dirname "$SCRIPTS")}
MULE=${MULE:-}
SSHD=${SSHD:-/usr/sbin/sshd}
LIMIT=${SMOKE_TIMEOUT:-900}
[ $# = 0 ] || {
  echo "usage: smoke-hybrid.sh (no arguments; MU, MULE, SSHD, SMOKE_TIMEOUT, SMOKE_KEEP from the env)" >&2
  exit 2
}

T0=$(date +%s)
say() { printf '[%3ss] %s\n' "$(($(date +%s) - T0))" "$*"; }
pass() { say "PASS $*"; }
fail() {
  say "FAIL $*"
  exit 1
}

# ── prerequisites: every one is a failure, never a skip ─────────────────────
missing=()
need_cmd() { command -v "$1" >/dev/null 2>&1 || missing+=("$1 (not on PATH)"); }
for c in ssh ssh-keygen tmux node npm cargo git git-upload-pack lsof timeout; do need_cmd "$c"; done
[ -x "$SSHD" ] || missing+=("sshd at $SSHD")
[ -n "$MULE" ] || missing+=("MULE (path to the mule checkout) is not set")
[ -z "$MULE" ] || [ -f "$MULE/Cargo.toml" ] || missing+=("mule checkout at $MULE (no Cargo.toml)")
[ -f "$MU/package.json" ] || missing+=("mu checkout at $MU (no package.json)")
[ -d "$MU/node_modules" ] || missing+=("$MU/node_modules (run npm install there)")
[ -f "$SCRIPTS/smoke-ext-pi.mjs" ] || missing+=("$SCRIPTS/smoke-ext-pi.mjs")
if [ ${#missing[@]} -gt 0 ]; then
  for m in "${missing[@]}"; do echo "smoke-hybrid: PREREQUISITE MISSING: $m" >&2; done
  echo "smoke-hybrid: FAIL (prerequisites missing; this is not a pass)" >&2
  exit 2
fi
MU=$(cd "$MU" && pwd -P)
MULE=$(cd "$MULE" && pwd -P)
TO=$(command -v timeout)

# ── build ────────────────────────────────────────────────────────────────────
say "build mule: cargo build --release in $MULE"
(cd "$MULE" && "$TO" 1200 cargo build --release --quiet) || fail "cargo build --release"
say "build mu: npm run build in $MU"
(cd "$MU" && "$TO" 600 npm run build --silent >/dev/null) || fail "npm run build"
for f in "$MULE/target/release/mule" "$MULE/target/release/mu-plugin-mule"; do
  [ -x "$f" ] || fail "no $f after the build"
done
[ -f "$MU/dist/cli.js" ] || fail "no mu dist/cli.js after the build"
[ -f "$MU/dist/extension/mu-pi.js" ] || fail "no mu dist/extension/mu-pi.js (the ctl extension) after the build"
say "mule $(git -C "$MULE" rev-parse --short HEAD 2>/dev/null || echo '?'), mu $(git -C "$MU" rev-parse --short HEAD 2>/dev/null || echo '?')"

# ── private world ────────────────────────────────────────────────────────────
R=$(cd "$(mktemp -d /tmp/mu-hyb.XXXXXX)" && pwd -P)
UID_=$(id -u)
WS="hyb-$$"
RSOCK_DIR="/tmp/mu-$UID_/$WS"
MU_TMUX="mu-hyb-$$"
MULE_TMUX="mule-hyb-$$"
SSHD_PID=""
WATCHDOG=""
LEFTOVERS="$R/leftovers"
# Every process of this run carries "$R/" in its environ (this tag, or the
# private HOME/TMPDIR exported below; sshd's children get it through SetEnv).
export SMOKE_RUN="$R/"

# reap_watchdog: freeze the watchdog so it can neither fire nor fork, kill its
# sleep (a direct child), kill it, and reap it. A plain kill of the subshell
# orphans the sleep, which outlives the run and holds the caller's pipe.
reap_watchdog() {
  [ -n "$WATCHDOG" ] || return 0
  kill -STOP "$WATCHDOG" >/dev/null 2>&1
  pkill -KILL -P "$WATCHDOG" >/dev/null 2>&1
  kill -KILL "$WATCHDOG" >/dev/null 2>&1
  kill -CONT "$WATCHDOG" >/dev/null 2>&1
  wait "$WATCHDOG" 2>/dev/null
  WATCHDOG=""
}
# no_leftovers: false, with each one in $LEFTOVERS (and KILLed), when a live
# process other than this shell still names "$R/" in its argv or environ after
# a 3 s grace for the swept ones to exit. Linux (/proc) only.
no_leftovers() {
  local p pid _
  [ -d /proc/self ] || return 0
  for _ in $(seq 15); do
    : >"$LEFTOVERS"
    for p in /proc/[0-9]*; do
      pid=${p#/proc/}
      [ "$pid" = "$$" ] && continue
      grep -qsF "$R/" "$p/cmdline" "$p/environ" 2>/dev/null || continue
      ps -o pid=,args= -p "$pid" >>"$LEFTOVERS" 2>/dev/null
    done
    [ -s "$LEFTOVERS" ] || return 0
    sleep 0.2
  done
  while read -r pid _; do kill -KILL "$pid" >/dev/null 2>&1; done <"$LEFTOVERS"
  return 1
}

cleanup() {
  local rc=$?
  set +e
  trap - EXIT INT TERM HUP
  # A signal's trap runs inside whatever redirection was active (`mu ... >file`):
  # report on the caller's own stdout and stderr, saved below.
  exec 1>&3 2>&4
  say "cleanup (exit $rc)"
  reap_watchdog
  TMUX_TMPDIR="$R/ltmux" tmux -L "$MU_TMUX" kill-server >/dev/null 2>&1
  TMUX_TMPDIR="$R/rtmux" tmux -L "$MULE_TMUX" kill-server >/dev/null 2>&1
  for s in "$R/m/mule.sock" "$R/m/default.sock"; do
    [ -S "$s" ] && "$R/bin/ssh" -S "$s" -O exit 127.0.0.1 >/dev/null 2>&1
  done
  [ -n "$SSHD_PID" ] && kill "$SSHD_PID" >/dev/null 2>&1
  # Anything else this run started names $R in its argv: TERM, then KILL.
  pkill -TERM -f "$R/" >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "$R/" >/dev/null 2>&1 || break; sleep 0.2; done
  pkill -KILL -f "$R/" >/dev/null 2>&1
  [ -n "$SSHD_PID" ] && kill -KILL "$SSHD_PID" >/dev/null 2>&1
  if ! no_leftovers; then
    say "FAIL leftover processes after the sweep (killed now):"
    sed 's/^/  /' "$LEFTOVERS"
    [ "$rc" != 0 ] || rc=1
  fi
  rm -rf "$RSOCK_DIR"
  rmdir "/tmp/mu-$UID_" >/dev/null 2>&1
  if [ "${SMOKE_KEEP:-}" = 1 ]; then say "kept $R"; else rm -rf "$R"; fi
  if [ "$rc" = 0 ]; then say "SMOKE PASS"; else say "SMOKE FAIL (exit $rc)"; fi
  exit "$rc"
}
exec 3>&1 4>&2
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# The whole run is bounded: the watchdog TERMs this shell, whose trap cleans up.
# Its sleep holds no caller fd open, and cleanup reaps both (reap_watchdog).
(
  sleep "$LIMIT" 2>/dev/null
  echo "smoke-hybrid: SMOKE_TIMEOUT ($LIMIT s) reached" >&2
  kill -TERM $$
) </dev/null >/dev/null 3>&- 4>&- &
WATCHDOG=$!

mkdir -p "$R"/{bin,rbin,m,tmp,home,config,cache,lstate,ltmux,rtmux,rhome/.local/state}
chmod 700 "$R/m" "$R/ltmux" "$R/rtmux"
cp "$MULE/target/release/mule" "$MULE/target/release/mu-plugin-mule" "$R/bin/"
chmod 755 "$R/bin/mule" "$R/bin/mu-plugin-mule"
cp "$SCRIPTS/smoke-ext-pi.mjs" "$R/rbin/smoke-ext-pi.mjs"
# The node binary itself, not a version manager's shim (a shim resolves through $HOME).
NODE=$(node -e 'console.log(process.execPath)')
SSH_KEYGEN=$(command -v ssh-keygen)
for c in tmux git git-upload-pack; do ln -s "$(command -v "$c")" "$R/rbin/$c"; done
LSOF=$(command -v lsof)

while IFS= read -r v; do unset "$v"; done < <(env | sed -n 's/^\(MU_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(PI_[A-Za-z0-9_]*\)=.*/\1/p')
unset TMUX TMUX_PANE
export HOME="$R/home" TMPDIR="$R/tmp" XDG_CONFIG_HOME="$R/config" XDG_CACHE_HOME="$R/cache"
export XDG_STATE_HOME="$R/lstate" TMUX_TMPDIR="$R/ltmux"
export MU_DB_PATH="$R/lstate/mu-next/mu.db" MU_SYNC_DIR="" MU_TMUX_SOCKET="$MU_TMUX" MU_MUX=tmux
export MURMUR_STATE_DIR="$R/lstate/murmur"
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@localhost
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@localhost
export PATH="$R/bin:$PATH"
mkdir -p "$R/lstate/mu-next"

# Every orchestrator verb runs here, through this function, under a deadline.
mu() { "$TO" -k 5 180 "$NODE" "$MU/dist/cli.js" "$@"; }
printf '#!/bin/sh\nexec %s %s "$@"\n' "$NODE" "$MU/dist/cli.js" >"$R/bin/mu"
chmod 755 "$R/bin/mu"
# H5's tripwire: the "remote" side's `mu` records its argv and fails.
printf '#!/bin/sh\necho "$*" >>%s\nexit 97\n' "$R/remote-mu.log" >"$R/rbin/mu"
chmod 755 "$R/rbin/mu"
# The pi on both sides: the real built ctl extension in a recording pi API.
for d in bin rbin; do
  printf '#!/bin/sh\nSMOKE_EXT=%s exec %s %s "$@"\n' "$MU/dist/extension/mu-pi.js" "$NODE" "$R/rbin/smoke-ext-pi.mjs" >"$R/$d/pi"
  chmod 755 "$R/$d/pi"
done
mule() { "$TO" -k 5 120 "$R/bin/mule" --config "$R/mule.toml" "$@"; }
js() {
  "$NODE" -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=(0,eval)("(d)=>("+process.argv[1]+")")(d);if(v===undefined||v===null||v===false)process.exit(1);console.log(typeof v==="string"?v:JSON.stringify(v));' "$1"
}
sql() { mu sql "$1" | js 'd.data.items'; }
count() { sql "SELECT count(*) AS n FROM $1" | js 'd[0].n'; }
until_ok() {
  local n=$1 what=$2
  shift 2
  for _ in $(seq "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  fail "timed out: $what"
}
g() { "$TO" 60 git "$@"; }

# ── loopback sshd, MaxSessions 1 ─────────────────────────────────────────────
PORT=$("$NODE" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
"$SSH_KEYGEN" -q -t ed25519 -N '' -f "$R/hostkey"
"$SSH_KEYGEN" -q -t ed25519 -N '' -f "$R/id"
cp "$R/id.pub" "$R/authorized_keys"
cat >"$R/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $R/hostkey
PidFile $R/sshd.pid
AuthorizedKeysFile $R/authorized_keys
MaxSessions 1
LogLevel VERBOSE
UsePAM no
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowStreamLocalForwarding yes
SetEnv HOME=$R/rhome XDG_STATE_HOME=$R/rhome/.local/state TMUX_TMPDIR=$R/rtmux PATH=$R/rbin:/usr/bin:/bin:/usr/sbin:/sbin
EOF
chmod 600 "$R/hostkey" "$R/id" "$R/authorized_keys" "$R/sshd_config"
"$SSHD" -f "$R/sshd_config" -E "$R/sshd.log" || fail "sshd did not start (log: $R/sshd.log)"
until_ok 50 "sshd pid file" test -s "$R/sshd.pid"
SSHD_PID=$(cat "$R/sshd.pid")
cat >"$R/bin/ssh" <<EOF
#!/bin/sh
exec /usr/bin/ssh -F /dev/null -i $R/id -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \\
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=20 -p $PORT "\$@"
EOF
chmod 755 "$R/bin/ssh"
until_ok 100 "sshd answers" "$TO" 20 ssh -S none -o BatchMode=yes 127.0.0.1 true
pass "loopback sshd pid $SSHD_PID on 127.0.0.1:$PORT, MaxSessions 1"

ssh -MNf -S "$R/m/mule.sock" -o ControlPersist=8h -o StreamLocalBindUnlink=yes 127.0.0.1
ssh -MNf -S "$R/m/default.sock" -o ControlPersist=8h 127.0.0.1
master_pid() { "$TO" 20 ssh -S "$1" -O check 127.0.0.1 2>&1 | sed -n 's/.*pid=\([0-9]*\).*/\1/p'; }
MULE_MASTER=$(master_pid "$R/m/mule.sock")
[ -n "$MULE_MASTER" ] || fail "no mule master"
via_default() { "$TO" 30 ssh -S "$R/m/default.sock" -o BatchMode=yes -o ControlMaster=no -o ProxyCommand=/usr/bin/false 127.0.0.1 "$@"; }
# The cap is real: while a session holds a master, a second one on it is refused.
# sshd's log line for that refusal is the oracle H3 checks stays at this count.
refusals() { grep -c -i 'no more sessions\|session open refused\|open failed' "$R/sshd.log" || true; }
via_default 'sleep 3' &
held=$!
sleep 1
if via_default true 2>"$R/refused.err"; then fail "MaxSessions 1 is not in effect"; fi
wait "$held"
"$TO" 20 ssh -S "$R/m/default.sock" -O exit 127.0.0.1 >/dev/null 2>&1 || true
REFUSED0=$(refusals)
[ "$REFUSED0" -ge 1 ] || fail "sshd logged no refusal for the cap test (log: $(tail -n 5 "$R/sshd.log"))"
pass "cap reproduced: a second session on a held master is refused (client: $(head -n 1 "$R/refused.err"); sshd logged $REFUSED0 refusal line(s))"

cat >"$R/mule.toml" <<EOF
[hosts.loop]
target = "127.0.0.1"
socket = "$R/m/mule.sock"
tmux_socket = "$MULE_TMUX"
EOF

# ── fixture repos, plugin profile ────────────────────────────────────────────
RREPO="$R/rhome/repo"
LREPO="$R/local"
PUB="$R/pub.git"
g init -q "$RREPO"
echo base >"$RREPO/base.txt"
g -C "$RREPO" add base.txt
g -C "$RREPO" commit -q -m "hybrid base"
BASE=$(g -C "$RREPO" rev-parse HEAD)
g clone -q "$RREPO" "$LREPO"
# The "published" remote both sides can reach: the orchestrator pushes, the host fetches.
g init -q --bare "$PUB"

mu workstream init "$WS" >/dev/null
mule init --quiet >"$R/init.out" 2>&1 || {
  cat "$R/init.out"
  fail "mule init"
}
mu host add loop --plugin mule --fetch "git fetch ssh://127.0.0.1{cwd} HEAD" --max-sessions 1 >/dev/null ||
  fail "mu host add loop --plugin mule"
mu host show loop --json | js "d.data.host.plugin === 'mule'" >/dev/null || fail "host loop is not a --plugin mule profile"
mu host check loop --root "$RREPO" --json >"$R/check.json" || {
  cat "$R/check.json"
  fail "mu host check loop"
}
pass "plugin profile loop (--plugin mule, --max-sessions 1): host check $(js 'd.data.steps.map((s)=>s.step+"="+s.ok).join(" ")' <"$R/check.json")"

# ── per-agent helpers ────────────────────────────────────────────────────────
job_file() { echo "$R/lstate/mu-next/carrier/$WS/$1.job"; }
local_sock() { echo "$R/lstate/mu-next/sock/$WS/$1.sock"; }
remote_wt() { echo "$R/rhome/.local/state/mu-next/remote-worktrees/$WS/$1"; }
agent_cwd() { sql "SELECT a.cwd FROM agents a JOIN workstreams w ON w.id=a.workstream_id WHERE w.name='$WS' AND a.name='$1'" | js 'd[0]?.cwd'; }
remote_sessions() { TMUX_TMPDIR="$R/rtmux" "$TO" 10 tmux -L "$MULE_TMUX" list-sessions 2>/dev/null | wc -l | tr -d ' '; }
mule_jobs() {
  local out
  out=$(mule ls --host loop --all --json 2>"$R/mule-ls.err") || fail "mule ls --host loop: $(cat "$R/mule-ls.err")"
  printf '%s' "$out" | js 'd.unreachable.length === 0' >/dev/null || fail "mule ls: loop unreachable: $out"
  printf '%s' "$out"
}
job_state() { mule_jobs | js "(d.items.find((j)=>j.id==='$1')||{}).state ?? 'absent'"; }
forward_held() {
  "$LSOF" -a -p "$MULE_MASTER" -U -Fn 2>/dev/null |
    awk -v want="n$1" '$0 == want || index($0, want " ") == 1 { f = 1 } END { exit !f }'
}
declare -A JOBS=()

# spawn_remote <name> [extra spawn args...]: a rung-4 lease job through the plugin.
spawn_remote() {
  local a=$1 job wt
  shift
  wt=$(remote_wt "$a")
  (cd "$LREPO" && mu agent spawn "$a" -w "$WS" --host loop --worktree --root "$RREPO" --json "$@") >"$R/spawn-$a.json" || {
    cat "$R/spawn-$a.json"
    fail "rung-4 spawn $a"
  }
  job=$(sql "SELECT job FROM carrier_jobs WHERE workstream='$WS' AND name='$a'" | js 'd[0]?.job') || fail "no carrier_jobs handle for $a"
  [[ "$job" =~ ^[0-9a-f]{6}$ ]] || fail "job handle '$job' is not a mule id"
  [ "$(job_state "$job")" = running ] || fail "job $job of $a is not running"
  [ -d "$(remote_wt "$a")" ] || fail "no remote worktree for $a"
  forward_held "$(local_sock "$a")" || fail "the ctl forward of $a is not bound by mule's master"
  [ "$(js 'd.data.ctl ?? d.data.agent?.ctl ?? "?"' <"$R/spawn-$a.json")" = ok ] || fail "spawn $a: ctl handshake not ok"
  JOBS[$a]=$job
  pass "rung 4: $a spawned as mule job $job (remote tree \$R${wt#"$R"}, ctl ok through master $MULE_MASTER)"
}
# spawn_local <name> [--from <ref>]: a rung-0 worker in a local pane and worktree.
spawn_local() {
  local a=$1 cwd
  shift
  (cd "$LREPO" && mu agent spawn "$a" -w "$WS" --worktree --json "$@") >"$R/spawn-$a.json" || {
    cat "$R/spawn-$a.json"
    fail "rung-0 spawn $a"
  }
  [ "$(js 'd.data.ctl ?? d.data.agent?.ctl ?? "?"' <"$R/spawn-$a.json")" = ok ] || fail "spawn $a: ctl handshake not ok"
  cwd=$(agent_cwd "$a") || fail "no cwd for $a"
  [ -d "$cwd" ] || fail "local worktree $cwd of $a missing"
  case "$cwd" in "$R/rhome"/*) fail "rung-0 worker $a runs in the remote area ($cwd)" ;; esac
  [ "$(sql "SELECT count(*) AS n FROM agents WHERE name='$a' AND host IS NULL" | js 'd[0].n')" = 1 ] ||
    fail "rung-0 worker $a has a host"
  pass "rung 0: $a spawned in a local pane, worktree \$R${cwd#"$R"}"
}

# ask <name> <cmd>: run <cmd> in the worker's own shell (a smoke-sh send), wait
# for the settled run, leave its reply in REPLY; fails unless it exited 0.
ask() {
  local a=$1 cmd=$2
  mu agent send "$a" -w "$WS" "smoke-sh: $cmd" --wait --json >"$R/ask-$a.json" || {
    cat "$R/ask-$a.json"
    fail "send --wait to $a"
  }
  REPLY=$(js 'd.data.snapshots?.[0]?.lastText' <"$R/ask-$a.json") || {
    cat "$R/ask-$a.json"
    fail "no lastText from $a"
  }
  case "$REPLY" in "smoke-sh exit=0 "*) ;; *)
    printf '%s\n' "$REPLY"
    fail "$a: '$cmd' did not exit 0"
    ;;
  esac
}
COMMIT_C="git -c user.name=smoke -c user.email=smoke@localhost commit -q"

# close_agent <name>: preview + --if close, then H6 for that agent.
close_agent() {
  local a=$1 rev left=() n t cwd=""
  cwd=$(agent_cwd "$a" 2>/dev/null) || cwd=""
  rev=$(mu agent close "$a" -w "$WS" --json | js 'd.data.revision') || fail "close preview of $a"
  mu agent close "$a" -w "$WS" --if "$rev" --json >"$R/close-$a.json" || {
    cat "$R/close-$a.json"
    fail "mu agent close $a"
  }
  for t in carrier_jobs remote_recovery; do
    n=$(sql "SELECT count(*) AS n FROM $t WHERE workstream='$WS' AND name='$a'" | js 'd[0].n') || fail "counting $t"
    [ "$n" = 0 ] || left+=("$n $t row(s)")
  done
  n=$(sql "SELECT count(*) AS n FROM agents WHERE name='$a'" | js 'd[0].n')
  [ "$n" = 0 ] || left+=("agents row")
  for t in effects host_channels; do
    n=$(count "$t")
    [ "$n" = 0 ] || left+=("$n $t row(s)")
  done
  [ ! -e "$(local_sock "$a")" ] || left+=("local socket")
  [ ! -e "$(job_file "$a")" ] || left+=("job file")
  [ ! -e "$(remote_wt "$a")" ] || left+=("remote worktree")
  [ ! -e "$RSOCK_DIR/$a.sock" ] || left+=("remote ctl socket")
  if forward_held "$(local_sock "$a")"; then left+=("forward on mule's master"); fi
  if [ -n "${JOBS[$a]:-}" ] && [ "$(job_state "${JOBS[$a]}")" != absent ]; then left+=("mule job ${JOBS[$a]}"); fi
  [ -z "$cwd" ] || [ ! -e "$cwd" ] || left+=("worktree $cwd")
  if [ ${#left[@]} -gt 0 ]; then
    printf '  left: %s\n' "${left[@]}"
    fail "close of $a left state behind"
  fi
  unset "JOBS[$a]"
  [ "$(remote_sessions)" = "${#JOBS[@]}" ] || fail "after closing $a: $(remote_sessions) remote tmux session(s), ${#JOBS[@]} live job(s)"
  pass "close $a: no forward, job, tree, socket, job file, agent/carrier_jobs/remote_recovery row, effects or host_channels row ($(remote_sessions) remote session(s) left = live rung-4 workers)"
}

# ── H1. a rung-4 and a rung-0 worker at once ─────────────────────────────────
say "H1. rung 4 and rung 0 side by side"
spawn_remote r4-a
spawn_local r0-a
LIST=$(sql "SELECT a.name, a.host FROM agents a JOIN workstreams w ON w.id=a.workstream_id WHERE w.name='$WS' ORDER BY a.name")
printf '%s' "$LIST" | js "d.length === 2 && d[0].name === 'r0-a' && d[0].host == null && d[1].name === 'r4-a' && d[1].host === 'loop'" >/dev/null ||
  fail "agents: $LIST"
ask r4-a 'pwd; git rev-parse HEAD'
case "$REPLY" in *"cwd=$(remote_wt r4-a)"*"$BASE"*) ;; *) fail "r4-a's shell is not its remote tree at base: $REPLY" ;; esac
ask r0-a 'pwd; git rev-parse HEAD'
case "$REPLY" in *"cwd=$(agent_cwd r0-a)"*"$BASE"*) ;; *) fail "r0-a's shell is not its local tree at base: $REPLY" ;; esac
pass "one workstream, one DB: r4-a (host loop) and r0-a (local) both answer from their own trees at ${BASE:0:12}"

# ── H2. remote -> local ──────────────────────────────────────────────────────
say "H2. rung-4 worker commits; collect, merge, rung-0 reviewer verifies"
ask r4-a "echo from-rung-4 >h2.txt && git add h2.txt && $COMMIT_C -m 'h2: from rung 4' && git rev-parse HEAD"
C1=$(printf '%s\n' "$REPLY" | grep -E '^[0-9a-f]{40}$' | tail -n 1) || fail "r4-a printed no commit: $REPLY"
! g -C "$LREPO" cat-file -e "$C1^{commit}" 2>/dev/null || fail "$C1 is local before the collect"
(cd "$LREPO" && mu agent collect r4-a -w "$WS" --json) >"$R/collect1.json" || {
  cat "$R/collect1.json"
  fail "collect r4-a"
}
js "d.data.changed === true && d.data.head === '$C1' && d.data.ref === 'refs/mu/collect/$WS/r4-a'" <"$R/collect1.json" >/dev/null || {
  cat "$R/collect1.json"
  fail "collect r4-a did not pin $C1"
}
g -C "$LREPO" merge -q --ff-only "refs/mu/collect/$WS/r4-a" || fail "merge refs/mu/collect/$WS/r4-a"
[ "$(g -C "$LREPO" rev-parse HEAD)" = "$C1" ] || fail "orchestrator HEAD is not $C1 after the merge"
pass "collect pinned ${C1:0:12} at refs/mu/collect/$WS/r4-a; merged fast-forward into the orchestrator's checkout"
spawn_local r0-review
ask r0-review "git cat-file -e $C1^{commit} && git merge-base --is-ancestor $C1 HEAD && cat h2.txt"
case "$REPLY" in *from-rung-4*) ;; *) fail "the reviewer did not see h2.txt: $REPLY" ;; esac
pass "rung-0 reviewer r0-review (local pane) verifies ${C1:0:12} and h2.txt in its worktree"

# ── H3. rung 1 alongside, under per-host admission ───────────────────────────
say "H3. mu host exec x4 + a collect, concurrent, while r4-a, r0-a, r0-review run"
# The oracle (spec §4): the mule link owns its slots, so no `exec:*` holder may
# EVER appear in host_channels; the template-fallback collect may hold its one
# `collect:<ws>/r4-a` row; nothing else. Every exec holds its call for 2 s, so
# a regression that took mu's gate for an exec would sit in the table across
# many samples. A failed read fails H3; it never reads as an empty table.
holders() { mu sql "SELECT holder FROM host_channels ORDER BY holder" | js 'd.data.items.map((r)=>r.holder).join(" ")'; }
: >"$R/h3.samples"
(
  while [ ! -e "$R/h3.done" ]; do
    h=$(holders) || {
      echo "READ-FAILED" >>"$R/h3.samples"
      exit 1
    }
    echo "[$h]" >>"$R/h3.samples"
    sleep 0.05
  done
) &
POLLER=$!
pids=()
for i in 1 2 3 4; do
  mu host exec loop --json -- sh -c "sleep 2; echo exec-$i" >"$R/hx-$i.json" 2>"$R/hx-$i.err" &
  pids+=($!)
done
(cd "$LREPO" && mu agent collect r4-a -w "$WS" --json) >"$R/collect-h3.json" 2>&1 &
pids+=($!)
rcs=()
for p in "${pids[@]}"; do
  rc=0
  wait "$p" || rc=$?
  rcs+=("$rc")
done
touch "$R/h3.done"
PRC=0
wait "$POLLER" || PRC=$?
# The admission oracle first: it names the regression an exit code only hints at.
if [ "$PRC" != 0 ] || grep -qx READ-FAILED "$R/h3.samples"; then
  fail "H3's host_channels poll failed a read (samples: $(tr '\n' ' ' <"$R/h3.samples"))"
fi
SAMPLES=$(wc -l <"$R/h3.samples" | tr -d ' ')
[ "$SAMPLES" -ge 5 ] || fail "H3 took only $SAMPLES host_channels sample(s) during ~8 s of held execs"
if grep -E '[[ ]exec:' "$R/h3.samples" >/dev/null; then
  fail "a host exec on the slots:\"self\" mule link took a mu admission row: $(grep -E '[[ ]exec:' "$R/h3.samples" | sort -u | tr '\n' ' ')"
fi
BAD=$(grep -vxE "\[(collect:$WS/r4-a)?\]" "$R/h3.samples" | sort -u | tr '\n' ' ' || true)
[ -z "$BAD" ] || fail "host_channels held more than the collect's one row (max_sessions 1): $BAD"
for i in 1 2 3 4; do
  [ "${rcs[$((i - 1))]}" = 0 ] || {
    cat "$R/hx-$i.json" "$R/hx-$i.err"
    fail "host exec #$i exited ${rcs[$((i - 1))]}"
  }
  js "d.data.exit === 0 && d.data.stdout.trim() === 'exec-$i'" <"$R/hx-$i.json" >/dev/null || fail "host exec #$i: $(cat "$R/hx-$i.json")"
done
[ "${rcs[4]}" = 0 ] || {
  cat "$R/collect-h3.json"
  fail "the concurrent collect exited ${rcs[4]}"
}
COLLECT_SEEN=$(grep -cxF "[collect:$WS/r4-a]" "$R/h3.samples" || true)
[ "$(count host_channels)" = 0 ] || fail "host_channels rows left after H3"
[ "$(refusals)" = "$REFUSED0" ] || fail "sshd refused a session during H3: $(grep -i 'no more sessions\|refused\|open failed' "$R/sshd.log" | tail -n 3)"
if grep -i 'administratively prohibited\|open failed' "$R"/hx-*.err >/dev/null 2>&1; then fail "a host exec saw a refused channel"; fi
[ "$(job_state "${JOBS[r4-a]}")" = running ] || fail "r4-a's job is not running after H3"
pass "4 concurrent 2 s host execs exit 0 (mule serialises its sessions) beside a collect: sshd refused nothing; $SAMPLES host_channels samples, 0 exec:* holders, only collect:$WS/r4-a (seen in $COLLECT_SEEN), 0 rows now"
close_agent r0-review
close_agent r4-a

# ── H4. local -> remote ──────────────────────────────────────────────────────
say "H4. rung-0 worker commits; the base reaches the host per spec §3.3; rung-4 builds on it"
ask r0-a "git merge -q --ff-only $C1 && echo from-rung-0 >h4.txt && git add h4.txt && $COMMIT_C -m 'h4: from rung 0' && git rev-parse HEAD"
C2=$(printf '%s\n' "$REPLY" | grep -E '^[0-9a-f]{40}$' | tail -n 1) || fail "r0-a printed no commit: $REPLY"
g -C "$LREPO" merge -q --ff-only "$C2" || fail "merge $C2 (rung-0 commit) into the orchestrator's checkout"
[ "$(g -C "$LREPO" rev-parse HEAD)" = "$C2" ] || fail "orchestrator HEAD is not $C2"
! g -C "$RREPO" cat-file -e "$C2^{commit}" 2>/dev/null || fail "$C2 is already on the host"
pass "r0-a committed ${C2:0:12} locally; merged fast-forward into the orchestrator's checkout"
RC=0
(cd "$LREPO" && mu agent spawn r4-b -w "$WS" --host loop --worktree --root "$RREPO" --json) >"$R/refused.json" 2>&1 || RC=$?
[ "$RC" = 5 ] || {
  cat "$R/refused.json"
  fail "rung-4 spawn from a local-only base: exit $RC, expected 5"
}
js "JSON.stringify(d).includes('RemoteBaseMissingError') && ['loop', '$RREPO', '$C2', 'mu host exec loop -- git -C', 'push it to a remote the host can fetch'].every((s)=>JSON.stringify(d).includes(s))" <"$R/refused.json" >/dev/null || {
  cat "$R/refused.json"
  fail "the missing-base refusal does not name host, repo, sha and both fixes"
}
[ "$(sql "SELECT count(*) AS n FROM agents WHERE name='r4-b'" | js 'd[0].n')" = 0 ] || fail "the refused spawn kept an agent row"
[ "$(sql "SELECT count(*) AS n FROM carrier_jobs WHERE name='r4-b'" | js 'd[0].n')" = 0 ] || fail "the refused spawn kept a reservation"
[ "$(count effects)" = 0 ] || fail "the refused spawn kept an effect"
[ ! -e "$(remote_wt r4-b)" ] || fail "the refused spawn made a remote tree"
[ ! -e "$(job_file r4-b)" ] || fail "the refused spawn left a job file"
[ "$(remote_sessions)" = 0 ] || fail "the refused spawn started a remote job"
pass "spawn from local-only ${C2:0:12}: RemoteBaseMissingError (exit 5) naming host, repo, sha and both fixes; no row, reservation, effect, tree, job file or job"
# The named remedy for a local-only commit: push it to a remote the host can fetch, then that fetch on the host (rung 1).
g -C "$LREPO" push -q "$PUB" "HEAD:refs/heads/hybrid" || fail "push to the published remote"
mu host exec loop --json -- git -C "$RREPO" fetch -q "$PUB" "$C2" >"$R/fetch.json" || {
  cat "$R/fetch.json"
  fail "mu host exec loop -- git fetch (the named remedy)"
}
js 'd.data.exit === 0' <"$R/fetch.json" >/dev/null || fail "host-side fetch: $(cat "$R/fetch.json")"
g -C "$RREPO" cat-file -e "$C2^{commit}" || fail "$C2 is not on the host after the remedy"
pass "remedy: pushed to the published remote, mu host exec loop -- git -C <repo> fetch <remote> ${C2:0:12}"
spawn_remote r4-b --from "$C2"
ask r4-b "git rev-parse HEAD && cat h4.txt h2.txt"
case "$REPLY" in *"$C2"*from-rung-0*from-rung-4*) ;; *) fail "r4-b does not start at ${C2:0:12}: $REPLY" ;; esac
ask r4-b "echo on-top >h4b.txt && git add h4b.txt && $COMMIT_C -m 'h4: rung 4 on top of rung 0' && git rev-parse HEAD"
C3=$(printf '%s\n' "$REPLY" | grep -E '^[0-9a-f]{40}$' | tail -n 1) || fail "r4-b printed no commit: $REPLY"
(cd "$LREPO" && mu agent collect r4-b -w "$WS" --json) >"$R/collect2.json" || {
  cat "$R/collect2.json"
  fail "collect r4-b"
}
js "d.data.changed === true && d.data.head === '$C3'" <"$R/collect2.json" >/dev/null || fail "collect r4-b: $(cat "$R/collect2.json")"
g -C "$LREPO" merge -q --ff-only "refs/mu/collect/$WS/r4-b" || fail "merge refs/mu/collect/$WS/r4-b"
[ "$(g -C "$LREPO" rev-parse HEAD)" = "$C3" ] && [ "$(g -C "$LREPO" rev-parse HEAD^)" = "$C2" ] ||
  fail "orchestrator HEAD is not $C3 on top of $C2"
pass "r4-b started at ${C2:0:12}, committed ${C3:0:12} on top; collected and merged fast-forward (HEAD^ = the rung-0 commit)"
close_agent r4-b
close_agent r0-a

# ── H5, H6. nothing ran remotely; nothing left ───────────────────────────────
say "H5/H6. orchestrator verbs stayed local; nothing stale"
[ ! -e "$R/remote-mu.log" ] || fail "a mu verb ran on the remote side: $(cat "$R/remote-mu.log")"
REMOTE_DB=$(find "$R/rhome" -name 'mu.db*' 2>/dev/null | head -n 1)
[ -z "$REMOTE_DB" ] || fail "a mu DB appeared on the remote side: $REMOTE_DB"
pass "the remote mu tripwire never fired and no mu.db exists on the remote side"
no_mule_left() { ! pgrep -f "$R/bin/mule " >/dev/null; }
until_ok 100 "every mule process of this run to exit" no_mule_left
STALE=()
for t in carrier_jobs agents host_channels effects remote_recovery; do
  n=$(count "$t")
  [ "$n" = 0 ] || STALE+=("$n $t row(s)")
done
[ "$(mule_jobs | js 'd.items.length')" = 0 ] || STALE+=("mule jobs: $(mule_jobs)")
[ "$(remote_sessions)" = 0 ] || STALE+=("$(remote_sessions) remote tmux session(s)")
[ -z "$(ls -A "$RSOCK_DIR" 2>/dev/null)" ] || STALE+=("remote ctl sockets: $(ls -A "$RSOCK_DIR")")
[ -z "$(ls -A "$R/lstate/mu-next/sock/$WS" 2>/dev/null)" ] || STALE+=("local sockets: $(ls -A "$R/lstate/mu-next/sock/$WS")")
[ -z "$(ls -A "$R/lstate/mu-next/carrier/$WS" 2>/dev/null)" ] || STALE+=("job files")
if "$LSOF" -a -p "$MULE_MASTER" -U -Fn 2>/dev/null | grep -F "$R/lstate" >/dev/null; then STALE+=("forwards on mule's master"); fi
[ "$(g -C "$RREPO" worktree list | wc -l | tr -d ' ')" = 1 ] || STALE+=("remote git worktrees: $(g -C "$RREPO" worktree list)")
[ "$(g -C "$LREPO" worktree list | wc -l | tr -d ' ')" = 1 ] || STALE+=("local git worktrees: $(g -C "$LREPO" worktree list)")
if [ ${#STALE[@]} -gt 0 ]; then
  printf '  stale: %s\n' "${STALE[@]}"
  fail "state left after the hybrid run"
fi
pass "end: 0 rows in carrier_jobs/agents/host_channels/effects/remote_recovery, no mule job, remote session, socket, job file, forward or extra worktree"
