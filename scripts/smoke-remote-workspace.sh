#!/usr/bin/env bash
# Operator smoke for a remote workspace (docs/guide/placement.md#remote-workspace):
# a LOCAL pi loop in a local tmux pane, with its workspace and shell in a
# remote worktree through the PACKAGED @mu-crew/mule pi extension and
# `mule serve --stdio`, against ONE loopback `sshd MaxSessions 1`.
# Explicitly invoked, never picked up by vitest; Linux only (it runs sshd):
#
#   MU=/path/to/mu MULE=/path/to/mule bash scripts/smoke-remote-workspace.sh
#
# The pi is REAL pi (PI=<standalone pi executable>, else
# @earendil-works/pi-coding-agent@$PI_VERSION installed from the registry into
# the private dir) with a scripted model (scripts/smoke-remote-workspace-pi.mjs, pi-ai's
# faux provider): every tool call is a real pi tool call through the mule
# extension; no network after the install, no credentials.
#
# Cases:
#   P. package: `npm pack` @mu-crew/mule (with its pi/ extension, no tests) and
#      @mu-crew/mule-<os>-<cpu> (this mule's build) from the mule checkout,
#      install both into a scratch prefix; the extension's own `mule` is the
#      platform package's binary, byte-equal to the build; `pi install` loads
#      it; the pane's PATH has a `mule` tripwire that must never fire
#   S. `mu host add --plugin mule` + `mu agent spawn --mule`: local pane and
#      local ctl, remote worktree prepared through the link, MULE_PI_JOB_PREFIX
#      in the loop's environment, no carrier job
#   R1. a deterministic tool chain: read, write, edit, read (mule serve, one
#      child of pi, never a local file), then bash as a detached mule job keyed
#      under the worker's prefix
#   R2. a coalesced burst: 20 parallel reads in one step over MaxSessions 1,
#      every one correct, no new serve child, sshd refuses no session
#   R3. a 200 KB write over an existing 0640 file: exact bytes, mode kept
#   R4. cancel: `mu agent abort` mid-bash stops exactly that job (`mule kill`):
#      no running job, no remote process; the loop answers afterwards
#   R5. master loss mid-turn: the turn hands back, send and wait refuse
#      (exit 5) without reaping the local pane; the master returns and the next
#      turn works (the job the stopped turn left keeps running until it ends)
#   R6. collect: a commit made by the loop's bash in the remote tree arrives
#      in the local checkout at refs/mu/collect/<ws>/<agent>
#   R7. caller death: SIGKILL the loop mid-bash: its serve child exits, the
#      detached job outlives it, close stops it
#   C. after every close: no running mule job, remote process, tmux session,
#      worktree, socket, or row in agents/carrier_jobs/remote_recovery/
#      host_channels/effects; at the end nothing at all
#
# The private world is scripts/smoke-hybrid.sh's: its own dir under /tmp,
# TMPDIR, HOME, XDG_*, MU_DB_PATH, MU_SYNC_DIR= blank, npm cache and prefix,
# a private tmux server for mu and one for mule, PI_CODING_AGENT_DIR, no host
# but 127.0.0.1. Missing prerequisites FAIL (exit 2); they never count as a
# pass. The EXIT trap, also on failure, reaps the watchdog and stops the
# fixture's own processes by name (both tmux servers, mule's master, sshd); any
# process that still names the private dir in its argv or environ, or holds it
# as cwd, exe, root or an open fd, 10 s later (or after the dir's removal) is a
# leak: it fails the run, then is KILLed (Linux /proc scan). A tmux probe that
# errors or times out is a failure, never zero sessions. SMOKE_TIMEOUT seconds
# (default 1200) bound the whole run, build included: at the deadline the
# watchdog stops the foreground command and the run exits through cleanup.
# SMOKE_KEEP=1 keeps the dir.

set -euo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
MU=${MU:-$(dirname "$SCRIPTS")}
MULE=${MULE:-}
PI=${PI:-}
PI_VERSION=${PI_VERSION:-1.6.0}
SSHD=${SSHD:-/usr/sbin/sshd}
LIMIT=${SMOKE_TIMEOUT:-1200}
[ $# = 0 ] || {
  echo "usage: smoke-remote-workspace.sh (no arguments; MU, MULE, PI, PI_VERSION, SSHD, SMOKE_TIMEOUT, SMOKE_KEEP from the env)" >&2
  exit 2
}

T0=$(date +%s)
say() { printf '[%3ss] %s\n' "$(($(date +%s) - T0))" "$*"; }
pass() { say "PASS $*"; }
fail() {
  # On fd 3, the run's stdout: a check inside until_ok has its output muted.
  [ ! -e "${R:-/nonexistent}/deadline" ] || exit 143
  say "FAIL $*" >&3
  # The run's process table at the failure, for SMOKE_KEEP=1.
  [ -z "${R:-}" ] || for p in $(procs "$R/"); do "$TO" 5 ps -o pid=,ppid=,args= -p "$p"; done >"$R/ps-at-fail" 2>/dev/null
  exit 1
}

