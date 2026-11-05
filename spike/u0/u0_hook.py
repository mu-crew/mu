#!/usr/bin/env python3
"""U0 logging hook: `u0_hook.py <harness> <event>`, payload on stdin.

Appends one JSON record per call to ~/u0-logs/<harness>.jsonl and to
/tmp/u0-logs/<harness>.jsonl (whichever the harness sandbox allows). It
records the payload, the environment mu-crew cares about, the process chain
up to the tmux server, and whether the hook can write each crew state
directory and reach tmux. It prints nothing and exits 0, except for the
one-shot Stop block test (flag file /tmp/u0-block-once-<harness>).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ENV_PREFIXES = ("TMUX", "MU_", "CLAUDE", "CODEX", "CURSOR", "MUSE", "META_3PAI", "PI_")
ENV_EXACT = ("PATH", "HOME", "XDG_STATE_HOME", "SHELL", "PWD")
STATE_DIRS = ("murmur", "museum", "mu-next", "muzzle")
BLOCK_REASON = "U0 block test: reply with exactly BLOCKED-OK"


def process_chain() -> list[dict]:
    try:
        out = subprocess.run(
            ["ps", "-A", "-o", "pid=,ppid=,args="],
            capture_output=True,
            text=True,
            timeout=3,
        ).stdout
    except Exception as e:  # noqa: BLE001 - a hook must never fail
        return [{"error": repr(e)}]
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), parts[2] if len(parts) > 2 else "")
    tmux_pid = None
    tmux = os.environ.get("TMUX", "")
    if tmux.count(",") >= 2:
        try:
            tmux_pid = int(tmux.split(",")[1])
        except ValueError:
            pass
    chain, pid = [], os.getpid()
    while pid in table and len(chain) < 40:
        ppid, args = table[pid]
        chain.append({"pid": pid, "args": args[:300], "tmux_server": pid == tmux_pid})
        if pid == tmux_pid or pid <= 1:
            break
        pid = ppid
    return chain


def probe_dirs() -> dict:
    base = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    result = {}
    for name in STATE_DIRS:
        d = base / name
        f = d / f".u0-probe-{os.getpid()}"
        try:
            d.mkdir(parents=True, exist_ok=True)
            f.write_text("x")
            f.unlink()
            result[name] = "ok"
        except Exception as e:  # noqa: BLE001
            result[name] = repr(e)[:200]
    return result


def probe_tmux() -> dict:
    if not os.environ.get("TMUX"):
        return {"skipped": "no $TMUX"}
    try:
        r = subprocess.run(
            ["tmux", "display", "-p", "#{pid} #{socket_path}"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        return {
            "rc": r.returncode,
            "out": r.stdout.strip(),
            "err": r.stderr.strip()[:200],
        }
    except Exception as e:  # noqa: BLE001
        return {"error": repr(e)[:200]}


def transcript_tail(payload: dict) -> dict | None:
    path = payload.get("transcript_path") if isinstance(payload, dict) else None
    if not path:
        return None
    try:
        lines = Path(path).read_text(errors="replace").splitlines()[-60:]
    except Exception as e:  # noqa: BLE001
        return {"error": repr(e)[:200]}
    last = None
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("type") == "assistant":
            msg = rec.get("message", {})
            texts = [
                c.get("text", "")
                for c in msg.get("content", [])
                if isinstance(c, dict) and c.get("type") == "text"
            ]
            if any(texts):
                last = {
                    "timestamp": rec.get("timestamp"),
                    "text": " ".join(texts)[:300],
                }
                break
    return {"last_assistant": last, "lines": len(lines)}


def block_once(harness: str, event: str) -> str | None:
    if event.lower() != "stop":
        return None
    flag = Path(f"/tmp/u0-block-once-{harness}")
    try:
        flag.unlink()
    except FileNotFoundError:
        return None
    except Exception:  # noqa: BLE001
        return None
    if harness == "cursor":
        return json.dumps({"followup_message": BLOCK_REASON})
    return json.dumps({"decision": "block", "reason": BLOCK_REASON})


def write(path: Path, record: dict) -> str:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as fh:
            fh.write(json.dumps(record) + "\n")
        return "ok"
    except Exception as e:  # noqa: BLE001
        return repr(e)[:200]


def main() -> int:
    t0 = time.monotonic()
    harness = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    event = sys.argv[2] if len(sys.argv) > 2 else "unknown"
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        payload = json.loads(raw) if raw.strip() else None
    except ValueError:
        payload = {"_raw": raw[:4000]}
    env = {
        k: v
        for k, v in os.environ.items()
        if k.startswith(ENV_PREFIXES) or k in ENV_EXACT
    }
    out = block_once(harness, event)
    record = {
        "ts": time.time(),
        "harness": harness,
        "event": event,
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "cwd": os.getcwd(),
        "env": env,
        "payload": payload,
        "chain": process_chain(),
        "state_dirs": probe_dirs(),
        "tmux_reach": probe_tmux(),
        "transcript": transcript_tail(payload)
        if event in ("Stop", "SubagentStop")
        else None,
        "blocked": out is not None,
    }
    record["elapsed_ms"] = round((time.monotonic() - t0) * 1000)
    home = write(Path.home() / "u0-logs" / f"{harness}.jsonl", record)
    record["home_log_write"] = home
    write(Path("/tmp/u0-logs") / f"{harness}.jsonl", record)
    if out:
        print(out)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - never break a turn
        sys.exit(0)
