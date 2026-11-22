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

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(dirname "$SCRIPTS")
SSHD=${SSHD:-/usr/sbin/sshd}
for c in bash node npm git ssh ssh-keygen tmux jq pgrep pkill; do
  command -v "$c" >/dev/null || prereq "$c is not on PATH"
done
[[ $SSHD = /* && -x $SSHD ]] || prereq "sshd needs an absolute executable path (SSHD=$SSHD)"
[[ -d $REPO/node_modules ]] || prereq 'run npm ci in the mu checkout'
if [[ ! -d /proc/self ]]; then
  command -v lsof >/dev/null || prereq 'worktree close requires /proc or lsof'
fi
NODE=$(command -v node)
SSH=$(command -v ssh)
BASH_BIN=$(command -v bash)
LOGIN=$(id -un)
R=$(mktemp -d /tmp/musshXXXXXX)
R=$(cd "$R" && pwd -P)
WS=${R##*/}
WS=$(printf '%s' "$WS" | tr '[:upper:]' '[:lower:]')-$$
RSOCK_DIR=/tmp/mu-$(id -u)/$WS
SSHD_PID=

cleanup() {
  local rc=$?
  trap - EXIT ERR INT TERM HUP
  set +e
  if [[ $rc = 1 ]]; then
    tmux -L "$WS" capture-pane -pt "mu-$WS" -S -30 2>/dev/null
    if [[ -s $R/sshd.log ]]; then tail -n 20 "$R/sshd.log" >&2; fi
  fi
  tmux -L "$WS" kill-server 2>/dev/null
  # Both patterns identify only this run, even if close never got to stop.
  pkill -TERM -f -- "$R/ssh_config" 2>/dev/null
  pkill -TERM -f -- "$R/rbin/smoke-fake-pi.mjs" 2>/dev/null
  if [[ -n $SSHD_PID ]]; then
    kill "$SSHD_PID" 2>/dev/null
    wait "$SSHD_PID" 2>/dev/null
  fi
  pkill -KILL -f -- "$R/ssh_config" 2>/dev/null
  pkill -KILL -f -- "$R/rbin/smoke-fake-pi.mjs" 2>/dev/null
  rm -rf -- "$RSOCK_DIR"
  if [[ ${SMOKE_KEEP:-0} = 1 ]]; then printf 'smoke-ssh: kept %s\n' "$R"; else rm -rf -- "$R"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'fail interrupted' INT TERM HUP

# A caller in a mu pane must not bring its identity, DB or git overrides.
while IFS= read -r v; do
  case $v in MU_*|PI_*|GIT_*|TMUX|TMUX_PANE|SSH_AUTH_SOCK|BASH_ENV|ENV|CDPATH) unset "$v" ;; esac
done < <(compgen -e)
mkdir -p "$R"/{bin,rbin,home,rhome,state,tmp,tmux}
chmod 700 "$R/tmux"
export HOME="$R/home" TMPDIR="$R/tmp" TMUX_TMPDIR="$R/tmux"
export XDG_CONFIG_HOME="$R/config" XDG_STATE_HOME="$R/xdg" XDG_CACHE_HOME="$R/cache"
export MU_STATE_DIR="$R/state" MU_DB_PATH="$R/state/mu.db" MU_SYNC_DIR=""
export MU_TMUX_SOCKET="$WS" MU_MUX=tmux MURMUR_STATE_DIR="$R/murmur"
export MU_SSH_STATE_DIR="$R/jobs"
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@localhost
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
export GIT_SSH_COMMAND="$R/bin/ssh"

# Short paths keep both forwarded sockets below the Unix socket length limit.
PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})' 2>"$R/bind.err") || {
  tail -n 8 "$R/bind.err" >&2
  prereq 'cannot bind a loopback TCP listener'
}
ssh-keygen -q -t ed25519 -N '' -f "$R/hostkey"
ssh-keygen -q -t ed25519 -N '' -f "$R/id"
cp "$R/id.pub" "$R/authorized_keys"
read -r key_type key_blob _ <"$R/hostkey.pub"
printf '[127.0.0.1]:%s %s %s\n' "$PORT" "$key_type" "$key_blob" >"$R/known_hosts"
# Use a real login Bash for the harness probe and pane, but load no rc files
# that could replace the private HOME/PATH (including /etc/profile).
printf '#!/bin/sh\nexec "%s" --noprofile --norc "$@"\n' "$BASH_BIN" >"$R/rbin/shell"
cp "$SCRIPTS/smoke-fake-pi.mjs" "$R/rbin/"
printf '#!/bin/sh\nexec "%s" "%s/rbin/smoke-fake-pi.mjs" "$@"\n' "$NODE" "$R" >"$R/rbin/pi"
chmod +x "$R/rbin/shell" "$R/rbin/pi"
cat >"$R/sshd_config" <<EOF
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
cat >"$R/ssh_config" <<EOF
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
chmod +x "$R/bin/ssh"
export PATH="$R/bin:$PATH"