# ── prerequisites: every one is a failure, never a skip ─────────────────────
missing=()
need_cmd() { command -v "$1" >/dev/null 2>&1 || missing+=("$1 (not on PATH)"); }
for c in ssh ssh-keygen tmux node npm cargo git git-upload-pack bash tar timeout; do need_cmd "$c"; done
[ -x "$SSHD" ] || missing+=("sshd at $SSHD")
[ -d /proc/self ] || missing+=("/proc (Linux only)")
[ -n "$MULE" ] || missing+=("MULE (path to the mule checkout) is not set")
[ -z "$MULE" ] || [ -f "$MULE/Cargo.toml" ] || missing+=("mule checkout at $MULE (no Cargo.toml)")
[ -z "$MULE" ] || [ -f "$MULE/npm/mule/package.json" ] || missing+=("$MULE/npm/mule (the npm package)")
[ -f "$MU/package.json" ] || missing+=("mu checkout at $MU (no package.json)")
[ -d "$MU/node_modules" ] || missing+=("$MU/node_modules (run npm install there)")
[ -f "$SCRIPTS/smoke-remote-workspace-pi.mjs" ] || missing+=("$SCRIPTS/smoke-remote-workspace-pi.mjs")
[ -z "$PI" ] || [ -x "$PI" ] || missing+=("PI=$PI is not executable")
if [ ${#missing[@]} -gt 0 ]; then
  for m in "${missing[@]}"; do echo "smoke-remote-workspace: PREREQUISITE MISSING: $m" >&2; done
  echo "smoke-remote-workspace: FAIL (prerequisites missing; this is not a pass)" >&2
  exit 2
fi
TO=$(command -v timeout)
# ── run dir, EXIT trap and deadline (before the first node call and the build: SMOKE_TIMEOUT covers them) ─
R=$(cd "$(mktemp -d /tmp/mu-r2.XXXXXX)" && pwd -P)
# Every process of this run carries "$R/" in its environ from here on (this tag,
# or the private HOME/TMPDIR exported later; sshd's children get it through
# SetEnv): the deadline and the cleanup find a reparented build by it.
export SMOKE_RUN="$R/"
UID_=$(id -u)
WS="r2-$$"
MU_TMUX="mu-r2-$$"
MULE_TMUX="mule-r2-$$"
SSHD_PID=""
WATCHDOG=""
IN_CLEANUP=""
LEFT=""

# reap_watchdog: freeze the watchdog so it can neither fire nor fork, kill its
# children, kill it, and reap it.
reap_watchdog() {
  [ -n "$WATCHDOG" ] || return 0
  kill -STOP "$WATCHDOG" >/dev/null 2>&1
  pkill -KILL -P "$WATCHDOG" >/dev/null 2>&1
  kill -KILL "$WATCHDOG" >/dev/null 2>&1
  kill -CONT "$WATCHDOG" >/dev/null 2>&1
  wait "$WATCHDOG" 2>/dev/null
  WATCHDOG=""
}
# procs <needle>: live pids (not this shell) whose argv or environ names
# <needle>, or whose cwd, exe, root or an open fd lies under it, removed or not:
# a process that cleared its environment and argv still belongs to the run
# while it holds anything in the run dir.
procs() {
  local self=$BASHPID
  {
    grep -lsF -- "$1" /proc/[0-9]*/cmdline /proc/[0-9]*/environ
    find /proc/[0-9]*/cwd /proc/[0-9]*/exe /proc/[0-9]*/root /proc/[0-9]*/fd -maxdepth 1 \
      \( -lname "$1*" -o -lname "${1%/}" -o -lname "${1%/} (deleted)" \) -print
  } 2>/dev/null | sed -n 's|^/proc/\([0-9]*\)/.*|\1|p' | sort -un | while read -r pid; do
    [ "$pid" = "$$" ] || [ "$pid" = "$self" ] || [ "$pid" = "$BASHPID" ] || [ ! -d "/proc/$pid" ] || echo "$pid"
  done
}
# scan_leftovers <tries>: true once a scan finds no live process of the run;
# false after <tries> scans 0.2 s apart, with the survivors in $LEFT.
scan_leftovers() {
  local _ pid
  for _ in $(seq "$1"); do
    LEFT=$(for pid in $(procs "$R/"); do "$TO" 5 ps -o pid=,args= -p "$pid"; done 2>/dev/null)
    [ -n "$LEFT" ] || return 0
    sleep 0.2
  done
  return 1
}
# kill_left: KILL every process in $LEFT and everything under it (a child may
# carry no trace of the run), all frozen first so none can fork away.
kill_left() {
  local pid all
  all=$(for pid in $(printf '%s\n' "$LEFT" | awk '{print $1}'); do
    echo "$pid"
    descendants "$pid" ""
  done)
  for pid in $all; do kill -STOP "$pid" >/dev/null 2>&1; done
  for pid in $all; do kill -KILL "$pid" >/dev/null 2>&1; done
}
# probe_sessions: RSESS = the sessions on mule's tmux server (one per running
# job). True on a successful enumeration, or on tmux's own one-line "no server
# running" (RSESS=0); a timeout, a hung or broken server, or any other error is
# false, with the reason in RSESS_ERR. A failed probe is never zero sessions.
probe_sessions() {
  local out err rc=0
  RSESS="" RSESS_ERR=""
  out=$(TMUX_TMPDIR="$R/rtmux" "$TO" -k 2 10 tmux -L "$MULE_TMUX" list-sessions -F '#{session_name}' 2>"$R/rsess.err") || rc=$?
  if [ "$rc" = 0 ]; then
    RSESS=$(printf '%s\n' "$out" | grep -c . || true)
    return 0
  fi
  err=$(cat "$R/rsess.err" 2>/dev/null)
  case "$err" in
    *$'\n'*) ;;
    "no server running on "*) [ "$rc" != 1 ] || {
      RSESS=0
      return 0
    } ;;
  esac
  RSESS_ERR="exit $rc: ${err:-no message}"
  return 1
}

cleanup() {
  local rc=$? pid _ all
  set +e
  IN_CLEANUP=1
  trap - EXIT
  reap_watchdog
  # After a deadline: the build and any child it reparented are stopped here,
  # TERM then KILL, until none is left (not a leak, so not a failure).
  if [ -e "$R/deadline" ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      # Pids from the scan's own (already gone) subshells are filtered out.
      all=$(procs "$R/")
      LEFT=$(for pid in $all; do [ ! -d "/proc/$pid" ] || echo "$pid"; done)
      [ -n "$LEFT" ] || break
      kill_left
      sleep 0.2
    done
  fi
  exec 1>&3 2>&4
  say "cleanup (exit $rc)"
  # A green run leaves mule's tmux server without a session (job).
  if [ "$rc" = 0 ]; then
    if ! probe_sessions; then
      say "FAIL the final tmux probe of mule's server failed ($RSESS_ERR)"
      rc=1
    elif [ "$RSESS" != 0 ]; then
      say "FAIL $RSESS session(s) left on mule's tmux server"
      rc=1
    fi
  fi
  # The fixture's own long-lived processes, stopped by name: the two tmux
  # servers (their panes and jobs go with them), mule's master, sshd.
  TMUX_TMPDIR="$R/ltmux" "$TO" -k 2 10 tmux -L "$MU_TMUX" kill-server >/dev/null 2>&1
  TMUX_TMPDIR="$R/rtmux" "$TO" -k 2 10 tmux -L "$MULE_TMUX" kill-server >/dev/null 2>&1
  [ -S "$R/m/mule.sock" ] && "$TO" -k 2 10 "$R/bin/ssh" -S "$R/m/mule.sock" -O exit 127.0.0.1 >/dev/null 2>&1
  [ -n "$SSHD_PID" ] && kill "$SSHD_PID" >/dev/null 2>&1
  # Whatever of the run outlives that teardown by 10 s was never meant to: a
  # leak. It fails the run and only then is KILLed, never swept silently.
  if ! scan_leftovers 50; then
    say "FAIL leftover processes after the fixture teardown (KILLed now):"
    printf '%s\n' "$LEFT" | sed 's/^/  /'
    rc=1
    kill_left
    scan_leftovers 25 || {
      say "FAIL still alive after KILL:"
      printf '%s\n' "$LEFT" | sed 's/^/  /'
    }
  fi
  "$TO" -k 2 30 rm -rf "/tmp/mu-$UID_/$WS"
  rmdir "/tmp/mu-$UID_" >/dev/null 2>&1
  if [ "${SMOKE_KEEP:-}" = 1 ]; then
    say "kept $R"
  else
    "$TO" -k 2 30 chmod -R u+w "$R" >/dev/null 2>&1
    "$TO" -k 2 60 rm -rf "$R"
    [ ! -e "$R" ] || {
      say "FAIL $R could not be removed"
      rc=1
    }
    # A process holding the run dir shows it as "(deleted)" after the removal.
    scan_leftovers 1 || {
      say "FAIL processes still hold the removed $R (KILLed now):"
      printf '%s\n' "$LEFT" | sed 's/^/  /'
      rc=1
      kill_left
    }
  fi
  if [ "$rc" = 0 ]; then say "SMOKE PASS"; else say "SMOKE FAIL (exit $rc)"; fi
  exit "$rc"
}
# A signal exits through cleanup; inside cleanup it is ignored.
on_sig() { [ -n "$IN_CLEANUP" ] || exit "$1"; }
# descendants <pid> <skip>: every process under <pid>, <skip>'s subtree excluded.
descendants() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do
    [ "$c" = "$2" ] && continue
    echo "$c"
    descendants "$c" "$2"
  done
}
# The deadline. bash runs its TERM trap only once the foreground command
# returns, so the watchdog also stops every process under this shell (TERM,
# KILL after 5 s), every 0.5 s until cleanup reaps it.
watchdog() {
  local me=$BASHPID n=0 sig pid mine
  sleep "$LIMIT"
  echo "smoke-remote-workspace: SMOKE_TIMEOUT ($LIMIT s) reached; stopping the run" >&2
  : >"$R/deadline"
  while kill -TERM $$ 2>/dev/null; do
    sig=TERM
    [ "$n" -lt 10 ] || sig=KILL
    mine=" $me $(descendants "$me" "") "
    # Under this shell, and anything tagged with the run (a reparented child).
    for pid in $(descendants $$ "$me") $(procs "$R/"); do
      case "$mine" in *" $pid "*) continue ;; esac
      kill -"$sig" "$pid" 2>/dev/null
    done
    n=$((n + 1))
    sleep 0.5
  done
}
exec 3>&1 4>&2
trap cleanup EXIT
trap 'on_sig 130' INT
trap 'on_sig 143' TERM
trap 'on_sig 129' HUP
watchdog </dev/null >/dev/null 3>&- 4>&- &
WATCHDOG=$!

