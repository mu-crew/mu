#!/usr/bin/env python3
"""Smoke every scenario through a PTY: it must seed, launch, render and quit cleanly.
   python3 smoke.py [N ... | fill | stable | drill | live]   (default: scenarios + fill, stable, drill). Exit 0 = all green.
     N       scenario N seeds, renders, takes keys, quits 0, leaves no tmux server
     fill    s2 s4 s5 s7 at 200x50, 120x40, 80x24, every tab, read off a private tmux screen:
             row 3 is the attention strip (s4: "⚠ N need you"); the last row is the hint; a frame reaches the bottom body row (tabs always, an
             Overview column whenever one of its cards says "+N more")
     stable  s6, two screens 5 s apart: the second column of Tasks and of Log starts at the same x
     drill   s2 at 120x40 and 80x24: Enter on a Tasks row and on a DAG row opens the notes, strip on row 2, hint on the last row
     live    (opt-in) every view updates from another process with no key: per-view latency, idle and s6 CPU
   Needs a built checkout. Set MU_DOGFOOD_DIR to keep the scratch DBs somewhere short."""
import os, pty, re, select, struct, fcntl, termios, subprocess, sys, time, signal

HERE = os.path.dirname(os.path.abspath(__file__))
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")
# scenario -> (text that must appear, keys to press before q, text that must appear after them)
CHECKS = {
    1: (b"no workstreams", b"\t\t\t\t", b"Log"),
    2: (b"worker-1", b"\t\t\t", b"worker-3"),
    3: (b"hail-cache", b"]", b"Tasks"),
    4: (b"payments", b"\t\t\t", b"worker-4"),
    5: (b"monorepo", b"\tjjjj\r", b"note"),
    6: (b"live-demo", b"\t\t\t", b"worker-1"),
    7: (b"remote-demo", b"\t\t\t", b"worker-2"),
}

def run(n, budget=40):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.execv(os.path.join(HERE, "run.sh"), ["run.sh", str(n)])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
    buf = b""
    def pump(sec, until=None):
        nonlocal buf
        end = time.time() + sec
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    return False
                if not d:
                    return False
                buf += d
            if until and until in ANSI.sub(b"", buf):
                return True
        return until is None
    want, keys, after = CHECKS[n]
    ok = pump(budget, want)
    shown = ANSI.sub(b"", buf)
    first = ok
    mark = len(buf)
    for k in [bytes([c]) for c in keys]:
        os.write(fd, k); pump(0.6)
    ok2 = pump(8, after) if after else True
    os.write(fd, b"q")  # a drill swallows the first q (closes it); a second quits
    pump(1.0)
    try: os.write(fd, b"q")
    except OSError: pass
    t = time.time(); code = None
    while time.time() - t < 15:
        p, st = os.waitpid(pid, os.WNOHANG)
        if p:
            code = os.waitstatus_to_exitcode(st); break
        pump(0.3)
    if code is None:
        os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0); code = -9
    gone = subprocess.run(["tmux", "-L", f"mudf-{n}", "list-sessions"], capture_output=True).returncode != 0
    return first, ok2, code, gone, ANSI.sub(b"", buf)


# ── screen checks: run.sh inside a private tmux server, read the real screen with capture-pane ──
HINT = re.compile(r"^←/→ tab")  # the last line of every screen (cut with … when narrow)
MORE = re.compile(r"\+\d+ (more|older)")
TABS = ["Overview", "Tasks", "DAG", "Agents", "Log"]
SIZES = [(200, 50), (120, 40), (80, 24)]

