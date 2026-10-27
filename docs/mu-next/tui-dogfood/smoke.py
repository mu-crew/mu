#!/usr/bin/env python3
"""Smoke every scenario through a PTY: it must seed, launch, render and quit cleanly.
   python3 smoke.py [N ... | fill | stable]   (default: all three kinds). Exit 0 = all green.
     N       scenario N seeds, renders, takes keys, quits 0, leaves no tmux server
     fill    s2 s4 s5 s7 at 200x50, 120x40, 80x24, every tab, read off a private tmux screen:
             the last row is the hint; a frame reaches the bottom body row (tabs always, an
             Overview column whenever one of its cards says "+N more")
     stable  s6, two screens 5 s apart: the second column of Tasks and of Log starts at the same x
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

def fill_problems(lines, h, tab):
    """What is wrong with one screen, as strings (empty = fine)."""
    bad = []
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
                    probs += [f"{tab}: {p}" for p in fill_problems(scr.grab(), h, tab)]
                scr.keys(*["Left"] * 4)  # back to Overview for the next size
                bad += bool(probs)
                print(f"fill s{n} {w}x{h}: {'OK ' if not probs else 'FAIL'}")
                for p in probs: print("   ", p)
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
sys.exit(1 if bad else 0)
