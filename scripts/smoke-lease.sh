#!/usr/bin/env bash
# Operator smoke for the lease transport (docs/specs/2026-10-28-lease-transport.md
# § Testing, Smoke). Explicitly invoked, never picked up by vitest:
#
#   MU=~/hacking/crew/mu MULE=~/hacking/crew/mule bash scripts/smoke-lease.sh
#
# It builds mule (cargo build --release) and mu (npm run build), starts a
# loopback `sshd MaxSessions 1` (mule SPEC.md § Reproduce the channel cap
# locally) as the only "remote", opens mule's master and a second "default"
# master, and drives the built mule from a mu lease profile against a
# ctl-speaking fake pi (scripts/smoke-fake-pi.mjs). It asserts the spec's smoke
# list:
#   1. spawn: a job handle, no host channel, the ctl forward bound by the master;
#      `ssh -S <default master> host true` succeeds while the worker runs
#   2. send + wait: the fake pi's settled lastText echoes the sent text
#   3. close: no job, no forward, no socket, no job file, no worktree, no
#      carrier_jobs row
#   4. kill -9 the carrier: the job survives, reconcile reaps the row, close by
#      name stops the job
#   5. a respawn of the name rebinds the stale forward; its close is clean too
#
# Everything is private: own dir under /tmp (short, for unix socket paths),
# TMPDIR, HOME, XDG_*, MU_DB_PATH, MU_SYNC_DIR= blank, a private tmux server
# (MU_TMUX_SOCKET + TMUX_TMPDIR), mule --config and XDG_STATE_HOME on both
# sides. The one path outside it is mu's derived remote ctl socket dir
# /tmp/mu-<uid>/<workstream> (not configurable), under a unique workstream and
# removed on exit. No host but 127.0.0.1 is contacted.
#
# Missing prerequisites FAIL (exit 2); they never count as a pass. Every
# process it starts (sshd, both masters, both tmux servers, carriers, fake pis)
# is stopped by the EXIT trap, also on failure. SMOKE_KEEP=1 keeps the dir.

