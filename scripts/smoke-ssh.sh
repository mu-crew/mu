#!/usr/bin/env bash
# Operator smoke: supported SSH session templates, plus the example SSH pane plugin.
# Run `npm ci` first, then `bash scripts/smoke-ssh.sh` on a host that can run sshd.
# Builds mu, uses only 127.0.0.1 (sshd's default MaxSessions), and uses a private
# HOME, state, tmux server and repo on each side. Never picked up by vitest.
# Exit 0: both paths pass; 2: missing prerequisite; 1: smoke failed.
# SSHD can override /usr/sbin/sshd. SMOKE_KEEP=1 keeps the logs and fixtures.

set -Eeuo pipefail

fail() { printf 'smoke-ssh: FAIL: %s\n' "$*" >&2; exit 1; }
prereq() { printf 'smoke-ssh: PREREQUISITE MISSING: %s\n' "$*" >&2; exit 2; }
trap 'fail "line $LINENO (exit $?): $BASH_COMMAND"' ERR

# Look up executables under the caller's HOME, not the private one. A mise
# shim is itself executable, but won't find the selected tool under that HOME.
resolve() {
  local var=$1 bin=$2 path target resolved candidate
  if [[ $# = 3 ]]; then
    path=$3
    [[ $path = /* ]] || prereq "$bin needs an absolute executable path ($var=$path)"
  else
    path=$(type -P "$bin" || :)
    [[ -n $path ]] || prereq "$bin is not on PATH"
  fi
  [[ $path = /* ]] || path=$PWD/$path
  if [[ -n $mise && $path -ef $mise ]]; then
    target=$mise
  elif [[ -L $path ]]; then
    target=$("$READLINK" "$path" || exit $?) || prereq "readlink failed for $bin ($path)"
    [[ $target = /* ]] || target=${path%/*}/$target
    [[ ${target##*/} = mise ]] || target=
  else
    target=
  fi
  if [[ -n $target ]]; then
    if resolved=$("$target" which "$bin" 2>/dev/null || exit $?); then
      path=$resolved
    else
      # An inactive mise shim can fall through to a system tool on PATH.
      if [[ $# = 2 ]]; then
        while IFS= read -r candidate; do
          [[ $candidate -ef $target ]] && continue
          path=$candidate
          [[ $path = /* ]] || path=$PWD/$path
          break
        done < <(type -aP "$bin")
      fi
      if [[ $path -ef $target ]]; then
        "$target" which "$bin" >&2 || :
        prereq "mise could not resolve $bin ($target)"
      fi
    fi
  fi
  [[ $path = /* && -f $path && -x $path ]] || prereq "$bin is not an absolute executable ($path)"
  export "$var=$path"
}

mise=$(type -P mise || :)
READLINK=$(type -P readlink || :)
[[ -n $READLINK ]] || prereq 'readlink is not on PATH'
[[ $READLINK = /* ]] || READLINK=$PWD/$READLINK
export READLINK
for spec in BASH_BIN:bash NODE:node NPM:npm GIT:git UPLOAD_PACK:git-upload-pack \
    SSH:ssh SSH_KEYGEN:ssh-keygen TMUX_BIN:tmux JQ:jq PGREP:pgrep PKILL:pkill \
    DIRNAME:dirname ID:id MKTEMP:mktemp TR:tr TAIL:tail RM:rm MKDIR:mkdir \
    CHMOD:chmod CP:cp CAT:cat SLEEP:sleep LN:ln; do
  resolve "${spec%%:*}" "${spec#*:}"
done
SCRIPTS=$(cd "$("$DIRNAME" "${BASH_SOURCE[0]}")" && pwd -P)
REPO=${SCRIPTS%/*}
resolve SSHD sshd "${SSHD:-/usr/sbin/sshd}"
[[ -d $REPO/node_modules ]] || prereq 'run npm ci in the mu checkout'
LSOF=
if [[ ! -d /proc/self ]]; then
  resolve LSOF lsof
fi
LOGIN=$("$ID" -un)
R=$("$MKTEMP" -d /tmp/musshXXXXXX)
R=$(cd "$R" && pwd -P)
WS=${R##*/}
WS=$(printf '%s' "$WS" | "$TR" '[:upper:]' '[:lower:]')-$$
RSOCK_DIR=/tmp/mu-$("$ID" -u)/$WS
SSHD_PID=
CURRENT_AGENT=

# Keep diagnostics out of command substitutions and redirected JSON output.
report_failure() {
  local pane log
  while IFS= read -r pane; do
    printf '\n--- tmux pane %s ---\n' "$pane"
    "$TMUX_BIN" -L "$WS" capture-pane -p -t "$pane" -S -30 || :
  done < <("$TMUX_BIN" -L "$WS" list-panes -s -t "mu-$WS" -F '#{pane_id}' 2>/dev/null)
  # A vanished pane cannot be captured. Its pipe log outlives it.
  for log in "$R"/pane-*.log; do
    [[ -s $log ]] || continue
    printf '\n--- %s (tail) ---\n' "${log##*/}"
    "$TAIL" -n 30 "$log"
  done
  if [[ -n $CURRENT_AGENT ]]; then
    printf '\n--- mu agent read %s ---\n' "$CURRENT_AGENT"
    "$NODE" "$REPO/dist/cli.js" agent read "$CURRENT_AGENT" -w "$WS" -n 30 || :
  fi
  if [[ -s $R/sshd.log ]]; then
    printf '\n--- sshd.log (tail) ---\n'
    "$TAIL" -n 20 "$R/sshd.log"
  fi
}

cleanup() {
  local rc=$?
  trap - EXIT ERR INT TERM HUP
  set +e
  if [[ $rc = 1 ]]; then report_failure >&2; fi
  "$TMUX_BIN" -L "$WS" kill-server 2>/dev/null
  # Both patterns identify only this run, even if close never got to stop.
  "$PKILL" -TERM -f -- "$R/ssh_config" 2>/dev/null
  "$PKILL" -TERM -f -- "$R/rbin/smoke-fake-pi.mjs" 2>/dev/null
  if [[ -n $SSHD_PID ]]; then
    kill "$SSHD_PID" 2>/dev/null
    wait "$SSHD_PID" 2>/dev/null
  fi
  "$PKILL" -KILL -f -- "$R/ssh_config" 2>/dev/null
  "$PKILL" -KILL -f -- "$R/rbin/smoke-fake-pi.mjs" 2>/dev/null
  "$RM" -rf -- "$RSOCK_DIR"
  if [[ ${SMOKE_KEEP:-0} = 1 ]]; then printf 'smoke-ssh: kept %s\n' "$R" >&2; else "$RM" -rf -- "$R"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'fail interrupted' INT TERM HUP

# A caller in a mu pane must not bring its identity, DB or git overrides.
while IFS= read -r v; do
  case $v in MU_*|PI_*|GIT_*|TMUX|TMUX_PANE|SSH_AUTH_SOCK|BASH_ENV|ENV|CDPATH) unset "$v" ;; esac
done < <(compgen -e)
"$MKDIR" -p "$R"/{bin,rbin,home,rhome,state,tmp,tmux}
"$CHMOD" 700 "$R/tmux"
# Child programs (mu, npm, the plugin and remote Git) also look up tools by name.
"$LN" -s "$BASH_BIN" "$R/bin/bash"
"$LN" -s "$NODE" "$R/bin/node"
"$LN" -s "$NPM" "$R/bin/npm"
"$LN" -s "$TMUX_BIN" "$R/bin/tmux"
"$LN" -s "$GIT" "$R/bin/git"
"$LN" -s "$GIT" "$R/rbin/git"
"$LN" -s "$UPLOAD_PACK" "$R/rbin/git-upload-pack"
if [[ -n $LSOF ]]; then "$LN" -s "$LSOF" "$R/bin/lsof"; "$LN" -s "$LSOF" "$R/rbin/lsof"; fi
export HOME="$R/home" TMPDIR="$R/tmp" TMUX_TMPDIR="$R/tmux"
export XDG_CONFIG_HOME="$R/config" XDG_STATE_HOME="$R/xdg" XDG_CACHE_HOME="$R/cache"
export MU_STATE_DIR="$R/state" MU_DB_PATH="$R/state/mu.db" MU_SYNC_DIR=""
export MU_TMUX_SOCKET="$WS" MU_MUX=tmux MURMUR_STATE_DIR="$R/murmur"
export MU_SSH_STATE_DIR="$R/jobs"
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@localhost
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
export GIT_SSH_COMMAND="$R/bin/ssh"

# Short paths keep both forwarded sockets below the Unix socket length limit.
if ! PORT=$("$NODE" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})' 2>"$R/bind.err" || exit $?); then
  "$TAIL" -n 8 "$R/bind.err" >&2
  prereq "node ($NODE) failed the loopback TCP listener probe"
fi
"$SSH_KEYGEN" -q -t ed25519 -N '' -f "$R/hostkey"
"$SSH_KEYGEN" -q -t ed25519 -N '' -f "$R/id"
"$CP" "$R/id.pub" "$R/authorized_keys"
read -r key_type key_blob _ <"$R/hostkey.pub"
printf '[127.0.0.1]:%s %s %s\n' "$PORT" "$key_type" "$key_blob" >"$R/known_hosts"
# Use a real login Bash for the harness probe and pane, but load no rc files
# that could replace the private HOME/PATH (including /etc/profile).
printf '#!/bin/sh\nexec "%s" --noprofile --norc "$@"\n' "$BASH_BIN" >"$R/rbin/shell"
"$CP" "$SCRIPTS/smoke-fake-pi.mjs" "$R/rbin/"
printf '#!/bin/sh\nexec "%s" "%s/rbin/smoke-fake-pi.mjs" "$@"\n' "$NODE" "$R" >"$R/rbin/pi"
"$CHMOD" +x "$R/rbin/shell" "$R/rbin/pi"
"$CAT" >"$R/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $R/hostkey
PidFile $R/sshd.pid
AuthorizedKeysFile $R/authorized_keys
AllowUsers $LOGIN
UsePAM no
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowStreamLocalForwarding yes
SetEnv HOME=$R/rhome SHELL=$R/rbin/shell PATH=$R/rbin:/usr/bin:/bin XDG_STATE_HOME=$R/rhome/.local/state GIT_CONFIG_NOSYSTEM=1
EOF
"$CAT" >"$R/ssh_config" <<EOF
Host session example
  HostName 127.0.0.1
  Port $PORT
  User $LOGIN
  IdentityFile $R/id
  IdentitiesOnly yes
  BatchMode yes
  ConnectTimeout 2
  ControlMaster no
  ControlPath none
  StrictHostKeyChecking yes
  UserKnownHostsFile $R/known_hosts
EOF
printf '#!/bin/sh\nexec "%s" -F "%s/ssh_config" "$@"\n' "$SSH" "$R" >"$R/bin/ssh"
"$CHMOD" +x "$R/bin/ssh"
export PATH="$R/bin:$PATH"

"$SSHD" -D -e -f "$R/sshd_config" >"$R/sshd.log" 2>&1 &
SSHD_PID=$!
ready=0
for ((i=0; i<30; i++)); do
  if "$R/bin/ssh" session true 2>"$R/ssh.err"; then ready=1; break; fi
  kill -0 "$SSHD_PID" 2>/dev/null || break
  "$SLEEP" 0.1
done
if [[ $ready != 1 ]]; then
  "$TAIL" -n 20 "$R/sshd.log" >&2
  "$TAIL" -n 5 "$R/ssh.err" >&2
  if ! kill -0 "$SSHD_PID" 2>/dev/null; then
    prereq "sshd ($SSHD) did not stay running (see diagnostics above)"
  fi
  prereq "ssh ($SSH) could not log in to the private loopback sshd ($SSHD; see diagnostics above)"
fi
# Expand these variables on the remote side, not in this shell.
# shellcheck disable=SC2016
[[ $("$R/bin/ssh" session 'printf "%s:%s" "$HOME" "$SHELL"') = "$R/rhome:$R/rbin/shell" ]] ||
  fail 'sshd did not install the private remote environment'

(cd "$REPO" && "$NPM" run build --silent) >"$R/build.log" 2>&1 || {
  "$TAIL" -n 30 "$R/build.log" >&2
  fail "npm ($NPM) run build"
}
mu() {
  local step=$1 out rc
  shift
  out=$("$MKTEMP" "$R/mu-output.XXXXXX")
  if "$NODE" "$REPO/dist/cli.js" "$@" >"$out" 2>"$out.err"; then
    "$CAT" "$out"
    "$CAT" "$out.err" >&2
    "$RM" -f -- "$out" "$out.err"
  else
    rc=$?
    {
      printf 'smoke-ssh: FAIL: %s (mu exit %s): mu' "$step" "$rc"
      printf ' %q' "$@"
      printf '\n--- stdout ---\n'
      "$CAT" "$out"
      printf '\n--- stderr ---\n'
      "$CAT" "$out.err"
    } >&2
    return "$rc"
  fi
}
sql() { mu "$1" sql "$2" | "$JQ" -er "$3"; }

"$GIT" init -q "$R/local"
cd "$R/local"
"$GIT" commit -q --allow-empty -m 'smoke base'
RREPO="$R/rhome/repo"
"$GIT" clone -q --local . "$RREPO"
mu 'init workstream' workstream init "$WS" >/dev/null
"$TMUX_BIN" -L "$WS" set-hook -t "mu-$WS" after-new-window \
  "pipe-pane -o '\"$CAT\" >>\"$R/pane-#{pane_id}.log\"'"

# No multiplexed SSH master: the pane owns the forward. Check and collect
# have a spare channel while it lives. These are the session starter templates.
mu 'register session host' host add session --transport session --max-sessions 2 \
  --shell "ssh -o ControlMaster=no -o ControlPath=none -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L {local_sock}:{remote_sock} session -t 'cd {cwd:sh} && {env} \"\$SHELL\" -ilc {cmd:sh}'" \
  --exec 'ssh -o BatchMode=yes session {cmd}' \
  --fetch 'git fetch ssh://session{cwd} HEAD' >/dev/null
mu 'check session host' host check session --root "$RREPO" --json >"$R/check.json"
"$JQ" -e '.data.steps | any(.step == "extension" and .ok == true)' "$R/check.json" >/dev/null ||
  fail 'host check did not verify the fake pi extension'

spawn_turn() {
  local host=$1 agent=$2 text="smoke-$2-$$-$RANDOM" runs inc
  shift 2
  CURRENT_AGENT=$agent
  LOCAL_SOCK="$R/state/sock/$WS/$agent.sock"
  REMOTE_SOCK="$RSOCK_DIR/$agent.sock"
  mu "$host: spawn $agent" agent spawn "$agent" -w "$WS" --cli pi --host "$host" "$@" --json >"$R/spawn-$agent.json"
  "$JQ" -e '.data.ctl == "ok"' "$R/spawn-$agent.json" >/dev/null || fail "$host: ctl handshake failed"
  if [[ ! -S $LOCAL_SOCK || ! -S $REMOTE_SOCK ]] || ! forward_alive; then
    fail "$host: expected a live SSH forward"
  fi
  mu "$host: send to $agent" agent send "$agent" -w "$WS" "$text" --json >"$R/send-$agent.json"
  runs=$("$JQ" -er '.data | select(.transport == "ctl" and .delivered) | .runs' "$R/send-$agent.json")
  inc=$("$JQ" -er '.data.incarnation' "$R/send-$agent.json")
  mu "$host: wait for $agent turn" wait "agent:$WS/$agent@$runs#$inc" --timeout 30 --json >"$R/turn-$agent.json"
  # jq expands its own variables, not Bash.
  # shellcheck disable=SC2016
  "$JQ" -e --arg echo "smoke-echo: $text" --argjson runs "$((runs + 1))" '
    .data.firing.kind == "settled" and
    (.data.snapshots | any(.settled == true and .runs == $runs and .lastText == $echo))
  ' "$R/turn-$agent.json" >/dev/null || fail "$host: wait did not return the settled echo"
}

forward_alive() { "$PGREP" -f -- "-L $LOCAL_SOCK:$REMOTE_SOCK" >/dev/null; }
closed_clean() {
  local agent=$1 rev rows
  rev=$(mu "preview close of $agent" agent close "$agent" -w "$WS" --json | "$JQ" -er '.data.revision')
  mu "close $agent" agent close "$agent" -w "$WS" --if "$rev" --json >"$R/close-$agent.json"
  # The remote pi can receive the hangup a little after the local pane dies.
  for ((i=0; i<50; i++)); do
    if [[ ! -e $REMOTE_SOCK ]] && ! forward_alive; then break; fi
    "$SLEEP" 0.1
  done
  [[ ! -e $LOCAL_SOCK && ! -e $REMOTE_SOCK ]] || fail "$agent: close left ctl sockets"
  if forward_alive; then fail "$agent: close left a live SSH forward"; fi
  rows=$(sql "check state after closing $agent" 'SELECT (SELECT count(*) FROM agents) + (SELECT count(*) FROM carrier_jobs) +
    (SELECT count(*) FROM host_channels) + (SELECT count(*) FROM worktrees) +
    (SELECT count(*) FROM remote_recovery) AS n' '.data.items[0].n')
  [[ $rows = 0 ]] || fail "$agent: close left $rows agent, job, channel, worktree or recovery rows"
  CURRENT_AGENT=
}

spawn_turn session worker --worktree --root "$RREPO"
WT="$R/rhome/.local/state/mu-next/remote-worktrees/$WS/worker"
# Collect a commit that did not exist locally, not just the already shared base.
mu 'make remote commit' host exec session -- git -C "$WT" -c user.name=smoke -c user.email=smoke@localhost \
  commit -q --allow-empty -m 'remote smoke result'
head=$(mu 'read remote HEAD' host exec session -- git -C "$WT" rev-parse HEAD)
if "$GIT" cat-file -e "$head^{commit}" 2>/dev/null; then fail 'collect fixture is already local'; fi
mu 'collect remote commit' agent collect worker -w "$WS" --json >"$R/collect.json"
[[ $("$GIT" rev-parse "refs/mu/collect/$WS/worker") = "$head" ]] || fail 'collect did not pin remote HEAD'
collected=$(sql 'read collected HEAD' "SELECT collected_head FROM agents WHERE name='worker'" '.data.items[0].collected_head')
[[ $collected = "$head" ]] ||
  fail 'collect did not record remote HEAD'
closed_clean worker
trees=$("$GIT" -C "$RREPO" worktree list --porcelain)
[[ ! -e $WT && $trees != *"$WT"* ]] || fail 'close left the remote worktree'
printf 'PASS session templates: host check, forwarded ctl turn, collect, clean close\n'

mu 'register SSH example plugin' plugin add ssh -- "$REPO/examples/plugins/mu-plugin-ssh" "$R/bin/ssh" >/dev/null
mu 'register example host' host add example --plugin ssh --max-sessions 2 >/dev/null
spawn_turn example demo --cwd "$RREPO"
handle=$(sql 'read example job handle' "SELECT job FROM carrier_jobs WHERE name='demo'" '.data.items[0].job')
job=${handle%%@*}
[[ $job =~ ^ssh-[0-9a-f]{32}$ && -s $R/jobs/$job/pid ]] || fail 'example: no started job for the recorded handle'
# Close must get the plugin's handle-bound stop receipt before removing the row.
# Its stopped marker is intentional: a delayed view must not launch this job.
closed_clean demo
[[ -f $R/jobs/$job/stopped ]] || fail 'example: close made no stop record for the job'
printf 'PASS example SSH pane plugin: forwarded ctl turn, stop with receipt, clean close\n'