class Screen:
    """One run.sh scenario in a detached tmux window of a private server `mudfo-N`."""
    def __init__(self, n, w, h):
        self.n, self.sock = n, f"mudfo-{n}"
        self.kill()
        subprocess.run(["tmux", "-L", self.sock, "-f", "/dev/null", "new-session", "-d", "-x", str(w), "-y", str(h),
                        "-s", "s", f"{os.path.join(HERE, 'run.sh')} {n}; sleep 60"], check=True)
    def tmux(self, *a):
        return subprocess.run(["tmux", "-L", self.sock, *a], capture_output=True, text=True).stdout
    def size(self, w, h):
        self.tmux("resize-window", "-t", "s", "-x", str(w), "-y", str(h)); time.sleep(0.8)
    def keys(self, *k):
        for x in k:
            self.tmux("send-keys", "-t", "s", x); time.sleep(0.6)
    def grab(self):
        return self.tmux("capture-pane", "-p", "-t", "s").split("\n")[:-1]
    def wait(self, text, sec=40):
        end = time.time() + sec
        while time.time() < end:
            if any(text in l for l in self.grab()): return True
            time.sleep(0.4)
        return False
    def kill(self):
        for sock in (self.sock, f"mudf-{self.n}"):
            subprocess.run(["tmux", "-L", sock, "kill-server"], capture_output=True)

def frames(lines):
    """[(x0, x1, top, bottom)] for every rounded frame on screen, found by its corners."""
    out = []
    for r, l in enumerate(lines):
        for m in re.finditer("╭", l):
            x0 = m.start()
            x1 = l.find("╮", x0)
            if x1 < 0: continue
            b = next((i for i in range(r + 1, len(lines)) if lines[i][x0:x0 + 1] == "╰"), None)
            if b is not None: out.append((x0, x1, r, b))
    return out

STRIP = re.compile(r"^(⚠ \d+ need you|✓ all quiet)")

def fill_problems(lines, h, tab, alert=False):
    """What is wrong with one screen, as strings (empty = fine). `alert`: the strip must say ⚠."""
    bad = []
    strip = lines[2] if len(lines) > 2 else ""
    if not STRIP.match(strip) or (alert and not strip.startswith("⚠")):
        bad.append(f"row 3 is not the attention strip{' (⚠)' if alert else ''}: {strip[:60]!r}")
    if len(lines) != h: bad.append(f"{len(lines)} rows, want {h}")
    if not lines or not HINT.search(lines[-1]): bad.append(f"last row is not the hint: {lines[-1:]!r}")
    fs = frames(lines)
    if not fs: return bad + ["no frame on screen"]
    nxt = next((i for i, l in enumerate(lines) if l.startswith("next:")), h - 1)
    last_body = nxt - 1  # the row above Next (or above the hint on a short screen)
    for x0 in sorted({f[0] for f in fs}):
        col = [f for f in fs if f[0] == x0]
        hides = any(MORE.search(lines[f[3]][f[0]:f[1] + 1]) for f in col)
        end = max(f[3] for f in col)
        if (tab != "Overview" or hides) and end != last_body:
            bad.append(f"column at x={x0}: frame ends on row {end + 1}, bottom body row is {last_body + 1}"
                       + (" while a card says +N more" if hides else ""))
    return bad

def fill_check(ns=(2, 4, 5, 7)):
    bad = 0
    for n in ns:
        scr = Screen(n, *SIZES[0])
        try:
            if not scr.wait("Overview"):
                print(f"fill s{n}: FAIL never rendered"); bad += 1; continue
            time.sleep(1)
            for (w, h) in SIZES:
                scr.size(w, h)
                probs = []
                for t, tab in enumerate(TABS):
                    if t: scr.keys("Right")
                    time.sleep(0.4)
                    probs += [f"{tab}: {p}" for p in fill_problems(scr.grab(), h, tab, alert=n == 4)]
                scr.keys(*["Left"] * 4)  # back to Overview for the next size
                bad += bool(probs)
                print(f"fill s{n} {w}x{h}: {'OK ' if not probs else 'FAIL'}")
                for p in probs: print("   ", p)
        finally:
            scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5); scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5)
            scr.kill()
    return bad

