#!/usr/bin/env bash
# Operator smoke for the lease transport (docs/specs/2026-10-28-lease-transport.md
# § Testing, Smoke). Explicitly invoked, never picked up by vitest:
#
#   MU=/path/to/mu MULE=/path/to/mule bash scripts/smoke-lease.sh [--plugin mule]
#
# Without an argument it drives the lease TEMPLATE profile (cases 1-5 below).
# With `--plugin mule` it drives the D15 plugin instead: the same sshd, the
# built `mule` and `mu-plugin-mule`, and these cases (P1-P4, then 1-5 through
# the plugin's lease job kind, with 4's kill -9 of the carrier included):
#   P1. `mule init` registers the plugin with mu (idempotent on a rerun) and
#       `mu host add --plugin mule` selects it
#   P2. rung 1, `mu host exec` through the mule link: a command's exit passes
#       through, a command's own 3 reads 8 (never mule's handback 3), a command's
#       own 5 is told from a transport 5 by `--json`; no master is a hand-back
#       (exit 5, the command did not run) and the next call works once it returns
#   P3. rung 4 master loss: the master dies under a running worker: a send fails
#       as unreachable and is not resent, the remote job and its row survive,
#       `mu agent collect` still works over the separate fetch connection, a
#       close hands back (row and handle kept, job alive), and with the master
#       back the forward returns, a send works, and a fresh close stops the job
#       and the collect is real: a unique commit made in the remote worker tree
#       after the first collect is absent locally, then arrives (changed=true, in the
#       object DB, in refs/mu/collect/<ws>/<agent>, in collected_head) during the loss
#   P4. after EVERY clean close (and again at the end): no stale forward, remote job,
#       tmux session, socket, job file, or row in carrier_jobs, agents, host_channels,
#       effects or remote_recovery. The one exception, mule's documented stale
#       listener after a SIGKILLed carrier, is named and only allowed there
#
# It builds mule (cargo build --release) and mu (npm run build), starts a
# loopback `sshd MaxSessions 1` (mule SPEC.md § Reproduce the channel cap
# locally) as the only "remote", opens mule's master and a second "default"
# master, and drives the built mule from a mu lease profile against a
# ctl-speaking fake pi (scripts/smoke-fake-pi.mjs). It asserts the spec's smoke
# list:
#   1. spawn: a job handle, no host channel, the ctl forward bound by the master;
#      `ssh -S <default master> host true` succeeds while the worker runs
#   2. send + wait (and send --wait): a ctl-settled run (snapshot settled:true,
#      only for a reply that ended "settled") whose lastText echoes the sent text
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
# The remote pi is, by default, scripts/smoke-ext-pi.mjs: it loads the REAL built
# mu ctl extension (dist/extension/mu-pi.js) against a recording pi API, so the
# extension's registration, ctl server and settle path serve every ctl call and a send
# is one deterministic tool turn (no model). SMOKE_FAKE_PI=1 selects the old ctl-only
# stand-in (scripts/smoke-fake-pi.mjs). A last leg runs the built extension in a REAL
# pi (no model call: hello/status over its ctl socket) when REAL_PI_BIN names one or
# `pi` is on PATH; REAL_PI_BIN set to something unusable FAILS; with no pi it prints
# "SKIPPED: no pi binary on host" (it does not count as a pass of that leg).
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
PLUGIN_MODE=0
case "${1:-}" in
  "") ;;
  --plugin)
    [ "${2:-}" = mule ] || {
      echo "usage: smoke-lease.sh [--plugin mule]" >&2
      exit 2
    }
    PLUGIN_MODE=1
    ;;
  *)
    echo "usage: smoke-lease.sh [--plugin mule]" >&2
    exit 2
    ;;
