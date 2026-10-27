#!/usr/bin/env bash
# Launch one TUI dogfood scenario: seed an isolated DB (+ fake workers on a private tmux
# socket), then run the checkout's `mu` with no args in THIS terminal. See README.md.
#   ./run.sh <1..7>        fresh seed, launch, clean up on quit
#   ./run.sh <N> --keep    reuse the last seed of N (workers are re-spawned only on a fresh seed)
#   ./run.sh list | clean
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${MU_DOGFOOD_REPO:-$(cd "$HERE/../../../.." && pwd)}"
ROOT="${MU_DOGFOOD_DIR:-/var/tmp/mu-dogfood}"
SOCK_OVERRIDE="${MU_DOGFOOD_SOCKET:-}" # a private server name, to keep parallel runs apart

NAMES=(
  [1]="empty: first run, nothing in the DB"
  [2]="small healthy crew: 2 workstreams, 4 workers, a DAG with blockers"
  [3]="delegate wave: finished with verdicts, mid-flight, queued, refused"
  [4]="trouble: dead, stalled and blocked workers, a human-needed, a malformed CLOSE"
  [5]="big: 200 tasks, 10 agents, long/wide/ANSI titles, 60-note task, long workstream names"
  [6]="live: 3 fake workers + a mutator change state every few seconds"
  [7]="remote: one agent on a simulated remote host next to a local one"
)

# Where the dashboard opens (else mu picks the most recently active workstream).
START=([2]=shop-api [3]=hail-cache [4]=payments [5]=monorepo [6]=live-demo [7]=remote-demo)

if [ "${1:-}" = list ] || [ $# -eq 0 ]; then
  for n in 1 2 3 4 5 6 7; do printf '  %s  %s\n' "$n" "${NAMES[$n]}"; done
  exit 0
fi
if [ "$1" = clean ]; then
  for d in "$ROOT"/s*; do
    [ -d "$d" ] || continue
    tmux -L "mudf-${d##*/s}" kill-server 2>/dev/null || true
  done
  rm -rf "$ROOT"
  echo "removed $ROOT"
  exit 0
fi

N="$1"; KEEP="${2:-}"
[[ "$N" =~ ^[1-7]$ ]] || { echo "usage: $0 <1..7> [--keep] | list | clean" >&2; exit 2; }
[ -f "$REPO/dist/cli.js" ] || { echo "no $REPO/dist/cli.js: run 'npm install && npm run build' in $REPO first" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is needed (the fake workers run in a private tmux server)" >&2; exit 1; }

# Isolation: drop every inherited MU_*/PI_SESSION_ID and the outer pane id, then point at this
# scenario only. $TMUX stays: mu sees it names another server than -L mudf-N, so `a` opens a
# deliberately nested client and says how to detach (C-b C-b d).
for v in $(env | grep -E '^(MU_|PI_SESSION_ID)' | cut -d= -f1); do unset "$v"; done
unset TMUX_PANE
D="$ROOT/s$N"
SOCK="${SOCK_OVERRIDE:-mudf-$N}"
export MU_DB_PATH="$D/mu.db" MU_STATE_DIR="$D" MU_SYNC_DIR= MU_TMUX_SOCKET="$SOCK" MU_MUX=tmux
export MU_SPAWN_LIVENESS_MS=0 MU_DOGFOOD_REPO="$REPO"
MU=(node "$REPO/dist/cli.js")

stop() {
  [ -n "${DRIVER:-}" ] && kill "$DRIVER" 2>/dev/null || true
  tmux -L "$SOCK" kill-server 2>/dev/null || true # the private server only; never the default one
}
trap stop EXIT
trap 'exit 130' INT TERM HUP

if [ "$KEEP" != --keep ] || [ ! -f "$MU_DB_PATH" ]; then
  tmux -L "$SOCK" kill-server 2>/dev/null || true
  rm -rf "$D"; mkdir -p "$D"
  # The private server first, with a roomy scrollback for Enter-scrollback.
  tmux -L "$SOCK" -f /dev/null new-session -d -s mudf-base -x 200 -y 50 \; set -g history-limit 5000
  echo "seeding scenario $N: ${NAMES[$N]} ..." >&2
  node "$HERE/scenarios.mjs" "$N" >"$D/seed.log" 2>&1 || { echo "seeding failed:" >&2; tail -20 "$D/seed.log" >&2; exit 1; }
fi
if [ "$N" = 6 ]; then
  node "$HERE/scenarios.mjs" driver >"$D/driver.log" 2>&1 &
  DRIVER=$!
fi

cat >&2 <<MSG
scenario $N: ${NAMES[$N]}
  DB      $MU_DB_PATH   (isolated; your real mu state is untouched)
  panes   tmux -L $SOCK attach   (from ANOTHER terminal, to look at the fake workers' panes)
  quit    q   (the private tmux server and fake workers are then removed)
MSG
sleep 1
"${MU[@]}" ${START[$N]:+-w "${START[$N]}"}