def drill_check():
    """s2: Enter on a task (Tasks, then DAG) opens its notes, and the drill keeps the hint on the last row."""
    scr = Screen(2, 120, 40)
    bad = 0
    try:
        if not scr.wait("Overview"):
            print("drill s2: FAIL never rendered"); return 1
        for (w, h) in [(120, 40), (80, 24)]:
            scr.size(w, h)
            for name, presses in [("Tasks", 1), ("DAG", 2)]:
                scr.keys(*["Right"] * presses, "Enter")
                opened = scr.wait("Notes  shop-api/", 5)
                lines = scr.grab()
                probs = [] if opened else ["Enter opened no notes"]
                if len(lines) != h: probs.append(f"{len(lines)} rows, want {h}")
                if not lines or "Esc back" not in lines[-1]: probs.append(f"last row is not the hint: {lines[-1:]!r}")
                if len(lines) < 2 or not STRIP.match(lines[1]): probs.append(f"row 2 is not the attention strip: {lines[1:2]!r}")
                bad += bool(probs)
                print(f"drill s2 {name} {w}x{h}: {'OK ' if not probs else 'FAIL'}")
                for p in probs: print("   ", p)
                scr.keys("Escape"); time.sleep(0.4); scr.keys(*["Left"] * presses)
    finally:
        scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5); scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5)
        scr.kill()
    return bad

def second_col_x(lines, pat):
    """x of the first match of `pat` on every row that has one (the rows' second column)."""
    return sorted({m.start() for l in lines if (m := re.search(pat, l))})

def stable_check():
    """s6 is live: ids and states change. The second column must not move between two screens."""
    scr = Screen(6, 160, 45)
    bad = 0
    try:
        if not (scr.wait("live-demo") and scr.wait("Overview")):
            print("stable s6: FAIL never rendered"); return 1
        # (tab, key presses from Overview, second-column pattern)
        for name, presses, pat in [("Tasks", 1, r"(IN_PROGRESS|OPEN|CLOSED)"), ("Log", 4, r"\d\d:\d\d:\d\d")]:
            scr.keys(*["Right"] * presses)
            if name == "Tasks": scr.wait("new1", 30)  # a task with a longer id than the seeds has arrived
            a = second_col_x(scr.grab(), pat); time.sleep(5)
            b = second_col_x(scr.grab(), pat)
            ok = len(a) == 1 and a == b
            bad += not ok
            print(f"stable s6 {name}: {'OK ' if ok else 'FAIL'} second column x {a} then {b}")
            scr.keys(*["Left"] * presses)
    finally:
        scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5); scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5)
        scr.kill()
    return bad

