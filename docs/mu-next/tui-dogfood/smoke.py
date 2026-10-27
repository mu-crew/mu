#!/usr/bin/env python3
"""Smoke every scenario through a PTY: it must seed, launch, render and quit cleanly.
   python3 smoke.py [N ...]      (default: all). Exit 0 = all green. Needs a built checkout."""
import os, pty, re, select, struct, fcntl, termios, subprocess, sys, time, signal

HERE = os.path.dirname(os.path.abspath(__file__))
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")
# scenario -> (text that must appear, keys to press before q, text that must appear after them)
CHECKS = {
    1: (b"nothing here", b"\t\t\t", b"Log"),
    2: (b"worker-1", b"\t\t", b"worker-3"),
    3: (b"hail-cache", b"]", b"Tasks"),
    4: (b"payments", b"\t\t", b"worker-4"),
    5: (b"monorepo", b"jjjj\r", b"note"),
    6: (b"live-demo", b"\t\t", b"worker-1"),
    7: (b"remote-demo", b"\t\t", b"worker-2"),
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

bad = 0
for n in [int(a) for a in sys.argv[1:]] or sorted(CHECKS):
    t0 = time.time()
    first, ok2, code, gone, text = run(n)
    good = first and ok2 and code == 0 and gone
    bad += not good
    print(f"scenario {n}: {'OK ' if good else 'FAIL'} render={first} keys={ok2} exit={code} tmux-gone={gone} ({time.time()-t0:.0f}s)")
    if not good:
        print("   tail:", text[-600:].decode("utf8", "replace").replace("\n", " | "))
sys.exit(1 if bad else 0)