MU=$(cd "$MU" && pwd -P)
MULE=$(cd "$MULE" && pwd -P)
# The node binary itself, not a version manager's shim (a shim resolves through $HOME).
NODE=$(node -e 'console.log(process.execPath)')
NODE_DIR=$(dirname "$NODE")
NPM_JS=$("$NODE" -e 'console.log(require("path").resolve(process.argv[1], "../lib/node_modules/npm/bin/npm-cli.js"))' "$NODE_DIR")
[ -f "$NPM_JS" ] || NPM_JS=$(cd "$(dirname "$(readlink -f "$(command -v npm)")")" && pwd -P)/npm-cli.js
[ -f "$NPM_JS" ] || {
  echo "smoke-remote-workspace: PREREQUISITE MISSING: npm-cli.js beside $NODE" >&2
  exit 2
}
PLATFORM=$("$NODE" -p 'process.platform + "-" + process.arch')
[ -f "$MULE/npm/mule-$PLATFORM/package.json" ] || {
  echo "smoke-remote-workspace: PREREQUISITE MISSING: mule has no platform package for $PLATFORM" >&2
  exit 2
}

# ── build ────────────────────────────────────────────────────────────────────
say "build mule: cargo build --release in $MULE"
(cd "$MULE" && "$TO" 1200 cargo build --release --locked --quiet) || fail "cargo build --release"
say "build mu: npm run build in $MU"
(cd "$MU" && "$TO" 600 npm run build --silent >/dev/null) || fail "npm run build"
for f in "$MULE/target/release/mule" "$MULE/target/release/mu-plugin-mule"; do
  [ -x "$f" ] || fail "no $f after the build"
done
[ -f "$MU/dist/cli.js" ] || fail "no mu dist/cli.js after the build"
[ -f "$MU/dist/extension/mu-pi.js" ] || fail "no mu dist/extension/mu-pi.js (the ctl extension) after the build"
"$TO" 20 "$MULE/target/release/mule" serve --help >/dev/null 2>&1 || fail "this mule has no 'serve' verb"
say "mule $(git -C "$MULE" rev-parse --short HEAD 2>/dev/null || echo '?'), mu $(git -C "$MU" rev-parse --short HEAD 2>/dev/null || echo '?')"

# ── private world ────────────────────────────────────────────────────────────

mkdir -p "$R"/{bin,rbin,trip,m,tmp,home,config/mule,cache,lstate,ltmux,rtmux,rhome/.local/state,pack,pkgs,piagent,npm-cache,results}
chmod 700 "$R/m" "$R/ltmux" "$R/rtmux"
SSH_KEYGEN=$(command -v ssh-keygen)
for c in tmux git git-upload-pack; do ln -s "$(command -v "$c")" "$R/rbin/$c"; done

while IFS= read -r v; do unset "$v"; done < <(env | sed -n 's/^\(MU_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(PI_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(MULE_[A-Za-z0-9_]*\)=.*/\1/p')
unset TMUX TMUX_PANE
export HOME="$R/home" TMPDIR="$R/tmp" XDG_CONFIG_HOME="$R/config" XDG_CACHE_HOME="$R/cache"
export XDG_STATE_HOME="$R/lstate" TMUX_TMPDIR="$R/ltmux"
export MU_DB_PATH="$R/lstate/mu5/mu.db" MU_SYNC_DIR="" MU_TMUX_SOCKET="$MU_TMUX" MU_MUX=tmux
export MURMUR_STATE_DIR="$R/lstate/murmur"
export npm_config_cache="$R/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@localhost
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@localhost
PKG_BIN="$R/pkgs/node_modules/.bin"
export PATH="$R/bin:$PKG_BIN:$NODE_DIR:$PATH"
mkdir -p "$R/lstate/mu5"

npmx() { "$TO" -k 5 600 "$NODE" "$NPM_JS" "$@"; }
mu() { "$TO" -k 5 180 "$NODE" "$MU/dist/cli.js" "$@"; }
printf '#!/bin/sh\nexec %s %s "$@"\n' "$NODE" "$MU/dist/cli.js" >"$R/bin/mu"
chmod 755 "$R/bin/mu"
# The pane's PATH starts here: an extension that looked `mule` up on PATH lands in the log.
printf '#!/bin/sh\necho "$*" >>%s\nexit 97\n' "$R/trip.log" >"$R/trip/mule"
chmod 755 "$R/trip/mule"
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

# ── P. pack and install the mule packages ────────────────────────────────────
say "P. npm pack @mu-crew/mule + @mu-crew/mule-$PLATFORM from $MULE, install into a scratch prefix"
# Pack copies, never the checkout: the root package's prepack writes npm/mule/pi.
mkdir -p "$R/pack/src/npm" "$R/pack/src/scripts"
cp -R "$MULE/npm/mule" "$MULE/npm/mule-$PLATFORM" "$R/pack/src/npm/"
cp -R "$MULE/pi" "$R/pack/src/pi"
cp "$MULE/scripts/npm-pi.js" "$R/pack/src/scripts/"
rm -rf "$R/pack/src/npm/mule/pi"
mkdir -p "$R/pack/src/npm/mule-$PLATFORM/bin"
cp "$MULE/target/release/mule" "$MULE/target/release/mu-plugin-mule" "$R/pack/src/npm/mule-$PLATFORM/bin/"
chmod 755 "$R/pack/src/npm/mule-$PLATFORM/bin/"*
for p in mule "mule-$PLATFORM"; do
  (cd "$R/pack/src/npm/$p" && npmx pack --offline --silent --pack-destination "$R/pack" >"$R/pack/$p.name") ||
    fail "npm pack ./npm/$p"