def live_check():
    """Every view updates from another process with no key press (tui_live_updates): s2 driven by
    the CLI from here, one change per view, each timed from the write to the screen showing it.
    DB changes must show within 1 s (fast tick), agent state and scrollback within one slow tick
    (10 s, as 3.x). Then idle CPU over 60 s, and s6 (the mutator): a note appears in an open drill."""
    scr = Screen(2, 160, 45)
    bad = 0
    d = os.path.join(os.environ.get("MU_DOGFOOD_DIR", "/var/tmp/mu-dogfood"), "s2")
    env = {**os.environ, "MU_DB_PATH": os.path.join(d, "mu.db"), "MU_STATE_DIR": d, "MU_SYNC_DIR": "",
           "MU_TMUX_SOCKET": "mudf-2", "MU_MUX": "tmux"}
    for v in [k for k in env if k.startswith("MU_AGENT") or k in ("MU_SESSION", "TMUX_PANE", "PI_SESSION_ID")]:
        env.pop(v, None)
    CLI = os.path.realpath(os.path.join(HERE, "../../../dist/cli.js"))
    cli = lambda *a, extra={}: subprocess.run(["node", CLI, *a], env={**env, **extra}, capture_output=True, text=True)
    def timed(name, change, seen, budget):
        """The write commits somewhere between the CLI's start and its exit, so the latency is
        reported as a range [screen - exit, screen - start]; the budget holds the lower end
        plus nothing else: node's own startup (~0.4 s) is not the dashboard's."""
        nonlocal bad
        t0 = time.time(); r = change(); t1 = time.time()
        if r is not None and r.returncode != 0:
            print(f"live {name}: FAIL the change failed: {r.stderr.strip()[:200]}"); bad += 1; return
        end = t1 + budget + 2
        while time.time() < end:
            if seen(scr.grab()):
                t2 = time.time(); ok = t2 - t1 <= budget; bad += not ok
                print(f"live {name}: {'OK ' if ok else 'FAIL'} {t2 - t1:.2f}s after the write returned"
                      f" ({t2 - t0:.2f}s incl. the CLI; budget {budget}s)"); return
            time.sleep(0.05)
        bad += 1; print(f"live {name}: FAIL not seen within {budget + 2}s")
    has = lambda text: (lambda ls: any(text in l for l in ls))
    def col(ls, word):
        return next((m.start() for l in ls if (m := re.search(rf"\b{word}\b", l))), -1)
    try:
        if not scr.wait("Overview"):
            print("live s2: FAIL never rendered"); return 1
        time.sleep(1.5)
        W = ("-w", "shop-api")
        # Overview: attention strip appears (a human-needed task) and the Next line changes (auto off).
        timed("Overview strip appears", lambda: cli("human-needed", "pick a release date", *W, extra={"PI_SESSION_ID": "smoke"}),
              has("1 need you"), 1)
        timed("Next line changes", lambda: cli("task", "auto", "perf", "--off", *W), has("next: no authorised work"), 1)
        hid = cli("task", "list", *W, "--json")
        try:
            import json as _j
            rows = _j.loads(hid.stdout); rows = rows.get("data", rows) if isinstance(rows, dict) else rows
            rows = rows.get("items", rows) if isinstance(rows, dict) else rows
            human = next((t.get("id") or t.get("name") for t in rows if (t.get("kind") == "human")), None)
        except Exception:
            human = None
        if human:
            timed("Overview strip clears", lambda: cli("task", "close", human, *W, "--as", "wontfix", "--why", "smoke"),
                  has("all quiet"), 1)
        else:
            bad += 1; print("live Overview strip clears: FAIL no human task id found")
        scr.keys("Right")  # Tasks
        timed("Tasks row add", lambda: cli("task", "add", "live1", "-t", "Added from the second shell", *W),
              has("Added from the second shell"), 1)
        timed("Tasks row close", lambda: cli("task", "close", "live1", *W, "--as", "wontfix", "--why", "smoke"),
              lambda ls: not has("Added from the second shell")(ls), 1)
        scr.keys("Right")  # DAG
        cli("task", "add", "live2", "-t", "Live edge target", *W); time.sleep(1.2)
        timed("DAG edge add", lambda: cli("task", "block", "live2", "--by", "perf", *W),
              lambda ls: col(ls, "live2") > col(ls, "perf") >= 0, 1)  # now indented under its blocker
        scr.keys("Right")  # Agents
        scr.keys("Enter")  # worker-1's scrollback
        scr.wait("Scrollback  shop-api/worker-1", 5); time.sleep(0.5)
        timed("Scrollback new lines", lambda: cli("agent", "send", "worker-1", "streamed from the second shell", *W),
              has("streamed from the second"), 10)
        scr.keys("Escape")
        # The registry row (agent list reconciles against the live mux and would read none here).
        import sqlite3
        con = sqlite3.connect(f"file:{env['MU_DB_PATH']}?mode=ro", uri=True)
        row = con.execute("SELECT pane_id FROM agents WHERE name = 'worker-3'").fetchone(); con.close()
        pane = row[0] if row else None
        if pane:  # the agent's process dies: busy -> dead (unknown, pane gone) and the strip says so
            timed("Agents state flip (worker-3 dies)",
                  lambda: subprocess.run(["tmux", "-L", "mudf-2", "kill-pane", "-t", pane], capture_output=True),
                  lambda ls: any(re.search(r"worker-3 .*unknown", l) for l in ls), 10)
        else:
            bad += 1; print("live Agents state flip: FAIL worker-3's pane not found")
        scr.keys("Right")  # Log
        timed("Log row add", lambda: cli("task", "note", "perf", "log line from the second shell", *W),
              has("log line from the second"), 1)
        scr.keys("Left", "Left", "Left", "Down")  # Tasks, a row
        scr.keys("Enter"); time.sleep(0.8)
        title = next((l for l in scr.grab() if l.startswith("Notes  shop-api/")), "")
        tid = title.split("/")[1].split()[0] if "/" in title else "perf"
        timed("Notes drill new note", lambda: cli("task", "note", tid, "note appended live", *W),
              has("note appended live"), 1)
        scr.keys("Escape")  # back on Tasks: nothing on it changes while idle
        time.sleep(2)
        pid = subprocess.run(["pgrep", "-f", f"{CLI} -w shop-api"], capture_output=True, text=True).stdout.split()
        if pid:
            cpu = lambda: sum(int(x) for x in open(f"/proc/{pid[0]}/stat").read().rsplit(")", 1)[1].split()[11:13])
            def share(sec):
                c0, t0 = cpu(), time.time(); time.sleep(sec); c1, t1 = cpu(), time.time()
                return (c1 - c0) / os.sysconf("SC_CLK_TCK") / (t1 - t0) * 100
            pct = share(60); ok = pct < 2; bad += not ok
            print(f"live idle CPU s2 Tasks 60s (no change on screen): {'OK ' if ok else 'FAIL'} {pct:.2f}% of one core (budget 2%)")
            scr.keys("Left")  # Overview: two busy agents' tool clocks tick every second (a real change)
            print(f"live CPU s2 Overview 30s (tool clocks ticking; reported, no budget): {share(30):.2f}% of one core")
        else:
            bad += 1; print("live idle CPU: FAIL dashboard pid not found")
    finally:
        scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5); scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5)
        scr.kill()
    # s6: the mutator notes IN_PROGRESS tasks every 2-5 s; an open drill on one must grow without a key.
    scr = Screen(6, 160, 45)
    try:
        if not scr.wait("Overview"):
            print("live s6: FAIL never rendered"); return bad + 1
        time.sleep(1.5)
        scr.keys("Right")
        scr.tmux("send-keys", "-t", "s", "o"); time.sleep(0.4); scr.tmux("send-keys", "-t", "s", "o"); time.sleep(0.8)  # in_progress
        scr.keys("Enter"); time.sleep(0.8)
        before = sum("progress " in l for l in scr.grab())
        # The mutator notes a RANDOM in-progress task 1 tick in 4 (every 2-5 s): give it 90 s to hit this one.
        end, seen = time.time() + 90, False
        while time.time() < end and not seen:
            seen = sum("progress " in l for l in scr.grab()) > before
            time.sleep(0.2)
        bad += not seen
        title = next((l for l in scr.grab() if l.startswith("Notes  ")), "?")
        print(f"live s6 drill grows from the mutator: {'OK ' if seen else 'FAIL'} ({title.split('  ')[1] if '  ' in title else title})")
        pid = subprocess.run(["pgrep", "-f", "-n", f"{os.path.realpath(os.path.join(HERE, '../../../dist/cli.js'))} -w live-demo"],
                             capture_output=True, text=True).stdout.split()
        if pid:
            cpu = lambda: sum(int(x) for x in open(f"/proc/{pid[0]}/stat").read().rsplit(")", 1)[1].split()[11:13])
            scr.keys("Escape", "Left"); c0, t0 = cpu(), time.time(); time.sleep(30); c1, t1 = cpu(), time.time()
            pct = (c1 - c0) / os.sysconf("SC_CLK_TCK") / (t1 - t0) * 100
            ok = pct < 10; bad += not ok
            print(f"live busy CPU s6 30s: {'OK ' if ok else 'FAIL'} {pct:.2f}% of one core (budget 10%)")
    finally:
        scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5); scr.tmux("send-keys", "-t", "s", "q"); time.sleep(0.5)
        scr.kill()
    return bad

args = sys.argv[1:]
nums = [int(a) for a in args if a.isdigit()]
kinds = [a for a in args if not a.isdigit()]
bad = 0
if not args or nums:
    scen = nums or sorted(CHECKS)
else:
    scen = []
for n in scen:
    t0 = time.time()
    first, ok2, code, gone, text = run(n)
    good = first and ok2 and code == 0 and gone
    bad += not good
    print(f"scenario {n}: {'OK ' if good else 'FAIL'} render={first} keys={ok2} exit={code} tmux-gone={gone} ({time.time()-t0:.0f}s)")
    if not good:
        print("   tail:", text[-600:].decode("utf8", "replace").replace("\n", " | "))
if not args or "fill" in kinds: bad += fill_check()
if not args or "stable" in kinds: bad += stable_check()
if not args or "drill" in kinds: bad += drill_check()
if "live" in kinds: bad += live_check()  # ~3 min (60 s idle CPU): opt-in
sys.exit(1 if bad else 0)