set -euo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
MU=${MU:-$(dirname "$SCRIPTS")}
MULE=${MULE:-}
SSHD=${SSHD:-/usr/sbin/sshd}
FAKE_PI_SRC="$SCRIPTS/smoke-fake-pi.mjs"

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
for c in ssh ssh-keygen tmux node npm cargo git lsof; do need_cmd "$c"; done
[ -x "$SSHD" ] || missing+=("sshd at $SSHD")
[ -n "$MULE" ] || missing+=("MULE (path to the mule checkout) is not set")
[ -z "$MULE" ] || [ -f "$MULE/Cargo.toml" ] || missing+=("mule checkout at $MULE (no Cargo.toml)")
[ -f "$MU/package.json" ] || missing+=("mu checkout at $MU (no package.json)")
[ -d "$MU/node_modules" ] || missing+=("$MU/node_modules (run npm install there)")
[ -f "$FAKE_PI_SRC" ] || missing+=("$FAKE_PI_SRC")
if [ ${#missing[@]} -gt 0 ]; then
  for m in "${missing[@]}"; do echo "smoke-lease: PREREQUISITE MISSING: $m" >&2; done
  echo "smoke-lease: FAIL (prerequisites missing; this is not a pass)" >&2
  exit 2
fi
MU=$(cd "$MU" && pwd -P)
MULE=$(cd "$MULE" && pwd -P)

# ── build ────────────────────────────────────────────────────────────────────
say "build mule: cargo build --release in $MULE"
(cd "$MULE" && cargo build --release --quiet) || fail "cargo build --release"
say "build mu: npm run build in $MU"
(cd "$MU" && npm run build --silent >/dev/null) || fail "npm run build"
[ -x "$MULE/target/release/mule" ] || fail "no mule binary after the build"
[ -f "$MU/dist/cli.js" ] || fail "no mu dist/cli.js after the build"
say "mule $(git -C "$MULE" rev-parse --short HEAD 2>/dev/null || echo '?') ($("$MULE/target/release/mule" --version)), mu $(git -C "$MU" rev-parse --short HEAD 2>/dev/null || echo '?')"

# ── private world ────────────────────────────────────────────────────────────
R=$(cd "$(mktemp -d /tmp/mu-smoke.XXXXXX)" && pwd -P)
UID_=$(id -u)
WS="smoke-$$"
RSOCK_DIR="/tmp/mu-$UID_/$WS"
MU_TMUX="mu-smoke-$$"
MULE_TMUX="mule-smoke-$$"
SSHD_PID=""

cleanup() {
  local rc=$?
  set +e
  trap - EXIT INT TERM HUP
  say "cleanup (exit $rc)"
  if [ "$rc" != 0 ] && [ -d "$R/lstate/mule" ]; then
    say "mule lock state at failure:"
    for f in "$R"/lstate/mule/*.lock/*; do
      [ -f "$f" ] && printf '  %s: %q\n' "${f#"$R"/}" "$(cat "$f")"
    done
  fi
  TMUX_TMPDIR="$R/ltmux" tmux -L "$MU_TMUX" kill-server >/dev/null 2>&1
  TMUX_TMPDIR="$R/rtmux" tmux -L "$MULE_TMUX" kill-server >/dev/null 2>&1
  for s in "$R/m/mule.sock" "$R/m/default.sock"; do
    [ -S "$s" ] && "$R/bin/ssh" -S "$s" -O exit 127.0.0.1 >/dev/null 2>&1
  done
  [ -n "$SSHD_PID" ] && kill "$SSHD_PID" >/dev/null 2>&1
  # Anything else this run started names $R in its argv (carriers, detached
  # `mule rm` children, fake pis, ssh shims): TERM, then KILL.
  pkill -TERM -f "$R/" >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "$R/" >/dev/null 2>&1 || break; sleep 0.2; done
  pkill -KILL -f "$R/" >/dev/null 2>&1
  [ -n "$SSHD_PID" ] && kill -KILL "$SSHD_PID" >/dev/null 2>&1
  rm -rf "$RSOCK_DIR"
  rmdir "/tmp/mu-$UID_" >/dev/null 2>&1
  if [ "${SMOKE_KEEP:-}" = 1 ]; then say "kept $R"; else rm -rf "$R"; fi
  if [ "$rc" = 0 ]; then say "SMOKE PASS"; else say "SMOKE FAIL (exit $rc)"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mkdir -p "$R"/{bin,rbin,m,tmp,home,config,cache,lstate,ltmux,rtmux,rhome/.local/state}
chmod 700 "$R/m" "$R/ltmux" "$R/rtmux"
cp "$MULE/target/release/mule" "$R/bin/mule"
cp "$FAKE_PI_SRC" "$R/rbin/smoke-fake-pi.mjs"
NODE=$(command -v node)
SSH_KEYGEN=$(command -v ssh-keygen)
GIT_DIR_BIN=$(dirname "$(command -v git)")
TMUX_DIR_BIN=$(dirname "$(command -v tmux)")
LSOF=$(command -v lsof)

# Our own MU_*, TMUX and PI_* only: a caller inside a mu pane carries its own.
while IFS= read -r v; do unset "$v"; done < <(env | sed -n 's/^\(MU_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(PI_[A-Za-z0-9_]*\)=.*/\1/p')
unset TMUX TMUX_PANE
export HOME="$R/home" TMPDIR="$R/tmp" XDG_CONFIG_HOME="$R/config" XDG_CACHE_HOME="$R/cache"
export XDG_STATE_HOME="$R/lstate" TMUX_TMPDIR="$R/ltmux"
export MU_DB_PATH="$R/lstate/mu-next/mu.db" MU_SYNC_DIR="" MU_TMUX_SOCKET="$MU_TMUX" MU_MUX=tmux
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@localhost
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@localhost
export PATH="$R/bin:$PATH"
mkdir -p "$R/lstate/mu-next"

mu() { "$NODE" "$MU/dist/cli.js" "$@"; }
mule() { "$R/bin/mule" --config "$R/mule.toml" "$@"; }
# js <expr>: evaluate <expr> over the JSON on stdin as `d`; prints strings raw.
# Exits 1 on undefined/null/false, so a missing field is never a pass.
js() {
  "$NODE" -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=(0,eval)("(d)=>("+process.argv[1]+")")(d);if(v===undefined||v===null||v===false)process.exit(1);console.log(typeof v==="string"?v:JSON.stringify(v));' "$1"
}
sql() { mu sql "$1" | js 'd.data.items'; }
# until_ok <tries> <what> <cmd...>: poll every 100ms.
until_ok() {
  local n=$1 what=$2
  shift 2
  for _ in $(seq "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  fail "timed out: $what"
}

# ── loopback sshd, MaxSessions 1 (mule SPEC.md § Reproduce the channel cap) ──
PORT=$("$NODE" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
"$SSH_KEYGEN" -q -t ed25519 -N '' -f "$R/hostkey"
"$SSH_KEYGEN" -q -t ed25519 -N '' -f "$R/id"
cp "$R/id.pub" "$R/authorized_keys"
# The "remote" user's world: private HOME, XDG_STATE_HOME (mule jobs, remote
# worktrees), TMUX_TMPDIR (mule's tmux server) and a PATH whose `pi` is the fake.
cat >"$R/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $R/hostkey
PidFile $R/sshd.pid
AuthorizedKeysFile $R/authorized_keys
MaxSessions 1
UsePAM no
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowStreamLocalForwarding yes
SetEnv HOME=$R/rhome XDG_STATE_HOME=$R/rhome/.local/state TMUX_TMPDIR=$R/rtmux PATH=$R/rbin:$TMUX_DIR_BIN:$GIT_DIR_BIN:/usr/bin:/bin:/usr/sbin:/sbin
EOF
chmod 600 "$R/hostkey" "$R/id" "$R/authorized_keys" "$R/sshd_config"
"$SSHD" -f "$R/sshd_config" -E "$R/sshd.log" || fail "sshd did not start (log: $R/sshd.log)"
until_ok 50 "sshd pid file" test -s "$R/sshd.pid"
SSHD_PID=$(cat "$R/sshd.pid")

# The fake pi, as `pi` on the remote PATH.
printf '#!/bin/sh\nexec %s %s "$@"\n' "$NODE" "$R/rbin/smoke-fake-pi.mjs" >"$R/rbin/pi"
chmod 755 "$R/rbin/pi"
# The ssh every local caller (mule, git fetch, this script) reaches it through.
cat >"$R/bin/ssh" <<EOF
#!/bin/sh
exec /usr/bin/ssh -F /dev/null -i $R/id -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \\
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p $PORT "\$@"
EOF
chmod 755 "$R/bin/ssh"
until_ok 100 "sshd answers" ssh -S none -o BatchMode=yes 127.0.0.1 true
pass "loopback sshd pid $SSHD_PID on 127.0.0.1:$PORT, MaxSessions 1"

# mule's master (as `mule`'s printed master command) and a second, default one.
ssh -MNf -S "$R/m/mule.sock" -o ControlPersist=8h -o StreamLocalBindUnlink=yes 127.0.0.1
ssh -MNf -S "$R/m/default.sock" -o ControlPersist=8h 127.0.0.1
master_pid() { ssh -S "$1" -O check 127.0.0.1 2>&1 | sed -n 's/.*pid=\([0-9]*\).*/\1/p'; }
MULE_MASTER=$(master_pid "$R/m/mule.sock")
DEFAULT_MASTER=$(master_pid "$R/m/default.sock")
[ -n "$MULE_MASTER" ] && [ -n "$DEFAULT_MASTER" ] && [ "$MULE_MASTER" != "$DEFAULT_MASTER" ] ||
  fail "two masters (mule=$MULE_MASTER default=$DEFAULT_MASTER)"
pass "mule master pid $MULE_MASTER, default master pid $DEFAULT_MASTER"
# Only through the default master: no new master, and no fallback connection.
via_default() { ssh -S "$R/m/default.sock" -o BatchMode=yes -o ControlMaster=no -o ProxyCommand=/usr/bin/false 127.0.0.1 "$@"; }

# The cap is real: while a session holds the default master, a second is refused.
via_default 'sleep 3' &
held=$!
sleep 1
if via_default true 2>"$R/refused.err"; then fail "MaxSessions 1 is not in effect"; fi
wait "$held"
pass "cap reproduced: a second session on a held master is refused ($(head -n 1 "$R/refused.err"))"

cat >"$R/mule.toml" <<EOF
[hosts.loop]
target = "127.0.0.1"
socket = "$R/m/mule.sock"
tmux_socket = "$MULE_TMUX"
EOF

# ── remote repo and mu profile ───────────────────────────────────────────────
RREPO="$R/rhome/repo"
git init -q "$RREPO"
git -C "$RREPO" commit -q --allow-empty -m "smoke base"
BASE=$(git -C "$RREPO" rev-parse HEAD)

M="$R/bin/mule --config $R/mule.toml"
mu workstream init "$WS" >/dev/null
mu host add loop --transport lease \
  --shell "$M run --host loop --lease --human --cwd {cwd} --job-file {job_file} --forward-unix {local_sock}:{remote_sock} -- env {env} sh -c {cmd}" \
  --exec "$M exec --host loop -- sh -c {cmd}" \
  --stop "$M rm --host loop {job}" \
  --fetch "git fetch ssh://127.0.0.1{cwd} HEAD" \
  --max-sessions 1 >/dev/null
mu host show loop --json | js 'd.data.host.transport' | grep -qx lease ||
  fail "host show loop: transport is not lease"
pass "lease profile 'loop' (mule starter adapted to the loopback host, --max-sessions 1)"
mu host check loop --root "$RREPO" --json >"$R/check.json" || {
  cat "$R/check.json"
  fail "mu host check loop"
}
pass "mu host check loop: $(js 'd.data.steps.map((s)=>s.step+"="+s.ok).join(" ")' <"$R/check.json")"

AGENT=worker-1
# mu's derived paths (src/ctl/path.ts): both well under the 103-byte hash bound.
JOB_FILE="$R/lstate/mu-next/carrier/$WS/$AGENT.job"
LOCAL_SOCK="$R/lstate/mu-next/sock/$WS/$AGENT.sock"
REMOTE_SOCK="$RSOCK_DIR/$AGENT.sock"
WT="$R/rhome/.local/state/mu-next/remote-worktrees/$WS/$AGENT"

job_row() { sql "SELECT job FROM carrier_jobs WHERE workstream='$WS' AND name='$AGENT'" | js 'd[0]?.job'; }
reservations() { sql "SELECT count(*) AS n FROM carrier_jobs WHERE workstream='$WS' AND name='$AGENT'" | js 'd[0].n'; }
agent_rows() { sql "SELECT count(*) AS n FROM agents a JOIN workstreams w ON w.id=a.workstream_id WHERE w.name='$WS' AND a.name='$AGENT'" | js 'd[0].n'; }
channels() { sql "SELECT count(*) AS n FROM host_channels WHERE host='loop'" | js 'd[0].n'; }
# A job's state in `mule ls` ("absent" once rm removed it). An unreachable host
# is never "absent": it fails the run.
job_state() {
  local out
  out=$(mule ls --host loop --all --json 2>/dev/null) || fail "mule ls --host loop failed"
  printf '%s' "$out" | js 'd.unreachable.length === 0' >/dev/null || fail "mule ls: loop unreachable: $out"
  printf '%s' "$out" | js "(d.items.find((j)=>j.id==='$1')||{}).state ?? 'absent'"
}
# No `grep -q` after a pipe: under pipefail an early exit's SIGPIPE reads as "no".
forward_held() { "$LSOF" -a -p "$MULE_MASTER" -U -Fn 2>/dev/null | grep -xF "n$LOCAL_SOCK" >/dev/null; }
carrier_pid() {
  local p
  for p in $(pgrep -f -- "--job-file $JOB_FILE" || true); do
    case "$(ps -o comm= -p "$p" 2>/dev/null)" in */mule | mule) echo "$p" && return 0 ;; esac
  done
  return 1
}

spawn() {
  mu agent spawn "$AGENT" -w "$WS" --host loop --worktree --root "$RREPO" --json >"$R/spawn.json" || {
    cat "$R/spawn.json"
    TMUX_TMPDIR="$R/ltmux" tmux -L "$MU_TMUX" capture-pane -p -t "mu-$WS" 2>/dev/null | tail -n 20
    fail "mu agent spawn $AGENT"
  }
  JOB=$(job_row) || fail "no carrier_jobs handle for $WS/$AGENT after spawn"
  [[ "$JOB" =~ ^[0-9a-f]{6}$ ]] || fail "job handle '$JOB' is not a mule id"
  [ "$(cat "$JOB_FILE")" = "$JOB" ] || fail "job file $JOB_FILE does not name $JOB"
  [ "$(job_state "$JOB")" = running ] || fail "mule ls: job $JOB is $(job_state "$JOB"), not running"
  [ "$(channels)" = 0 ] || fail "a lease pane holds a host_channels row"
  [ -S "$LOCAL_SOCK" ] || fail "no local ctl socket $LOCAL_SOCK"
  forward_held || fail "the ctl forward $LOCAL_SOCK is not bound by mule's master (pid $MULE_MASTER)"
  [ -d "$WT" ] || fail "no remote worktree $WT"
  local ctl
  ctl=$(js 'd.data.ctl ?? d.data.agent?.ctl ?? "?"' <"$R/spawn.json")
  [ "$ctl" = ok ] || fail "spawn ctl handshake: $ctl"
  pass "spawn $AGENT: job $JOB running, handle in carrier_jobs and $JOB_FILE, 0 host channels, ctl ok through the forward bound by master $MULE_MASTER, worktree at base"
}

close_clean() {
  local what=$1 rev
  rev=$(mu agent close "$AGENT" -w "$WS" --json | js 'd.data.revision') || fail "close preview ($what)"
  mu agent close "$AGENT" -w "$WS" --if "$rev" --json >"$R/close.json" || {
    cat "$R/close.json"
    fail "mu agent close $AGENT --if $rev ($what)"
  }
  local leftovers=()
  [ "$(job_state "$JOB")" = absent ] || leftovers+=("job $JOB is $(job_state "$JOB") in mule ls")
  ! forward_held || leftovers+=("forward $LOCAL_SOCK still bound by master $MULE_MASTER")
  [ ! -e "$LOCAL_SOCK" ] || leftovers+=("local socket $LOCAL_SOCK")
  [ ! -e "$JOB_FILE" ] || leftovers+=("job file $JOB_FILE")
  [ ! -e "$WT" ] || leftovers+=("remote worktree $WT")
  if git -C "$RREPO" worktree list --porcelain | grep -F "$WT" >/dev/null; then leftovers+=("git worktree entry $WT"); fi
  [ "$(reservations)" = 0 ] || leftovers+=("carrier_jobs row")
  [ "$(agent_rows)" = 0 ] || leftovers+=("agents row")
  [ "$(channels)" = 0 ] || leftovers+=("host_channels row")
  if [ ${#leftovers[@]} -gt 0 ]; then
    printf '  left: %s\n' "${leftovers[@]}"
    fail "close ($what) left state behind"
  fi
  # The fake pi unlinks its socket once mule rm's SIGHUP reaches it.
  until_ok 30 "remote socket $REMOTE_SOCK removed" test ! -e "$REMOTE_SOCK"
  pass "close ($what): no job, no forward, no socket, no job file, no worktree, no carrier_jobs row, no agent row"
}

# ── 1. spawn, and the default master stays usable ────────────────────────────
say "1. spawn $AGENT on the lease profile"
spawn
for i in 1 2 3 4 5; do
  via_default true || fail "ssh -S <default master> 127.0.0.1 true (#$i) failed while the worker runs"
  sleep 0.3
done
pass "ssh -S $R/m/default.sock 127.0.0.1 true: 5/5 succeeded while the worker runs"
# A lease pane holds no host channel: at --max-sessions 1, collect still runs.
git init -q "$R/local"
(cd "$R/local" && mu agent collect "$AGENT" -w "$WS" --json >"$R/collect.json") || {
  cat "$R/collect.json"
  fail "mu agent collect at --max-sessions 1 while the worker runs"
}
[ "$(sql "SELECT collected_head AS h FROM agents WHERE name='$AGENT'" | js 'd[0].h')" = "$BASE" ] ||
  fail "collect did not record $BASE"
pass "mu agent collect at --max-sessions 1 while the worker runs: collected_head $BASE"

# ── 2. send + wait: the settled echo ─────────────────────────────────────────
say "2. send + wait"
TEXT="smoke-ping-$$-$RANDOM"
mu agent send "$AGENT" -w "$WS" "$TEXT" --json >"$R/send.json" || {
  cat "$R/send.json"
  fail "mu agent send"
}
RUNS=$(js 'd.data.runs ?? d.data.sent?.runs' <"$R/send.json") || fail "send printed no runs"
INC=$(js 'd.data.incarnation ?? d.data.sent?.incarnation' <"$R/send.json") || fail "send printed no incarnation"
mu agent wait "$AGENT" -w "$WS" --after-runs "$RUNS" --inc "$INC" --timeout 30 --json >"$R/wait.json" || {
  cat "$R/wait.json"
  fail "mu agent wait"
}
GOT=$(js 'd.data.agents?.[0]?.lastText ?? d.data.snapshots?.[0]?.lastText' <"$R/wait.json") || {
  cat "$R/wait.json"
  fail "wait printed no lastText"
}
[ "$GOT" = "smoke-echo: $TEXT" ] || fail "lastText '$GOT' is not the echo of '$TEXT'"
pass "send runs=$RUNS inc=$INC; wait --after-runs $RUNS settled with lastText '$GOT'"

# ── 3. close leaves nothing ──────────────────────────────────────────────────
say "3. close $AGENT"
close_clean "live agent"

# ── 4. kill -9 the carrier, reconcile reaps, close by name stops the job ─────
say "4. respawn $AGENT, kill -9 its carrier"
spawn
CPID=$(carrier_pid) || fail "no carrier process for $JOB_FILE"
kill -9 "$CPID"
until_ok 100 "carrier $CPID to die" sh -c "! kill -0 $CPID 2>/dev/null"
[ "$(job_state "$JOB")" = running ] || fail "after kill -9 the job is $(job_state "$JOB"), expected it to survive"
pass "kill -9 carrier pid $CPID: job $JOB still running (SIGKILL cannot stop it)"
# Reconcile (`mu agent list` runs it) prunes a row whose pane is gone.
reaped() { mu agent list -w "$WS" >/dev/null && [ "$(agent_rows)" = 0 ]; }
until_ok 50 "reconcile to reap $AGENT" reaped
[ "$(job_row)" = "$JOB" ] || fail "reconcile lost the carrier_jobs handle"
pass "reconcile (mu agent list) reaped the agent row; carrier_jobs still names $JOB"
PREVIEW=$(mu agent close "$AGENT" -w "$WS" --json) || fail "close-by-name preview"
KIND=$(printf '%s' "$PREVIEW" | js 'd.data.kind')
REV=$(printf '%s' "$PREVIEW" | js 'd.data.revision')
mu agent close "$AGENT" -w "$WS" --if "$REV" --json >"$R/close.json" || {
  cat "$R/close.json"
  fail "close by name --if $REV"
}
[ "$(job_state "$JOB")" = absent ] || fail "close by name: job $JOB is $(job_state "$JOB")"
[ "$(reservations)" = 0 ] || fail "close by name kept the carrier_jobs row"
[ ! -e "$WT" ] || fail "close by name kept the remote worktree"
[ ! -e "$JOB_FILE" ] || fail "close by name kept the job file"
[ ! -e "$LOCAL_SOCK" ] || fail "close by name kept the local socket file"
until_ok 30 "remote socket $REMOTE_SOCK removed" test ! -e "$REMOTE_SOCK"
pass "close by name (preview kind $KIND): job $JOB stopped, carrier_jobs row, worktree, job file and socket gone"
if forward_held; then
  say "note: the SIGKILLed carrier's forward is still in master $MULE_MASTER (mule spec: the next forward replaces it)"
fi

# ── 5. the name respawns over the stale forward; its close is clean ──────────
say "5. respawn $AGENT over the SIGKILLed carrier's forward"
spawn
TEXT="smoke-again-$$-$RANDOM"
mu agent send "$AGENT" -w "$WS" "$TEXT" --wait --json >"$R/sendwait.json" || {
  cat "$R/sendwait.json"
  fail "mu agent send --wait"
}
GOT=$(js 'd.data.snapshots?.[0]?.lastText' <"$R/sendwait.json") || fail "send --wait printed no lastText"
[ "$GOT" = "smoke-echo: $TEXT" ] || fail "send --wait lastText '$GOT' is not the echo of '$TEXT'"
pass "send --wait through the re-bound forward: lastText '$GOT'"
close_clean "respawned agent"

# Nothing of the carriers outlives them: no lease, no detached `mule rm`.
until_ok 100 "every mule process of this run to exit" sh -c "! pgrep -f '$R/bin/mule' >/dev/null"
LS=$(mule ls --host loop --all --json)
[ "$(printf '%s' "$LS" | js 'd.items.length + d.unreachable.length')" = 0 ] || fail "mule ls: $LS"
pass "no mule process left, mule ls empty"