done
ROOT_TGZ="$R/pack/$(tail -n 1 "$R/pack/mule.name")"
PLAT_TGZ="$R/pack/$(tail -n 1 "$R/pack/mule-$PLATFORM.name")"
[ -f "$ROOT_TGZ" ] && [ -f "$PLAT_TGZ" ] || fail "npm pack wrote no tarball ($(cat "$R/pack/"*.name))"
"$TO" 30 tar tzf "$ROOT_TGZ" >"$R/pack/root.list"
for f in package/pi/mule.ts package/pi/serve-backend.ts package/pi/exec-backend.ts package/pi/binary.ts package/bin/mule; do
  grep -qx "$f" "$R/pack/root.list" || fail "$(basename "$ROOT_TGZ") lacks $f"
done
! grep -E '\.test\.ts$|^package/pi/test/' "$R/pack/root.list" >/dev/null || fail "$(basename "$ROOT_TGZ") ships tests: $(grep -E '\.test\.ts$|/test/' "$R/pack/root.list" | tr '\n' ' ')"
"$TO" 30 tar tzf "$PLAT_TGZ" >"$R/pack/platform.list"
grep -qx package/bin/mule "$R/pack/platform.list" || fail "$(basename "$PLAT_TGZ") lacks bin/mule"
# A project install: the local platform tarball satisfies the root's optional
# dependency, so no registry copy can stand in for this build. --offline: the
# other platforms' optional packages are skipped, never fetched.
printf '{"name":"smoke-remote-workspace-pkgs","private":true}\n' >"$R/pkgs/package.json"
(cd "$R/pkgs" && npmx install --offline --no-package-lock --silent "$ROOT_TGZ" "$PLAT_TGZ") >"$R/pkgs/install.log" 2>&1 || {
  cat "$R/pkgs/install.log"
  fail "npm install of the mule tarballs"
}
MULE_PKG="$R/pkgs/node_modules/@mu-crew/mule"
PLAT_BIN="$R/pkgs/node_modules/@mu-crew/mule-$PLATFORM/bin/mule"
[ -f "$MULE_PKG/pi/mule.ts" ] || fail "the installed @mu-crew/mule has no pi/mule.ts"
RESOLVED=$("$NODE" -e 'console.log(require("module").createRequire(process.argv[1]).resolve(process.argv[2]))' \
  "$MULE_PKG/package.json" "@mu-crew/mule-$PLATFORM/bin/mule") || fail "the platform package does not resolve from @mu-crew/mule"
[ "$RESOLVED" = "$PLAT_BIN" ] || fail "@mu-crew/mule resolves its binary to $RESOLVED, not $PLAT_BIN"
cmp -s "$PLAT_BIN" "$MULE/target/release/mule" || fail "the installed platform binary is not this mule build"
[ "$(command -v mule)" = "$PKG_BIN/mule" ] || fail "mule on the orchestrator PATH is $(command -v mule), not the installed package's"
INSTALLED_VER=$("$TO" 20 mule --version) || fail "installed mule --version"
pass "packed $(basename "$ROOT_TGZ") ($(grep -c '^package/pi/' "$R/pack/root.list") pi/ files, no tests) + $(basename "$PLAT_TGZ"); installed: $INSTALLED_VER, extension binary = platform package = this build"

if [ -z "$PI" ]; then
  say "P. installing @earendil-works/pi-coding-agent@$PI_VERSION from the registry into the private prefix"
  mkdir -p "$R/pi"
  printf '{"name":"smoke-remote-workspace-pi","private":true}\n' >"$R/pi/package.json"
  (cd "$R/pi" && npmx install --no-package-lock --ignore-scripts --silent "@earendil-works/pi-coding-agent@$PI_VERSION") >"$R/pi/install.log" 2>&1 || {
    tail -n 20 "$R/pi/install.log"
    echo "smoke-remote-workspace: PREREQUISITE MISSING: pi from the registry (set PI=<standalone pi> offline)" >&2
    exit 2
  }
  PI="$R/pi/node_modules/.bin/pi"
fi
PI_JS=$(readlink -f "$PI")
cp "$SCRIPTS/smoke-remote-workspace-pi.mjs" "$R/smoke-remote-workspace-pi.mjs"
# The pane's pi: real pi, the scripted model, the private agent dir, a PATH whose
# first `mule` is the tripwire, and no MULE_PI_BIN. A subcommand runs plain.
cat >"$R/bin/pi" <<EOF
#!/bin/sh
unset MULE_PI_BIN
export PATH="$R/trip:\$PATH" PI_CODING_AGENT_DIR="$R/piagent" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 MULE_PI_MUZZLE=off SMOKE_RESULTS="$R/results"
case "\${1:-}" in
  install|remove|uninstall|update|list|config|--version|-v|--help|-h) exec "$NODE" "$PI_JS" "\$@" ;;
esac
exec "$NODE" "$PI_JS" --provider smoke --model scripted -e "$R/smoke-remote-workspace-pi.mjs" "\$@"
EOF
chmod 755 "$R/bin/pi"
PI_VER=$("$TO" 60 pi --version 2>&1 | tail -n 1) || fail "pi --version"
"$TO" 120 pi install "$MU" >"$R/pi-install.log" 2>&1 || {
  cat "$R/pi-install.log"
  fail "pi install the mu checkout"
}
"$TO" 120 pi install "$MULE_PKG" >>"$R/pi-install.log" 2>&1 || {
  cat "$R/pi-install.log"
  fail "pi install the installed @mu-crew/mule"
}
"$TO" 60 pi list >"$R/pi-list.out" 2>&1 || fail "pi list"
grep -qF "$MULE_PKG" "$R/pi-list.out" || fail "pi list does not show $MULE_PKG: $(cat "$R/pi-list.out")"
grep -qF "$MU" "$R/pi-list.out" || fail "pi list does not show $MU: $(cat "$R/pi-list.out")"
pass "pi $PI_VER: pi install'ed the mu checkout (ctl) and the installed @mu-crew/mule package"