esac

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
for c in ssh ssh-keygen tmux node npm cargo git git-upload-pack lsof; do need_cmd "$c"; done
[ -x "$SSHD" ] || missing+=("sshd at $SSHD")
[ -n "$MULE" ] || missing+=("MULE (path to the mule checkout) is not set")
[ -z "$MULE" ] || [ -f "$MULE/Cargo.toml" ] || missing+=("mule checkout at $MULE (no Cargo.toml)")
[ -f "$MU/package.json" ] || missing+=("mu checkout at $MU (no package.json)")
[ -d "$MU/node_modules" ] || missing+=("$MU/node_modules (run npm install there)")
[ -f "$FAKE_PI_SRC" ] || missing+=("$FAKE_PI_SRC")
[ -f "$SCRIPTS/smoke-ext-pi.mjs" ] || missing+=("$SCRIPTS/smoke-ext-pi.mjs")
if [ ${#missing[@]} -gt 0 ]; then
  for m in "${missing[@]}"; do echo "smoke-lease: PREREQUISITE MISSING: $m" >&2; done
  echo "smoke-lease: FAIL (prerequisites missing; this is not a pass)" >&2
  exit 2
fi
# The real pi leg: found before the PATH below is narrowed.
REAL_PI=""
if [ -n "${REAL_PI_BIN:-}" ]; then
  [ -x "$REAL_PI_BIN" ] || {
    echo "smoke-lease: FAIL (REAL_PI_BIN=$REAL_PI_BIN is not an executable; unset it to skip the real pi leg)" >&2
    exit 2
  }
  REAL_PI=$REAL_PI_BIN
elif command -v pi >/dev/null 2>&1; then
  REAL_PI=$(command -v pi)
fi
MU=$(cd "$MU" && pwd -P)
MULE=$(cd "$MULE" && pwd -P)

# ── build ────────────────────────────────────────────────────────────────────
say "build mule: cargo build --release in $MULE"
(cd "$MULE" && cargo build --release --quiet) || fail "cargo build --release"
say "build mu: npm run build in $MU"
(cd "$MU" && npm run build --silent >/dev/null) || fail "npm run build"
[ -x "$MULE/target/release/mule" ] || fail "no mule binary after the build"
[ "$PLUGIN_MODE" = 0 ] || [ -x "$MULE/target/release/mu-plugin-mule" ] || fail "no mu-plugin-mule binary after the build"
[ -f "$MU/dist/cli.js" ] || fail "no mu dist/cli.js after the build"
[ -f "$MU/dist/extension/mu-pi.js" ] || fail "no mu dist/extension/mu-pi.js (the ctl extension) after the build"
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
if [ "$PLUGIN_MODE" = 1 ]; then
  # Both binaries together, mode 0755, user-owned: what `mule init` registers.
  cp "$MULE/target/release/mu-plugin-mule" "$R/bin/mu-plugin-mule"
  chmod 755 "$R/bin/mule" "$R/bin/mu-plugin-mule"
fi
cp "$FAKE_PI_SRC" "$R/rbin/smoke-fake-pi.mjs"
cp "$SCRIPTS/smoke-ext-pi.mjs" "$R/rbin/smoke-ext-pi.mjs"
# The node binary itself, not a version manager's shim: a shim (mise, asdf) resolves through
# $HOME, which is private below, and then fails ("node is not a valid shim", seen on Linux).
NODE=$(node -e 'console.log(process.execPath)')
SSH_KEYGEN=$(command -v ssh-keygen)
# Expose the tools, not their parent bin directories: those can also contain
# real harnesses which host check would discover without their hook configs.
for c in tmux git git-upload-pack; do
  ln -s "$(command -v "$c")" "$R/rbin/$c"
done
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
# `mule init` finds mu on PATH: a private launcher for this build, never a real install.
printf '#!/bin/sh\nexec %s %s "$@"\n' "$NODE" "$MU/dist/cli.js" >"$R/bin/mu"
chmod 755 "$R/bin/mu"
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
SetEnv HOME=$R/rhome XDG_STATE_HOME=$R/rhome/.local/state TMUX_TMPDIR=$R/rtmux PATH=$R/rbin:/usr/bin:/bin:/usr/sbin:/sbin
EOF
chmod 600 "$R/hostkey" "$R/id" "$R/authorized_keys" "$R/sshd_config"
"$SSHD" -f "$R/sshd_config" -E "$R/sshd.log" || fail "sshd did not start (log: $R/sshd.log)"
until_ok 50 "sshd pid file" test -s "$R/sshd.pid"
SSHD_PID=$(cat "$R/sshd.pid")

# The stand-in pi, as `pi` on the remote PATH: the real built ctl extension in a
# recording pi API (default), or the ctl-only fake (SMOKE_FAKE_PI=1).
if [ "${SMOKE_FAKE_PI:-}" = 1 ]; then
  printf '#!/bin/sh\nexec %s %s "$@"\n' "$NODE" "$R/rbin/smoke-fake-pi.mjs" >"$R/rbin/pi"
else
  printf '#!/bin/sh\nSMOKE_EXT=%s exec %s %s "$@"\n' "$MU/dist/extension/mu-pi.js" "$NODE" "$R/rbin/smoke-ext-pi.mjs" >"$R/rbin/pi"
fi
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

# ── fixture repos and mu profile ─────────────────────────────────────────────
RREPO="$R/rhome/repo"
LREPO="$R/local"
git init -q "$RREPO"
git -C "$RREPO" commit -q --allow-empty -m "smoke base"
BASE=$(git -C "$RREPO" rev-parse HEAD)
# Static-host spawn resolves --from HEAD in the local checkout, not at --root.
git clone -q "$RREPO" "$LREPO"

M="$R/bin/mule --config $R/mule.toml"
mu workstream init "$WS" >/dev/null
FETCH="git fetch ssh://127.0.0.1{cwd} HEAD"
if [ "$PLUGIN_MODE" = 1 ]; then
  say "P1. mule init registers the plugin; mu host add --plugin mule selects it"
  mule init --quiet >"$R/init.out" 2>"$R/init.err" || {
    cat "$R/init.out" "$R/init.err"
    fail "mule init"
  }
  grep -q '^registered mule with mu$' "$R/init.out" || {
    cat "$R/init.out"
    fail "mule init did not register the plugin"
  }
  mu plugin list --json | js "d.data.items.some((p)=>p.name==='mule'&&p.argv[0]==='$R/bin/mu-plugin-mule'&&p.argv.includes('$R/mule.toml'))" >/dev/null ||
    fail "mu plugin list does not name mule at $R/bin/mu-plugin-mule with --config $R/mule.toml"
  mule init --quiet >"$R/init2.out" 2>&1 || fail "mule init rerun"
  ! grep -q registered "$R/init2.out" || fail "a rerun of mule init registered again: $(cat "$R/init2.out")"
  pass "mule init: plugin 'mule' registered with argv [$R/bin/mu-plugin-mule --config $R/mule.toml]; a rerun leaves it alone"
  mu host add loop --plugin mule --fetch "$FETCH" --max-sessions 1 >/dev/null || fail "mu host add loop --plugin mule"
  mu host show loop --json | js "d.data.host.plugin === 'mule' && d.data.host.shell == null" >/dev/null ||
    fail "host show loop: not a --plugin mule profile"
  pass "mu host add loop --plugin mule: the plugin is the link (no shell or exec template)"
else
  mu host add loop --transport lease \
    --shell "$M run --host loop --lease --human --cwd {cwd} --job-file {job_file} --forward-unix {local_sock}:{remote_sock} -- env {env} sh -c {cmd}" \
    --exec "$M exec --host loop -- sh -c {cmd}" \
    --stop "$M rm --host loop {job}" \
    --fetch "$FETCH" \
    --max-sessions 1 >/dev/null
  mu host show loop --json | js 'd.data.host.transport' | grep -qx lease ||
    fail "host show loop: transport is not lease"
  pass "lease profile 'loop' (mule starter adapted to the loopback host, --max-sessions 1)"
fi
mu host check loop --root "$RREPO" --json >"$R/check.json" || {
  cat "$R/check.json"
  fail "mu host check loop"
}
pass "mu host check loop: $(js 'd.data.steps.map((s)=>s.step+"="+s.ok).join(" ")' <"$R/check.json")"

reopen_master() {
  ssh -MNf -S "$R/m/mule.sock" -o ControlPersist=8h -o StreamLocalBindUnlink=yes 127.0.0.1 || fail "reopening mule's master"
  MULE_MASTER=$(master_pid "$R/m/mule.sock")
  [ -n "$MULE_MASTER" ] || fail "no mule master pid after reopening"
}
lose_master() {
  ssh -S "$R/m/mule.sock" -O exit 127.0.0.1 >/dev/null 2>&1 || fail "ssh -O exit on mule's master"
  until_ok 50 "mule's master socket to go" test ! -S "$R/m/mule.sock"
}
# The "remote" is this host: its mule tmux server is the ground truth for jobs, master or no master.
remote_sessions() { TMUX_TMPDIR="$R/rtmux" tmux -L "$MULE_TMUX" list-sessions 2>/dev/null | wc -l | tr -d ' '; }
# hx <cmd...>: `mu host exec loop --json`; HX_RC is its exit, the document is $R/hx.json.
hx() {
  HX_RC=0
  mu host exec loop --json -- "$@" >"$R/hx.json" 2>"$R/hx.err" || HX_RC=$?
}
hx_expect() {
  local what=$1 rc=$2 expr=$3
  [ "$HX_RC" = "$rc" ] || {
    cat "$R/hx.json" "$R/hx.err"
    fail "host exec ($what): exit $HX_RC, expected $rc"
  }
  js "$expr" <"$R/hx.json" >/dev/null || {
    cat "$R/hx.json"
    fail "host exec ($what): document does not match $expr"
  }
}

if [ "$PLUGIN_MODE" = 1 ]; then
  say "P2. rung 1: mu host exec through the mule link"
  hx sh -c 'echo out; echo err >&2'
  hx_expect "success" 0 "d.data.exit === 0 && d.data.stdout.trim() === 'out' && d.data.stderr.trim() === 'err'"
  hx sh -c 'exit 7'
  hx_expect "command exit 7" 7 "d.data.exit === 7"
  hx sh -c 'exit 3'
  hx_expect "command's own exit 3" 8 "d.data.exit === 8"
  hx sh -c 'exit 5'
  hx_expect "command's own exit 5" 5 "d.data.exit === 5 && d.data.stdout !== undefined"
  pass "exec: 0 -> 0, 7 -> 7, a command's own 3 reads 8 (never mule's handback 3), its own 5 is a result document (exit 5 with data.exit 5)"
  lose_master
  rm -f "$R/ran"
  hx sh -c "touch $R/ran"
  [ "$HX_RC" = 5 ] || {
    cat "$R/hx.json" "$R/hx.err"
    fail "host exec without a master: exit $HX_RC, expected the hand-back 5"
  }
  js 'd.data?.exit === undefined' <"$R/hx.json" >/dev/null || {
    cat "$R/hx.json"
    fail "a hand-back printed a result document (it must not look like a command's exit 5)"
  }
  [ ! -e "$R/ran" ] || fail "the command ran without a master"
  pass "exec without a master: hand-back (exit 5, no result document, the command did not run): $(js 'd.error?.message ?? d.error' <"$R/hx.json" | head -n 1 | cut -c1-100)"
  reopen_master
  hx sh -c "touch $R/ran"
  hx_expect "after the master returned" 0 "d.data.exit === 0"
  [ -e "$R/ran" ] || fail "the command did not run once the master returned"
  pass "exec with the master back: runs (master pid $MULE_MASTER)"
fi

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
# lsof's name field is the bare path on macOS but "<path> type=STREAM" on Linux (lsof 4.99).
forward_held() {
  "$LSOF" -a -p "$MULE_MASTER" -U -Fn 2>/dev/null |
    awk -v want="n$LOCAL_SOCK" '$0 == want || index($0, want " ") == 1 { f = 1 } END { exit !f }'
}
carrier_pid() {
  local p
  for p in $(pgrep -f -- "--job-file $JOB_FILE" || true); do
    case "$(ps -o comm= -p "$p" 2>/dev/null)" in */mule | mule) echo "$p" && return 0 ;; esac
  done
  return 1
}

spawn() {
  (cd "$LREPO" && mu agent spawn "$AGENT" -w "$WS" --host loop --worktree --root "$RREPO" --json) >"$R/spawn.json" || {
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
  if [ "${SMOKE_FAKE_PI:-}" != 1 ]; then
    # The built extension registered itself in the pi it was loaded into (not the fake's own ctl server).
    until_ok 50 "the extension's registration record" test -s "$REG"
    js "['session_start','agent_settled','agent_end','tool_execution_start'].every((e)=>d.events.includes(e)) && d.commands.includes('mu-fresh')" <"$REG" >/dev/null ||
      fail "the built ctl extension did not register its handlers/commands: $(cat "$REG")"
  fi
  pass "spawn $AGENT: job $JOB running, handle in carrier_jobs and $JOB_FILE, 0 host channels, ctl ok through the forward bound by master $MULE_MASTER, worktree at base"
}

REG="$R/rhome/smoke-ext-registration.json"
# stale_check [allow-forward]: fill STALE with whatever a finished close left behind;
# the forward is exempt only when asked (mule's documented SIGKILL exception).
STALE=()
stale_check() {
  STALE=()
  [ "$(job_state "$JOB")" = absent ] || STALE+=("job $JOB is $(job_state "$JOB") in mule ls")
  if [ "${1:-}" != allow-forward ]; then
    ! forward_held || STALE+=("forward $LOCAL_SOCK still bound by master $MULE_MASTER")
  fi
  [ ! -e "$LOCAL_SOCK" ] || STALE+=("local socket $LOCAL_SOCK")
  [ ! -e "$JOB_FILE" ] || STALE+=("job file $JOB_FILE")
  [ ! -e "$WT" ] || STALE+=("remote worktree $WT")
  if git -C "$RREPO" worktree list --porcelain | grep -F "$WT" >/dev/null; then STALE+=("git worktree entry $WT"); fi
  [ "$(remote_sessions)" = 0 ] || STALE+=("$(remote_sessions) remote tmux session(s)")
  local t n
  for t in carrier_jobs agents host_channels effects remote_recovery; do
    n=$(sql "SELECT count(*) AS n FROM $t" | js 'd[0].n') || fail "counting $t"
    [ "$n" = 0 ] || STALE+=("$n $t row(s)")
  done
}

close_clean() {
  local what=$1 rev
  rev=$(mu agent close "$AGENT" -w "$WS" --json | js 'd.data.revision') || fail "close preview ($what)"
  mu agent close "$AGENT" -w "$WS" --if "$rev" --json >"$R/close.json" || {
    cat "$R/close.json"
    fail "mu agent close $AGENT --if $rev ($what)"
  }
  # A clean close allows no exception: not even the stale forward.
  stale_check
  if [ ${#STALE[@]} -gt 0 ]; then
    printf '  left: %s\n' "${STALE[@]}"
    fail "close ($what) left state behind"
  fi
  # The fake pi unlinks its socket once mule rm's SIGHUP reaches it.
  until_ok 30 "remote socket $REMOTE_SOCK removed" test ! -e "$REMOTE_SOCK"
  pass "close ($what): no job, no forward, no socket, no job file, no worktree, no remote tmux session, no row in carrier_jobs/agents/host_channels/effects/remote_recovery"
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
(cd "$LREPO" && mu agent collect "$AGENT" -w "$WS" --json) >"$R/collect.json" || {
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
# `mu agent wait` also fires on a reply that never said `ended: "settled"`
# (an older extension), and its `outcome` comes from lastText alone. `mu wait`
# returns the same run at once (it settled past $RUNS), and its snapshot's
# `settled` is true only for a ctl reply that ended settled.
mu wait "agent:$WS/$AGENT@$RUNS#$INC" --timeout 10 --json >"$R/settled.json" || {
  cat "$R/settled.json"
  fail "mu wait agent:$WS/$AGENT@$RUNS#$INC"
}
settled_run() {
  js "d.data.firing?.kind === 'settled' && d.data.snapshots?.[0]?.settled === true && d.data.snapshots[0].runs === $2 && d.data.snapshots[0].lastText === '$3'" <"$1" >/dev/null || {
    cat "$1"
    fail "$4: not ctl-settled run $2 with lastText '$3' (firing.kind settled, snapshots[0].settled true)"
  }
}
settled_run "$R/settled.json" "$((RUNS + 1))" "$GOT" "mu wait after mu agent wait"
pass "send runs=$RUNS inc=$INC; wait --after-runs $RUNS: lastText '$GOT', ctl-settled run $((RUNS + 1))"

# ── 3. close leaves nothing ──────────────────────────────────────────────────
if [ "$PLUGIN_MODE" = 1 ]; then
  say "P3. master loss under a running worker, then recovery"
  RUNS_NOW=$((RUNS + 1))
  # A commit that exists only in the worker's tree: the collect below must carry exactly it.
  git -C "$WT" commit -q --allow-empty -m "smoke collect oracle $$-$RANDOM"
  NEWC=$(git -C "$WT" rev-parse HEAD)
  [ "$NEWC" != "$BASE" ] || fail "the worker-tree commit did not move HEAD"
  ! git -C "$LREPO" cat-file -e "$NEWC^{commit}" 2>/dev/null || fail "commit $NEWC is already in the local repo"
  lose_master
  [ "$(remote_sessions)" -ge 1 ] || fail "the remote job is gone after the master died"
  [ -S "$REMOTE_SOCK" ] || fail "the remote ctl socket $REMOTE_SOCK is gone after the master died"
  LOSS_RC=0
  mu agent send "$AGENT" -w "$WS" "lost-$$" --json >"$R/lost-send.json" 2>&1 || LOSS_RC=$?
  [ "$LOSS_RC" != 0 ] || fail "a send with no master reported success"
  pass "master lost: the remote job and its ctl socket live; a send fails as unreachable (exit $LOSS_RC)"
  (cd "$LREPO" && mu agent collect "$AGENT" -w "$WS" --json) >"$R/collect2.json" 2>&1 || {
    cat "$R/collect2.json"
    fail "mu agent collect with no master (the separate fetch connection)"
  }
  [ ! -S "$R/m/mule.sock" ] || fail "mule's master is back by itself"
  js "(d.data ?? d).changed === true && (d.data ?? d).head === '$NEWC' && (d.data ?? d).ref === 'refs/mu/collect/$WS/$AGENT'" <"$R/collect2.json" >/dev/null || {
    cat "$R/collect2.json"
    fail "collect during master loss did not report changed=true at $NEWC"
  }
  git -C "$LREPO" cat-file -e "$NEWC^{commit}" || fail "commit $NEWC is not in the local object DB after the collect"
  [ "$(git -C "$LREPO" rev-parse "refs/mu/collect/$WS/$AGENT")" = "$NEWC" ] || fail "refs/mu/collect/$WS/$AGENT is not $NEWC"
  [ "$(sql "SELECT collected_head AS h FROM agents WHERE name='$AGENT'" | js 'd[0].h')" = "$NEWC" ] || fail "collected_head is not $NEWC"
  pass "mu agent collect with mule's master down: changed=true, the new commit ${NEWC:0:12} (absent before) is in the local repo, refs/mu/collect/$WS/$AGENT and collected_head"
  [ "$(reservations)" = 1 ] && [ "$(job_row)" = "$JOB" ] || fail "master loss lost the carrier_jobs handle"
  reopen_master
  until_ok 300 "the ctl forward to return with the master" forward_held
  [ "$(job_state "$JOB")" = running ] || fail "after the master returned the job is $(job_state "$JOB")"
  mu agent send "$AGENT" -w "$WS" "back-$$" --wait --json >"$R/back.json" || {
    cat "$R/back.json"
    fail "mu agent send --wait after the master returned"
  }
  [ "$(js 'd.data.sent.runs' <"$R/back.json")" = "$RUNS_NOW" ] ||
    fail "the send lost during the master loss was resent (runs $(js 'd.data.sent.runs' <"$R/back.json"), expected $RUNS_NOW)"
  [ "$(js 'd.data.snapshots[0].lastText' <"$R/back.json")" = "smoke-echo: back-$$" ] || fail "the recovered send is not echoed"
  pass "master back (pid $MULE_MASTER): forward re-bound, job $JOB running, send settled as run $((RUNS_NOW + 1)); the lost send was not resent"
  lose_master
  REV=$(mu agent close "$AGENT" -w "$WS" --json | js 'd.data.revision') || fail "close preview during the loss"
  LOSS_RC=0
  mu agent close "$AGENT" -w "$WS" --if "$REV" --json >"$R/lost-close.json" 2>&1 || LOSS_RC=$?
  [ "$LOSS_RC" != 0 ] || fail "a close with no master reported success"
  [ "$(reservations)" = 1 ] && [ "$(job_row)" = "$JOB" ] || fail "a handed-back close dropped the carrier_jobs handle"
  [ "$(remote_sessions)" -ge 1 ] || fail "a handed-back close lost the remote job"
  pass "close with no master: hands back (exit $LOSS_RC), the handle stays in carrier_jobs, the remote job lives"
  reopen_master
  close_clean "after master loss"
else
  say "3. close $AGENT"
  close_clean "live agent"
fi

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
# Everything but the forward must be clean; the forward is mule's documented exception.
stale_check allow-forward
if [ ${#STALE[@]} -gt 0 ]; then
  printf '  left: %s\n' "${STALE[@]}"
  fail "close by name left state behind"
fi
until_ok 30 "remote socket $REMOTE_SOCK removed" test ! -e "$REMOTE_SOCK"
pass "close by name (preview kind $KIND): job $JOB stopped, carrier_jobs row, worktree, job file and socket gone"
STALE_LISTENER=0
if forward_held; then
  STALE_LISTENER=1
  say "KNOWN EXCEPTION (not a clean close): the SIGKILLed carrier's forward $LOCAL_SOCK is still bound by master $MULE_MASTER; mule documents it, and only the next forward of the name (step 5) or the master's exit removes it"
else
  say "the SIGKILLed carrier's forward is already gone (the documented stale listener did not occur this time)"
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
SENT_RUNS=$(js 'd.data.sent.runs' <"$R/sendwait.json") || fail "send --wait printed no sent.runs"
settled_run "$R/sendwait.json" "$((SENT_RUNS + 1))" "$GOT" "send --wait"
pass "send --wait through the re-bound forward: lastText '$GOT', ctl-settled run $((SENT_RUNS + 1))"
close_clean "respawned agent"

# Nothing of the carriers outlives them: no lease, no detached `mule rm`.
# A function, not `sh -c`: Linux pgrep -f matches its own parent shell, whose argv names
# $R/bin/mule, so the check never passed there (BSD pgrep skips ancestors by default).
no_mule_left() { ! pgrep -f "$R/bin/mule" >/dev/null; }
until_ok 100 "every mule process of this run to exit" no_mule_left
LS=$(mule ls --host loop --all --json)
[ "$(printf '%s' "$LS" | js 'd.items.length + d.unreachable.length')" = 0 ] || fail "mule ls: $LS"
pass "no mule process left, mule ls empty"

if [ "$PLUGIN_MODE" = 1 ]; then
  say "P4. nothing stale after every close"
  stale_check
  [ ! -e "$REMOTE_SOCK" ] || STALE+=("remote ctl socket $REMOTE_SOCK")
  if [ ${#STALE[@]} -gt 0 ]; then
    printf '  stale: %s\n' "${STALE[@]}"
    fail "state left after the plugin run"
  fi
  pass "no stale forward, remote job or tmux session, ctl socket, job file, or carrier_jobs/agents/host_channels/effects/remote_recovery row (every close was checked; the one documented exception, the SIGKILL listener: $([ "$STALE_LISTENER" = 1 ] && echo "occurred, replaced by the step 5 respawn" || echo "did not occur"))"
fi

# ── the built ctl extension inside a REAL pi (no model call) ─────────────────
if [ -z "$REAL_PI" ]; then
  say "SKIPPED: no pi binary on host (real pi + built mu ctl extension leg; set REAL_PI_BIN to run it)"
else
  say "real pi leg: $REAL_PI with the built ctl extension"
  RSK="$R/real.sock"
  TMUX_TMPDIR="$R/ltmux" tmux -L "$MU_TMUX" new-session -d -s realpi -x 120 -y 30 \
    "env MU_CTL_SOCK=$RSK MU_AGENT_NAME=real-pi MU_WORKSTREAM=$WS PI_OFFLINE=1 $REAL_PI -ne -e $MU/dist/extension/mu-pi.js --no-session --offline; sleep 600" ||
    fail "could not start the real pi in a private tmux session"
  real_up() { [ -S "$RSK" ]; }
  until_ok 300 "the real pi to bind $RSK (the built extension loaded)" real_up
  # One request per connection (the ctl protocol): two calls, hello then status.
  "$NODE" -e '
    const net = require("net");
    const ask = (op) => new Promise((ok, no) => {
      const c = net.connect(process.argv[1]);
      let b = "";
      c.on("data", (d) => { b += d; });
      c.on("end", () => ok(JSON.parse(b)));
      c.on("error", no);
      c.write(JSON.stringify({ v: 1, op }) + "\n");
    });
    setTimeout(() => { console.error("no reply"); process.exit(1); }, 10000);
    (async () => { console.log(JSON.stringify([await ask("hello"), await ask("status")])); process.exit(0); })().catch((e) => { console.error(String(e)); process.exit(1); });
' "$RSK" >"$R/real-ctl.json" || fail "real pi: no ctl reply on $RSK"
  js "d[0].ok === true && d[0].ops.includes('send') && d[0].ops.includes('wait') && typeof d[0].extVersion === 'string' && d[0].agent === 'real-pi' && d[1].ok === true && d[1].state === 'idle'" <"$R/real-ctl.json" >/dev/null || {
    cat "$R/real-ctl.json"
    fail "real pi: the built extension's hello/status are not as expected"
  }
  pass "real pi ($("$REAL_PI" --version 2>&1 | head -n 1)) loaded the built ctl extension $(js 'd[0].extVersion' <"$R/real-ctl.json"): hello ok (piVersion $(js 'd[0].piVersion ?? "?"' <"$R/real-ctl.json")), status idle; no model turn was run"
  TMUX_TMPDIR="$R/ltmux" tmux -L "$MU_TMUX" kill-session -t realpi >/dev/null 2>&1
  pkill -TERM -f "$RSK" >/dev/null 2>&1 || true
fi