"$SSHD" -D -e -f "$R/sshd_config" >"$R/sshd.log" 2>&1 &
SSHD_PID=$!
ready=0
for ((i=0; i<30; i++)); do
  if ssh session true 2>"$R/ssh.err"; then ready=1; break; fi
  kill -0 "$SSHD_PID" 2>/dev/null || break
  sleep 0.1
done
if [[ $ready != 1 ]]; then
  tail -n 20 "$R/sshd.log" >&2
  tail -n 5 "$R/ssh.err" >&2
  prereq 'cannot start or log in to a private loopback sshd (see diagnostics above)'
fi
[[ $(ssh session 'printf "%s:%s" "$HOME" "$SHELL"') = "$R/rhome:$R/rbin/shell" ]] ||
  fail 'sshd did not install the private remote environment'

(cd "$REPO" && npm run build --silent) >"$R/build.log" 2>&1 || {
  tail -n 30 "$R/build.log" >&2
  fail 'npm run build'
}
mu() { "$NODE" "$REPO/dist/cli.js" "$@"; }
sql() { mu sql "$1" | jq -er "$2"; }

git init -q "$R/local"
cd "$R/local"
git commit -q --allow-empty -m 'smoke base'
RREPO="$R/rhome/repo"
git clone -q --local . "$RREPO"
mu workstream init "$WS" >/dev/null

# No multiplexed SSH master: the pane owns the forward. Check and collect
# have a spare channel while it lives. These are the session starter templates.
mu host add session --transport session --max-sessions 2 \
  --shell "ssh -o ControlMaster=no -o ControlPath=none -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L {local_sock}:{remote_sock} session -t 'cd {cwd:sh} && {env} \"\$SHELL\" -ilc {cmd:sh}'" \
  --exec 'ssh -o BatchMode=yes session {cmd}' \
  --fetch 'git fetch ssh://session{cwd} HEAD' >/dev/null
mu host check session --root "$RREPO" --json >"$R/check.json"
jq -e '.data.steps | any(.step == "extension" and .ok == true)' "$R/check.json" >/dev/null ||
  fail 'host check did not verify the fake pi extension'

spawn_turn() {
  local host=$1 agent=$2 text="smoke-$2-$$-$RANDOM" runs inc
  shift 2
  LOCAL_SOCK="$R/state/sock/$WS/$agent.sock"
  REMOTE_SOCK="$RSOCK_DIR/$agent.sock"
  mu agent spawn "$agent" -w "$WS" --cli pi --host "$host" "$@" --json >"$R/spawn-$agent.json"
  jq -e '.data.ctl == "ok"' "$R/spawn-$agent.json" >/dev/null || fail "$host: ctl handshake failed"
  if [[ ! -S $LOCAL_SOCK || ! -S $REMOTE_SOCK ]] || ! forward_alive; then
    fail "$host: expected a live SSH forward"
  fi
  mu agent send "$agent" -w "$WS" "$text" --json >"$R/send-$agent.json"
  runs=$(jq -er '.data | select(.transport == "ctl" and .delivered) | .runs' "$R/send-$agent.json")
  inc=$(jq -er '.data.incarnation' "$R/send-$agent.json")
  mu wait "agent:$WS/$agent@$runs#$inc" --timeout 30 --json >"$R/turn-$agent.json"
  jq -e --arg echo "smoke-echo: $text" --argjson runs "$((runs + 1))" '
    .data.firing.kind == "settled" and
    (.data.snapshots | any(.settled == true and .runs == $runs and .lastText == $echo))
  ' "$R/turn-$agent.json" >/dev/null || fail "$host: wait did not return the settled echo"
}