# ── loopback sshd, MaxSessions 1 ─────────────────────────────────────────────
PORT=$("$TO" 20 "$NODE" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
"$TO" 30 "$SSH_KEYGEN" -q -t ed25519 -N '' -f "$R/hostkey"
"$TO" 30 "$SSH_KEYGEN" -q -t ed25519 -N '' -f "$R/id"
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
"$TO" 30 "$SSHD" -f "$R/sshd_config" -E "$R/sshd.log" || fail "sshd did not start (log: $R/sshd.log)"
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

open_master() { "$TO" 30 ssh -MNf -S "$R/m/mule.sock" -o ControlPersist=8h -o StreamLocalBindUnlink=yes 127.0.0.1; }
master_pid() { "$TO" 20 ssh -S "$R/m/mule.sock" -O check 127.0.0.1 2>&1 | sed -n 's/.*pid=\([0-9]*\).*/\1/p'; }
open_master || fail "open mule's master"
MULE_MASTER=$(master_pid)
[ -n "$MULE_MASTER" ] || fail "no mule master"
# The cap is real: while a session holds the master, a second one is refused.
via_master() { "$TO" 30 ssh -S "$R/m/mule.sock" -o BatchMode=yes -o ControlMaster=no -o ProxyCommand=/usr/bin/false 127.0.0.1 "$@"; }
refusals() { grep -c -i 'no more sessions\|session open refused\|open failed' "$R/sshd.log" || true; }
# Every session sshd opened (one per mule call over the master).
sessions() { grep -c 'Starting session:' "$R/sshd.log" || true; }
via_master 'sleep 3' &
held=$!
sleep 1
if via_master true 2>"$R/refused.err"; then fail "MaxSessions 1 is not in effect"; fi
wait "$held"
REFUSED0=$(refusals)
[ "$REFUSED0" -ge 1 ] || fail "sshd logged no refusal for the cap test (log: $(tail -n 5 "$R/sshd.log"))"
pass "cap reproduced on mule's master: a second session is refused (sshd logged $REFUSED0 refusal line(s))"

# mule's default config path, so mu, mu-plugin-mule and the extension all read it.
cat >"$R/config/mule/config.toml" <<EOF
[hosts.loop]
target = "127.0.0.1"
socket = "$R/m/mule.sock"
tmux_socket = "$MULE_TMUX"
EOF
mulex() { "$TO" -k 5 60 mule "$@"; }

# ── fixture repos, plugin profile ────────────────────────────────────────────
RREPO="$R/rhome/repo"
LREPO="$R/local"
g init -q "$RREPO"
echo base >"$RREPO/base.txt"
g -C "$RREPO" add base.txt
g -C "$RREPO" commit -q -m "remote workspace base"
BASE=$(g -C "$RREPO" rev-parse HEAD)
g clone -q "$RREPO" "$LREPO"

mu workstream init "$WS" >/dev/null
mulex init --quiet >"$R/init.out" 2>&1 || {
  cat "$R/init.out"
  fail "mule init (the installed package)"
}
mu plugin list --json >"$R/plugins.json" || fail "mu plugin list"
js "JSON.stringify(d).includes('$R/pkgs/')" <"$R/plugins.json" >/dev/null || fail "mule init did not register the installed package's plugin: $(cat "$R/plugins.json")"
mu host add loop --plugin mule --fetch "git fetch ssh://127.0.0.1{cwd} HEAD" --max-sessions 1 >/dev/null ||
  fail "mu host add loop --plugin mule"
# The remote workspace's premise: the host cannot run the loop. The check fails on harnesses
# (no pi there) and on nothing else; the mule master and tmux steps pass.
mu host check loop --root "$RREPO" --json >"$R/check.json" || true
js "d.data.steps.every((s)=>s.ok !== false || s.step === 'harnesses') && d.data.steps.some((s)=>s.step === 'mule:master' && s.ok) && d.data.capabilities.harnesses.pi.command === null" <"$R/check.json" >/dev/null || {
  cat "$R/check.json"
  fail "mu host check loop"
}
pass "plugin profile loop (installed mu-plugin-mule): host check $(js 'd.data.steps.map((s)=>s.step+"="+s.ok).join(" ")' <"$R/check.json") (no pi on the host)"

# ── helpers ──────────────────────────────────────────────────────────────────
local_sock() { echo "$R/lstate/mu5/sock/$WS/$1.sock"; }
agent_cwd() { sql "SELECT a.cwd FROM agents a JOIN workstreams w ON w.id=a.workstream_id WHERE w.name='$WS' AND a.name='$1'" | js 'd[0]?.cwd'; }
# remote_sessions: RSESS = the session count on mule's tmux server; a failed
# probe fails the run (probe_sessions).
remote_sessions() { probe_sessions || fail "the tmux probe of mule's server failed ($RSESS_ERR); that is not zero sessions"; }
# mule_jobs [ls args...]: the host's job list; an unreachable host fails the run.
mule_jobs() {
  local out
  out=$(mulex ls --host loop --all --json "$@" 2>"$R/mule-ls.err") || fail "mule ls --host loop: $(cat "$R/mule-ls.err")"
  printf '%s' "$out" | js 'd.unreachable.length === 0' >/dev/null || fail "mule ls: loop unreachable: $out"
  printf '%s' "$out"
}
running_jobs() { mule_jobs --key-prefix "$1" | js "d.items.filter((j)=>j.state==='running').length"; }
# loop_pid <agent>: the pi (node) process serving the agent's local ctl socket
# (pi sets its process title, so argv is no use; its environ is).
loop_pid() {
  local pid
  for pid in $(procs "MU_CTL_SOCK=$(local_sock "$1")"); do
    [ "$(readlink "/proc/$pid/exe" 2>/dev/null)" = "$NODE" ] && {
      echo "$pid"
      return 0
    }
  done
  return 1
}
env_of() { tr '\0' '\n' <"/proc/$1/environ" | sed -n "s/^$2=//p"; }
# serve_children <pid>: `mule serve --stdio` processes whose parent is <pid>.
serve_children() {
  local p
  for p in $(pgrep -P "$1" 2>/dev/null || true); do
    tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -qE ' serve( .*)? --stdio' && echo "$p"
  done
  return 0
}
# A local process running the installed mule binary (serve, poll, run...).
local_mule() {
  local p
  for p in $(procs "$R/"); do
    [ "$(readlink "/proc/$p/exe" 2>/dev/null)" = "$PLAT_BIN" ] && echo "$p"
  done
  return 0
}
# remote_procs <marker>: live processes whose argv names <marker> (a remote job's command).
remote_procs() { pgrep -f "$1" | while read -r p; do grep -qsF "HOME=$R/rhome" "/proc/$p/environ" && echo "$p"; done; }

TURN=0
# turn <agent> <script-json>: one scripted pi turn, waited for; its tool results
# are left in $RES (a JSON array of {id, tool, error, text}).
turn() {
  local a=$1 script=$2 text tag
  TURN=$((TURN + 1))
  tag="turn-$TURN"
  mu agent send "$a" -w "$WS" "smoke-turn {\"tag\":\"$tag\",${script#\{}" --wait --json >"$R/$tag.out" || {
    cat "$R/$tag.out"
    fail "$tag: send --wait to $a"
  }
  text=$(js 'd.data.snapshots?.[0]?.lastText' <"$R/$tag.out") || {
    cat "$R/$tag.out"
    fail "$tag: no lastText from $a"
  }
  case "$text" in "smoke-results $tag "*) ;; *)
    printf '%s\n' "$text"
    fail "$tag: $a did not finish its script"
    ;;
  esac
  RES="$R/results/$tag.json"
  [ -s "$RES" ] || fail "$tag: no results file"
}
res() { js "$1" <"$RES"; }
all_ok() { res "d.length === $1 && d.every((r)=>!r.error)" >/dev/null || fail "turn $TURN: expected $1 clean tool results: $(cat "$RES")"; }
# send_async <agent> <script-json>: start a turn without waiting.
send_async() {
  mu agent send "$1" -w "$WS" "smoke-turn $2" --json >"$R/async-$1.json" || {
    cat "$R/async-$1.json"
    fail "send to $1"
  }
}
# shellcheck disable=SC2016 # node source, not shell
fill_sha() { "$NODE" -e 'let s="";for(let i=0;s.length<+process.argv[1];i++)s+=`remote-workspace line ${i}\n`;console.log(require("crypto").createHash("sha256").update(s.slice(0,+process.argv[1])).digest("hex"))' "$1"; }
sha_of() { "$NODE" -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }

