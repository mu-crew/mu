#!/usr/bin/env python3
"""U0 spike driver. Run from a normal terminal (not inside an agent).

  u0.py init                       scratch repo /tmp/u0-repo
  u0.py install <harness> [--user] add the logging hook (claude|codex|cursor|muse)
  u0.py uninstall <harness>        restore the harness's hook config
  u0.py drive <harness> <pane>     paste the test prompts into that pane
  u0.py report [harness...]        summarise the logs

Logs: /tmp/u0-logs/<harness>.jsonl (it records whether ~/u0-logs was writable too).

Run the harness in a pane of a tmux server started from a terminal, cwd
/tmp/u0-repo, accept its folder and hook trust prompts, then drive it from
another pane. codex hooks go into ~/.codex/hooks.json (backed up and restored);
the others are project-scoped under /tmp/u0-repo.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK = HERE / "u0_hook.py"
REPO = Path(os.environ.get("U0_REPO", "/tmp/u0-repo"))
LOGS = [Path("/tmp/u0-logs"), Path.home() / "u0-logs"]

EVENTS = {
    "claude": [
        "SessionStart",
        "UserPromptSubmit",
        "PermissionRequest",
        "Notification",
        "Stop",
        "StopFailure",
        "SubagentStop",
        "SessionEnd",
        "PreCompact",
    ],
    "codex": [
        "SessionStart",
        "UserPromptSubmit",
        "PermissionRequest",
        "Stop",
        "SessionEnd",
    ],
    "cursor": [
        "sessionStart",
        "beforeSubmitPrompt",
        "afterAgentResponse",
        "stop",
        "sessionEnd",
    ],
    "muse": [
        "SessionStart",
        "UserPromptSubmit",
        "PermissionRequest",
        "Notification",
        "Stop",
        "StopFailure",
        "SubagentStop",
        "SessionEnd",
        "PreCompact",
        "Interrupt",
    ],
}
STOP = {"claude": "Stop", "codex": "Stop", "cursor": "stop", "muse": "Stop"}
PROMPT = {
    "claude": "UserPromptSubmit",
    "codex": "UserPromptSubmit",
    "cursor": "beforeSubmitPrompt",
    "muse": "UserPromptSubmit",
}
START = {
    "claude": "SessionStart",
    "codex": "SessionStart",
    "cursor": "sessionStart",
    "muse": "SessionStart",
}
FRESH = {"claude": "/clear", "codex": "/new", "cursor": "/new-chat", "muse": "/new"}
NESTED = {
    "claude": "claude -p 'Reply with exactly NESTED'",
    "codex": "codex exec 'Reply with exactly NESTED'",
    "cursor": "cursor-agent -p 'Reply with exactly NESTED'",
    "muse": "muse exec 'Reply with exactly NESTED'",
}


def hook_cmd(harness: str, event: str) -> str:
    return f"python3 {HOOK} {harness} {event}"


def claude_style(harness: str, events: list[str]) -> dict:
    return {
        ev: [
            {
                "hooks": [
                    {"type": "command", "command": hook_cmd(harness, ev), "timeout": 30}
                ]
            }
        ]
        for ev in events
    }


def cmd_init() -> None:
    REPO.mkdir(parents=True, exist_ok=True)
    (REPO / "README.md").write_text("u0 scratch repo\n")
    if not (REPO / ".git").exists():
        subprocess.run(["git", "init", "-q"], cwd=REPO, check=True)
        subprocess.run(["git", "add", "."], cwd=REPO, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=REPO, check=True)
    print(f"scratch repo: {REPO}")


def cmd_install(harness: str, user: bool, extra: list[str]) -> None:
    events = EVENTS[harness] + extra
    if harness == "claude":
        path = REPO / ".claude" / "settings.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"hooks": claude_style("claude", events)}, indent=2) + "\n"
        )
    elif harness == "codex":
        path = Path.home() / ".codex" / "hooks.json"
        backup = path.with_suffix(".json.u0-backup")
        if path.exists() and not backup.exists():
            shutil.copy2(path, backup)
        data = json.loads(backup.read_text()) if backup.exists() else {"hooks": {}}
        for ev, entries in claude_style("codex", events).items():
            data.setdefault("hooks", {}).setdefault(ev, []).extend(entries)
        path.write_text(json.dumps(data, indent=2) + "\n")
    elif harness == "cursor":
        path = (
            (Path.home() / ".cursor" / "hooks.json")
            if user
            else (REPO / ".cursor" / "hooks.json")
        )
        if path.exists() and user:
            sys.exit(f"{path} exists; not overwriting")
        path.parent.mkdir(parents=True, exist_ok=True)
        hooks = {ev: [{"command": hook_cmd("cursor", ev)}] for ev in events}
        path.write_text(json.dumps({"version": 1, "hooks": hooks}, indent=2) + "\n")
        if user:
            Path("/tmp/u0-cursor-user-hooks").write_text(str(path))
    elif harness == "muse":
        # Muse-format project hooks: the only route to `Interrupt`, which must be async.
        path = REPO / ".muse" / "hooks.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        hooks = claude_style("muse", events)
        hooks["Interrupt"][0]["hooks"][0]["async"] = True
        path.write_text(json.dumps({"hooks": hooks}, indent=2) + "\n")
    else:
        sys.exit(f"unknown harness {harness}")
    print(f"installed {len(events)} {harness} hooks in {path}")


def cmd_uninstall(harness: str) -> None:
    if harness == "claude":
        (REPO / ".claude" / "settings.json").unlink(missing_ok=True)
    elif harness == "codex":
        path = Path.home() / ".codex" / "hooks.json"
        backup = path.with_suffix(".json.u0-backup")
        if backup.exists():
            shutil.move(backup, path)
        else:
            path.unlink(missing_ok=True)
    elif harness == "cursor":
        (REPO / ".cursor" / "hooks.json").unlink(missing_ok=True)
        marker = Path("/tmp/u0-cursor-user-hooks")
        if marker.exists():
            Path(marker.read_text()).unlink(missing_ok=True)
            marker.unlink()
    elif harness == "muse":
        (REPO / ".muse" / "hooks.json").unlink(missing_ok=True)
    print(f"uninstalled {harness} hooks")


def log_records(harness: str) -> list[dict]:
    for d in LOGS:
        f = d / f"{harness}.jsonl"
        if f.exists():
            return [
                json.loads(line) for line in f.read_text().splitlines() if line.strip()
            ]
    return []


def tmux(*args: str, stdin: str | None = None) -> None:
    subprocess.run(["tmux", *args], input=stdin, text=True, check=True)


def paste(pane: str, text: str) -> None:
    # An interrupted claude puts its prompt back in the input box; clear it first.
    tmux("send-keys", "-t", pane, "C-u")
    time.sleep(0.2)
    tmux("load-buffer", "-b", "u0", "-", stdin=text)
    tmux("paste-buffer", "-p", "-d", "-b", "u0", "-t", pane)
    time.sleep(0.5)
    tmux("send-keys", "-t", pane, "Enter")


def wait_for(
    harness: str, event: str, since: int, timeout: float = 180, count: int = 1
) -> list[dict]:
    end = time.time() + timeout
    while time.time() < end:
        new = [r for r in log_records(harness)[since:] if r.get("event") == event]
        if len(new) >= count:
            return new
        time.sleep(1)
    print(f"  !! no {event} within {timeout:.0f}s")
    return []


def step(title: str) -> None:
    print(f"\n== {title}")


def cmd_drive(harness: str, pane: str) -> None:
    stop, prompt = STOP[harness], PROMPT[harness]
    n = lambda: len(log_records(harness))  # noqa: E731

    step("1 basic turn")
    i = n()
    paste(pane, "Reply with exactly OK")
    wait_for(harness, stop, i)

    step("2 3 KB multi-line paste")
    lines = [f"line {k:02d} " + "x" * 40 for k in range(1, 61)]
    i = n()
    paste(
        pane,
        "Count the numbered lines below and reply with just the number.\n"
        + "\n".join(lines),
    )
    wait_for(harness, stop, i)
    print("  expected answer: 60 (check the pane)")

    step("3 interrupt mid-turn")
    i = n()
    paste(pane, "Run the shell command `sleep 45` and then reply DONE.")
    wait_for(harness, prompt, i, timeout=60)
    time.sleep(8)
    tmux("send-keys", "-t", pane, "Escape")
    print("  sent Escape; watching 15 s for events")
    time.sleep(15)
    print("  events after Escape:", [r["event"] for r in log_records(harness)[i:]])

    step("4 permission dialog")
    i = n()
    paste(pane, "Create the file ~/u0-perm-test.txt containing the word hi.")
    print("  >> if a permission dialog appears in the pane, APPROVE it")
    wait_for(harness, stop, i, timeout=240)

    step("5 nested agent")
    i = n()
    paste(pane, f"Run this shell command and show me its output: {NESTED[harness]}")
    print("  >> approve the command if asked")
    wait_for(harness, stop, i, timeout=300)

    if harness in ("claude", "codex", "muse"):
        step("6 native subagent")
        i = n()
        paste(
            pane,
            "Use a subagent to count the files in this directory, then reply with the count.",
        )
        wait_for(harness, stop, i, timeout=300)

    step("7 stop-hook block (once)")
    Path(f"/tmp/u0-block-once-{harness}").write_text("1")
    i = n()
    paste(pane, "Reply with exactly OK")
    wait_for(harness, stop, i, timeout=180, count=2)
    print("  expected: the agent continued and replied BLOCKED-OK")

    step("8 fresh command")
    i = n()
    tmux("send-keys", "-t", pane, "-l", FRESH[harness])
    time.sleep(0.5)
    tmux("send-keys", "-t", pane, "Enter")
    time.sleep(10)
    print("  events after fresh:", [r["event"] for r in log_records(harness)[i:]])

    step("9 exit")
    print("  >> exit the harness in the pane now (/exit or Ctrl-D twice); waiting 60 s")
    i = n()
    time.sleep(60)
    print("  events after exit:", [r["event"] for r in log_records(harness)[i:]])
    print(f"\ndone. run: {sys.argv[0]} report {harness}")


def cmd_report(harnesses: list[str]) -> None:
    for h in harnesses or ["claude", "codex", "cursor", "muse"]:
        recs = log_records(h)
        print(f"\n### {h}: {len(recs)} records")
        for r in recs:
            env = r.get("env", {})
            chain = " < ".join(
                Path(c.get("args", "?").split(" ")[0]).name for c in r.get("chain", [])
            )
            bad = {k: v for k, v in r.get("state_dirs", {}).items() if v != "ok"}
            payload = r.get("payload") or {}
            keys = (
                sorted(payload)[:12]
                if isinstance(payload, dict)
                else type(payload).__name__
            )
            print(
                f"- {r['event']:<20} {r.get('elapsed_ms')}ms pane={env.get('TMUX_PANE', '-')} "
                f"tmux={'y' if env.get('TMUX') else 'n'} mu={sorted(k for k in env if k.startswith('MU_'))} "
                f"blocked={r.get('blocked')} homelog={r.get('home_log_write')}"
            )
            print(f"    chain: {chain}")
            print(f"    payload keys: {keys}")
            if bad:
                print(f"    state dirs refused: {bad}")
            if r.get("tmux_reach", {}).get("rc") not in (0, None):
                print(f"    tmux: {r['tmux_reach']}")
            if r.get("transcript"):
                print(f"    transcript: {r['transcript']}")


def main() -> None:
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd = a[0]
    if cmd == "init":
        cmd_init()
    elif cmd == "install":
        extra = [x.split("=", 1)[1] for x in a if x.startswith("--event=")]
        cmd_install(a[1], "--user" in a, extra)
    elif cmd == "uninstall":
        cmd_uninstall(a[1])
    elif cmd == "drive":
        cmd_drive(a[1], a[2])
    elif cmd == "report":
        cmd_report(a[1:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