forward_alive() { pgrep -f -- "-L $LOCAL_SOCK:$REMOTE_SOCK" >/dev/null; }
closed_clean() {
  local agent=$1 rev rows
  rev=$(mu agent close "$agent" -w "$WS" --json | jq -er '.data.revision')
  mu agent close "$agent" -w "$WS" --if "$rev" --json >"$R/close-$agent.json"
  # The remote pi can receive the hangup a little after the local pane dies.
  for ((i=0; i<50; i++)); do
    if [[ ! -e $REMOTE_SOCK ]] && ! forward_alive; then break; fi
    sleep 0.1
  done
  [[ ! -e $LOCAL_SOCK && ! -e $REMOTE_SOCK ]] || fail "$agent: close left ctl sockets"
  if forward_alive; then fail "$agent: close left a live SSH forward"; fi
  rows=$(sql 'SELECT (SELECT count(*) FROM agents) + (SELECT count(*) FROM carrier_jobs) +
    (SELECT count(*) FROM host_channels) + (SELECT count(*) FROM worktrees) +
    (SELECT count(*) FROM remote_recovery) AS n' '.data.items[0].n')
  [[ $rows = 0 ]] || fail "$agent: close left $rows agent, job, channel, worktree or recovery rows"
}

spawn_turn session worker --worktree --root "$RREPO"
WT="$R/rhome/.local/state/mu-next/remote-worktrees/$WS/worker"
# Collect a commit that did not exist locally, not just the already shared base.
mu host exec session -- git -C "$WT" -c user.name=smoke -c user.email=smoke@localhost \
  commit -q --allow-empty -m 'remote smoke result'
head=$(mu host exec session -- git -C "$WT" rev-parse HEAD)
if git cat-file -e "$head^{commit}" 2>/dev/null; then fail 'collect fixture is already local'; fi
mu agent collect worker -w "$WS" --json >"$R/collect.json"
[[ $(git rev-parse "refs/mu/collect/$WS/worker") = "$head" ]] || fail 'collect did not pin remote HEAD'
[[ $(sql "SELECT collected_head FROM agents WHERE name='worker'" '.data.items[0].collected_head') = "$head" ]] ||
  fail 'collect did not record remote HEAD'
closed_clean worker
trees=$(git -C "$RREPO" worktree list --porcelain)
[[ ! -e $WT && $trees != *"$WT"* ]] || fail 'close left the remote worktree'
printf 'PASS session templates: host check, forwarded ctl turn, collect, clean close\n'

mu plugin add ssh-example -- "$REPO/examples/plugins/mu-plugin-ssh" "$R/bin/ssh" >/dev/null
mu host add example --plugin ssh-example --max-sessions 2 >/dev/null
spawn_turn example demo --cwd "$RREPO"
handle=$(sql "SELECT job FROM carrier_jobs WHERE name='demo'" '.data.items[0].job')
job=${handle%%@*}
[[ $job =~ ^ssh-[0-9a-f]{32}$ && -s $R/jobs/$job/pid ]] || fail 'example: no started job for the recorded handle'
# Close must get the plugin's handle-bound stop receipt before removing the row.
# Its stopped marker is intentional: a delayed view must not launch this job.
closed_clean demo
[[ -f $R/jobs/$job/stopped ]] || fail 'example: close made no stop record for the job'
printf 'PASS example SSH pane plugin: forwarded ctl turn, stop with receipt, clean close\n'