# spawn_mule <name>: a remote workspace worker; sets TREE, LOOP, PREFIX.
spawn_mule() {
  local a=$1 row pane start
  (cd "$LREPO" && mu agent spawn "$a" -w "$WS" --mule loop --root "$RREPO" --json) >"$R/spawn-$a.json" || {
    cat "$R/spawn-$a.json"
    fail "remote workspace spawn $a"
  }
  [ "$(js 'd.data.ctl ?? d.data.agent?.ctl ?? "?"' <"$R/spawn-$a.json")" = ok ] || {
    cat "$R/spawn-$a.json"
    fail "spawn $a: ctl handshake not ok"
  }
  row=$(sql "SELECT a.host, a.host_transport, a.cwd, a.pane_id FROM agents a JOIN workstreams w ON w.id=a.workstream_id WHERE w.name='$WS' AND a.name='$a'")
  printf '%s' "$row" | js "d.length === 1 && d[0].host === 'loop' && d[0].host_transport === 'local-loop'" >/dev/null ||
    fail "agent row of $a is not a local loop on loop: $row"
  TREE=$(printf '%s' "$row" | js 'd[0].cwd')
  case "$TREE" in "$R/rhome"/*) ;; *) fail "$a's workspace $TREE is not a remote tree" ;; esac
  [ "$(g -C "$TREE" rev-parse HEAD)" = "$BASE" ] || fail "$a's remote tree is not at base"
  [ "$(sql "SELECT count(*) AS n FROM carrier_jobs WHERE name='$a'" | js 'd[0].n')" = 0 ] || fail "remote workspace spawn $a took a carrier job"
  until_ok 100 "the pi loop of $a" loop_pid "$a"
  LOOP=$(loop_pid "$a")
  pane=$(printf '%s' "$row" | js 'd[0].pane_id')
  start=$("$TO" -k 2 10 tmux -L "$MU_TMUX" display -p -t "$pane" '#{pane_start_command}') || fail "no pane $pane for $a"
  case "$start" in *--mule*"loop:$TREE"*) ;; *) fail "$a's pane command lacks --mule loop:<tree>: $start" ;; esac
  [ "$(readlink "/proc/$LOOP/cwd")" = "$LREPO" ] || fail "$a's pi runs in $(readlink "/proc/$LOOP/cwd"), not the local checkout"
  PREFIX=$(env_of "$LOOP" MULE_PI_JOB_PREFIX)
  [[ "$PREFIX" =~ ^mu\.[A-Za-z0-9_-]+\.[0-9]+\.$ ]] || fail "$a's loop has MULE_PI_JOB_PREFIX='$PREFIX'"
  [ -z "$(env_of "$LOOP" MULE_PI_BIN)" ] || fail "$a's loop has MULE_PI_BIN set"
  [ -S "$(local_sock "$a")" ] || fail "no local ctl socket for $a"
  pass "remote workspace: $a spawned: local pane, pi $LOOP in the local checkout, ctl ok on a local socket, remote tree \$R${TREE#"$R"} at ${BASE:0:12}, job prefix $PREFIX"
}

# close_agent <name> <tree> <prefix>: preview + --if close, then C for that agent.
close_agent() {
  local a=$1 tree=$2 prefix=$3 rev left=() n t
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
  [ ! -e "$tree" ] || left+=("remote worktree")
  g -C "$RREPO" worktree list --porcelain | grep -qxF "worktree $tree" && left+=("git worktree entry")
  n=$(running_jobs "$prefix")
  [ "$n" = 0 ] || left+=("$n running mule job(s) under $prefix")
  remote_sessions
  [ "$RSESS" = 0 ] || left+=("$RSESS remote tmux session(s)")
  [ -z "$(loop_pid "$a" || true)" ] || left+=("the pi loop")
  [ -z "$(local_mule)" ] || left+=("local mule process(es) $(local_mule | tr '\n' ' ')")
  if [ ${#left[@]} -gt 0 ]; then
    printf '  left: %s\n' "${left[@]}"
    fail "close of $a left state behind"
  fi
  pass "close $a: no running job under $prefix, remote session or process, tree, socket, pi, mule process, or agent/carrier_jobs/remote_recovery/effects/host_channels row"
}

# ── S. spawn ─────────────────────────────────────────────────────────────────
say "S. mu agent spawn --mule loop"
spawn_mule w1
W1_TREE=$TREE W1_LOOP=$LOOP W1_PREFIX=$PREFIX

# ── R1. a deterministic tool chain ───────────────────────────────────────────
say "R1. read, write, edit, read over mule serve; bash as a detached job"
turn w1 '{"steps":[[{"tool":"read","args":{"path":"base.txt"}}],[{"tool":"write","args":{"path":"r1.txt","content":"alpha\n"}}],[{"tool":"edit","args":{"path":"r1.txt","edits":[{"oldText":"alpha","newText":"beta"}]}}],[{"tool":"read","args":{"path":"r1.txt"}}],[{"tool":"bash","args":{"command":"pwd; cat r1.txt"}}]]}'
all_ok 5
res 'd[0].text.includes("base")' >/dev/null || fail "read base.txt: $(cat "$RES")"
res 'd[3].text.includes("beta") && !d[3].text.includes("alpha")' >/dev/null || fail "edit not seen by the next read: $(cat "$RES")"
res "d[4].text.includes('$W1_TREE') && d[4].text.includes('beta')" >/dev/null || fail "bash did not run in the remote tree: $(cat "$RES")"
[ "$(cat "$W1_TREE/r1.txt")" = beta ] || fail "remote r1.txt is '$(cat "$W1_TREE/r1.txt")'"
[ ! -e "$LREPO/r1.txt" ] || fail "the write landed in the local checkout"
SERVE=$(serve_children "$W1_LOOP")
[ "$(printf '%s\n' "$SERVE" | grep -c .)" = 1 ] || fail "pi $W1_LOOP has serve children '$SERVE', expected one"
[ "$(readlink "/proc/$SERVE/exe")" = "$PLAT_BIN" ] || fail "serve runs $(readlink "/proc/$SERVE/exe"), not the installed platform binary"
JOBS=$(mule_jobs --key-prefix "$W1_PREFIX")
printf '%s' "$JOBS" | js "d.items.length === 1 && d.items[0].key.startsWith('$W1_PREFIX') && d.items[0].state === 'done'" >/dev/null ||
  fail "expected one done job (the bash call) under $W1_PREFIX: $JOBS"
[ ! -e "$R/trip.log" ] || fail "the extension ran a mule from PATH: $(cat "$R/trip.log")"
pass "5-step chain clean: file ops in serve child $SERVE (the installed binary), r1.txt only remote; bash = 1 detached job $(printf '%s' "$JOBS" | js 'd.items[0].id') keyed ${W1_PREFIX}…"

# ── R2. a coalesced read burst ───────────────────────────────────────────────
say "R2. 20 parallel reads in one step over MaxSessions 1"
calls=""
for i in $(seq 0 19); do
  printf 'burst %02d %s\n' "$i" "$RANDOM$RANDOM" >"$W1_TREE/burst-$i.txt"
  calls="$calls${calls:+,}{\"tool\":\"read\",\"args\":{\"path\":\"burst-$i.txt\"}}"
done
B0=$(date +%s%N)
S0=$(sessions)
turn w1 "{\"steps\":[[$calls]]}"
S1=$(sessions)
B1=$(date +%s%N)
all_ok 20
for i in $(seq 0 19); do
  want=$(cat "$W1_TREE/burst-$i.txt")
  res "d[$i].id.endsWith('s0c$i') && d[$i].text.includes('$want')" >/dev/null || fail "burst read $i: $(res "d[$i]")"
done
# Coalesced: the 20 reads share serve round trips, far fewer sessions than reads.
[ $((S1 - S0)) -le 5 ] || fail "the 20-read burst opened $((S1 - S0)) ssh sessions"
[ "$(serve_children "$W1_LOOP")" = "$SERVE" ] || fail "the burst changed the serve child ($(serve_children "$W1_LOOP"), was $SERVE)"
[ "$(refusals)" = "$REFUSED0" ] || fail "sshd refused a session in the burst: $(grep -i 'no more sessions\|refused\|open failed' "$R/sshd.log" | tail -n 3)"
pass "20 parallel reads, all exact, in $(((B1 - B0) / 1000000)) ms turn time over $((S1 - S0)) ssh session(s); same serve child $SERVE; sshd refused nothing"

# ── R3. 200 KB write over an existing 0640 file ──────────────────────────────
say "R3. 200 KB write, mode kept"
echo old >"$W1_TREE/big.txt"
chmod 0640 "$W1_TREE/big.txt"
turn w1 '{"steps":[[{"tool":"write","args":{"path":"big.txt"},"fill":{"key":"content","bytes":204800}}]]}'
all_ok 1
[ "$(stat -c %s "$W1_TREE/big.txt")" = 204800 ] || fail "big.txt is $(stat -c %s "$W1_TREE/big.txt") bytes"
[ "$(sha_of "$W1_TREE/big.txt")" = "$(fill_sha 204800)" ] || fail "big.txt content differs from the 200 KB the model wrote"
[ "$(stat -c %a "$W1_TREE/big.txt")" = 640 ] || fail "big.txt mode is $(stat -c %a "$W1_TREE/big.txt"), not 640"
[ "$(refusals)" = "$REFUSED0" ] || fail "sshd refused a session in the write"
pass "204800 bytes written exactly, mode 0640 kept"

# ── R4. cancel ───────────────────────────────────────────────────────────────
say "R4. mu agent abort mid-bash"
send_async w1 '{"steps":[[{"tool":"bash","args":{"command":"echo started >cancel.flag; exec sleep 301"}}]]}'
until_ok 300 "the cancel job to start" test -e "$W1_TREE/cancel.flag"
[ "$(running_jobs "$W1_PREFIX")" = 1 ] || fail "no running job for the cancel turn"
[ -n "$(remote_procs 'sleep 301')" ] || fail "no remote sleep 301"
CANCEL_JOB=$(mule_jobs --key-prefix "$W1_PREFIX" | js "d.items.find((j)=>j.state==='running').id")
mu agent abort w1 -w "$WS" --json >"$R/abort.json" || {
  cat "$R/abort.json"
  fail "mu agent abort w1"
}
no_cancel_job() { [ "$(running_jobs "$W1_PREFIX")" = 0 ] && [ -z "$(remote_procs 'sleep 301')" ] && remote_sessions && [ "$RSESS" = 0 ]; }
until_ok 150 "the aborted job to be gone" no_cancel_job
js 'd.data.aborted === true && d.data.settled === true && d.data.after === "idle"' <"$R/abort.json" >/dev/null || fail "abort did not settle the turn: $(cat "$R/abort.json")"
KILLED=$(mule_jobs --key-prefix "$W1_PREFIX" | js "JSON.stringify(d.items.find((j)=>j.id==='$CANCEL_JOB'))")
turn w1 '{"steps":[[{"tool":"bash","args":{"command":"echo after-cancel"}}]]}'
all_ok 1
res 'd[0].text.includes("after-cancel")' >/dev/null || fail "after cancel: $(cat "$RES")"
pass "abort settled the turn and stopped exactly its job $CANCEL_JOB (now $KILLED; 0 running under the prefix, no remote sleep, 0 remote tmux sessions); the next turn ran"

# ── R5. master loss mid-turn ─────────────────────────────────────────────────
say "R5. drop mule's master mid-turn"
SERVE_BEFORE_LOSS=$(serve_children "$W1_LOOP")
send_async w1 '{"steps":[[{"tool":"bash","args":{"command":"echo go >loss.flag; while [ ! -e loss.gate ]; do sleep 0.2; done; echo released"}}]]}'
until_ok 300 "the loss job to start" test -e "$W1_TREE/loss.flag"
LOSS_JOB=$(mule_jobs --key-prefix "$W1_PREFIX" | js "d.items.find((j)=>j.state==='running').id")
"$TO" 20 ssh -S "$R/m/mule.sock" -O exit 127.0.0.1 >/dev/null 2>&1 || true
until_ok 100 "mule's master to exit" sh -c "! kill -0 $MULE_MASTER 2>/dev/null"
# The turn hands back and stops: the bash poll meets mule's exit 3, the
# extension aborts the turn and pi waits for input.
agent_state() { mu agent list -w "$WS" --json | js "d.data.agents.find((a)=>a.name==='$1')?.state"; }
not_busy() { [ "$(agent_state "$1")" != busy ]; }
until_ok 300 "w1's turn to hand back" not_busy w1
mu agent show w1 -w "$WS" --json >"$R/show-down.json" || fail "agent show with the master down"
js 'd.data.scrollback.includes("needs its SSH master")' <"$R/show-down.json" >/dev/null ||
  fail "the loop did not hand back: $(js 'd.data.scrollback' <"$R/show-down.json" | tail -n 20)"
DOWN_STATE=$(agent_state w1)
RC=0
mu agent send w1 -w "$WS" "smoke-turn {\"steps\":[]}" --json >"$R/send-down.json" 2>&1 || RC=$?
handed_back() { [ "$1" = 5 ] && js "d.data.handback === true && d.data.host === 'loop'" <"$2" >/dev/null; }
handed_back "$RC" "$R/send-down.json" || {
  cat "$R/send-down.json"
  fail "send with the master down: exit $RC, expected 5 (hand-back)"
}
RC=0
mu agent wait w1 -w "$WS" --json >"$R/wait-down.json" 2>&1 || RC=$?
handed_back "$RC" "$R/wait-down.json" || {
  cat "$R/wait-down.json"
  fail "wait with the master down: exit $RC, expected 5 (hand-back)"
}
mu agent list -w "$WS" --json >"$R/list-down.json" || fail "agent list with the master down"
kill -0 "$W1_LOOP" 2>/dev/null || fail "the local pi died with the master"
[ "$(sql "SELECT count(*) AS n FROM agents WHERE name='w1'" | js 'd[0].n')" = 1 ] || fail "the local pane was reaped on master loss"
remote_sessions
[ "$RSESS" -ge 1 ] || fail "the stopped turn's job did not keep running on the host (no remote tmux session)"
pass "master gone mid-bash: the loop handed back (state $DOWN_STATE), send and wait hand back (exit 5); pane, pi $W1_LOOP and row kept; the job keeps running remotely"
open_master || fail "reopen mule's master"
MULE_MASTER=$(master_pid)
touch "$W1_TREE/loss.gate"
loss_done() { [ "$(running_jobs "$W1_PREFIX")" = 0 ]; }
until_ok 300 "the stopped turn's job to finish once released" loss_done
mule_jobs --key-prefix "$W1_PREFIX" | js "d.items.find((j)=>j.id==='$LOSS_JOB').rc === 0" >/dev/null ||
  fail "the stopped turn's job $LOSS_JOB did not end 0: $(mule_jobs --key-prefix "$W1_PREFIX")"
turn w1 '{"steps":[[{"tool":"read","args":{"path":"loss.flag"}}],[{"tool":"bash","args":{"command":"cat loss.flag; echo resumed"}}]]}'
all_ok 2
res 'd[0].text.includes("go") && d[1].text.includes("resumed")' >/dev/null || fail "after the master returned: $(cat "$RES")"
[ "$(loop_pid w1)" = "$W1_LOOP" ] || fail "the pi loop was replaced"
SERVE_AFTER=$(serve_children "$W1_LOOP")
[ "$(printf '%s\n' "$SERVE_AFTER" | grep -c .)" = 1 ] || fail "pi has serve children '$SERVE_AFTER' after the master returned"
pass "master $MULE_MASTER back: the released job $LOSS_JOB ended 0; the same pi resumes (read over serve child $SERVE_AFTER, before the loss $SERVE_BEFORE_LOSS; bash as a job)"

# ── R6. collect ──────────────────────────────────────────────────────────────
say "R6. the loop commits in the remote tree; mu agent collect brings it home"
turn w1 '{"steps":[[{"tool":"bash","args":{"command":"git add -A && git -c user.name=smoke -c user.email=smoke@localhost commit -q -m \"remote workspace: from the remote tree\" && git rev-parse HEAD"}}]]}'
all_ok 1
C1=$(res 'd[0].text' | grep -E '^[0-9a-f]{40}$' | tail -n 1) || fail "the loop printed no commit: $(cat "$RES")"
[ "$(g -C "$W1_TREE" rev-parse HEAD)" = "$C1" ] || fail "remote tree HEAD is not $C1"
! g -C "$LREPO" cat-file -e "$C1^{commit}" 2>/dev/null || fail "$C1 is local before the collect"
(cd "$LREPO" && mu agent collect w1 -w "$WS" --json) >"$R/collect.json" || {
  cat "$R/collect.json"
  fail "collect w1"
}
js "d.data.changed === true && d.data.head === '$C1' && d.data.ref === 'refs/mu/collect/$WS/w1'" <"$R/collect.json" >/dev/null || {
  cat "$R/collect.json"
  fail "collect w1 did not pin $C1"
}
[ "$(g -C "$LREPO" rev-parse "refs/mu/collect/$WS/w1")" = "$C1" ] || fail "refs/mu/collect/$WS/w1 is not $C1"
[ "$(g -C "$LREPO" show "$C1:r1.txt")" = beta ] || fail "the collected commit lacks r1.txt=beta"
[ "$(g -C "$LREPO" cat-file -s "$C1:big.txt")" = 204800 ] || fail "the collected commit lacks the 200 KB big.txt"
pass "collect pinned ${C1:0:12} (made by the loop's bash in the remote tree) at refs/mu/collect/$WS/w1, with r1.txt and big.txt"
close_agent w1 "$W1_TREE" "$W1_PREFIX"

# ── R7. caller death ─────────────────────────────────────────────────────────
say "R7. SIGKILL the pi loop mid-bash"
spawn_mule w2
W2_TREE=$TREE W2_LOOP=$LOOP W2_PREFIX=$PREFIX
send_async w2 '{"steps":[[{"tool":"read","args":{"path":"base.txt"}}],[{"tool":"bash","args":{"command":"exec sleep 303"}}]]}'
has_remote() { [ -n "$(remote_procs "$1")" ]; }
until_ok 300 "w2's job to start" has_remote 'sleep 303'
W2_SERVE=$(serve_children "$W2_LOOP")
[ -n "$W2_SERVE" ] || fail "w2's pi has no serve child"
kill -KILL "$W2_LOOP"
no_local_mule() { [ -z "$(local_mule)" ]; }
until_ok 100 "w2's serve child and pollers to exit after the caller died" no_local_mule
[ -n "$(remote_procs 'sleep 303')" ] || fail "the detached job died with its caller (it should outlive it)"
[ "$(running_jobs "$W2_PREFIX")" = 1 ] || fail "w2's job is not listed running"
[ "$(refusals)" = "$REFUSED0" ] || fail "sshd refused a session around the caller's death"
pass "caller died: serve child $W2_SERVE and every local mule process gone; the detached job outlives it"
close_agent w2 "$W2_TREE" "$W2_PREFIX"
[ -z "$(remote_procs 'sleep 303')" ] || fail "w2's remote sleep survived the close"

# ── C. nothing left ──────────────────────────────────────────────────────────
say "C. nothing stale"
STALE=()
for t in carrier_jobs agents host_channels effects remote_recovery; do
  n=$(count "$t")
  [ "$n" = 0 ] || STALE+=("$n $t row(s)")
done
n=$(mule_jobs | js "d.items.filter((j)=>j.state!=='done').length")
[ "$n" = 0 ] || STALE+=("$n mule job(s) not done: $(mule_jobs)")
remote_sessions
[ "$RSESS" = 0 ] || STALE+=("$RSESS remote tmux session(s)")
[ -z "$(ls -A "$R/lstate/mu5/sock/$WS" 2>/dev/null)" ] || STALE+=("local sockets: $(ls -A "$R/lstate/mu5/sock/$WS")")
[ "$(g -C "$RREPO" worktree list | wc -l | tr -d ' ')" = 1 ] || STALE+=("remote git worktrees: $(g -C "$RREPO" worktree list)")
[ "$(g -C "$LREPO" worktree list | wc -l | tr -d ' ')" = 1 ] || STALE+=("local git worktrees: $(g -C "$LREPO" worktree list)")
[ -z "$(local_mule)" ] || STALE+=("local mule processes")
[ ! -e "$R/trip.log" ] || STALE+=("PATH mule tripwire fired: $(cat "$R/trip.log")")
[ "$(refusals)" = "$REFUSED0" ] || STALE+=("sshd refused $(($(refusals) - REFUSED0)) session(s) during the run")
if [ ${#STALE[@]} -gt 0 ]; then
  printf '  stale: %s\n' "${STALE[@]}"
  fail "state left after the remote workspace run"
fi
pass "end: 0 rows in carrier_jobs/agents/host_channels/effects/remote_recovery, no live mule job, remote session, socket, worktree or mule process; the PATH tripwire never fired; sshd refused nothing after the cap test"
