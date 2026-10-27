#!/usr/bin/env bash
# Draft capture of the README dashboard screenshot (docs/img/tui-dashboard.png).
#   tools/screenshot/dashboard.sh [out.png] [cols] [rows]     (needs dist/, tmux, python3 + Pillow)
# Scene: TUI dogfood scenario 4 ("payments": a dead, a stalled and a blocked worker, a
# human-needed task) on the Overview tab. Everything is isolated: private tmux socket,
# throwaway DB under /var/tmp/mu-dogfood, no sync dir. To look at the scene live instead:
#   docs/mu-next/tui-dogfood/run.sh 4
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$REPO/docs/img/tui-dashboard.png}"
COLS="${2:-200}"
ROWS="${3:-40}"
SOCK="readme-shot-$$"
ANSI="$(mktemp)"
trap 'tmux -L "$SOCK" kill-server 2>/dev/null || true; rm -f "$ANSI"; "$REPO/docs/mu-next/tui-dogfood/run.sh" clean >/dev/null' EXIT
tmux -L "$SOCK" -f /dev/null new-session -d -s shot -x "$COLS" -y "$ROWS" \
  "env -u TMUX -u TMUX_PANE MU_DOGFOOD_REPO='$REPO' '$REPO/docs/mu-next/tui-dogfood/run.sh' 4; sleep 5"
for _ in $(seq 60); do # wait for the first full frame
  sleep 1
  tmux -L "$SOCK" capture-pane -p -t shot | grep -q 'Attention' && break
done
sleep 2
tmux -L "$SOCK" capture-pane -e -p -t shot >"$ANSI"
mkdir -p "$(dirname "$OUT")"
python3 "$HERE/ansi-to-png.py" "$ANSI" "$OUT" --cols "$COLS" --rows "$ROWS"
