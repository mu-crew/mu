#!/usr/bin/env node
// A fake pi worker for the TUI dogfood: serves the mu control socket ($MU_CTL_SOCK) the way
// the mu pi extension does (hello/status/send/abort) and prints a transcript, so the
// dashboard shows a real agent in a real tmux pane. Profiles (--profile):
//   busy     busy, changes tool every 6-15 s      idle     waiting for input
//   stalled  one tool running for 3 h             blocked  confirm dialog open for 20 min
//   legacy   busy, never reports a tool (old extension: "tool ?")
//   churn    flips busy/idle/blocked/tool every 2-7 s (the live scenario)
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
const a = process.argv.slice(2);
const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const profile = opt("--profile", "busy");
const sock = opt("--sock", process.env.MU_CTL_SOCK);
const incarnation = `fake-${process.pid}`;
const T = { bash: "bash", read: "read", edit: "edit", grep: "grep" };
let state = "busy", since = Date.now(), runs = 1, tool = null, blocked;
const tools = Object.keys(T);
const rnd = (n) => Math.floor(Math.random() * n);
const ts = () => new Date().toTimeString().slice(0, 8);
const C = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const say = (s) => console.log(`${C(2, ts())} ${s}`);
function setState(s, t = null, b = undefined) {
  if (s !== state) { state = s; since = Date.now(); if (s === "busy") runs++; }
  tool = t; blocked = b;
}
function startTool(name, ago = 0) { setState("busy", { name, since: Date.now() - ago }); say(`${C(36, "tool")} ${name} started`); }
const files = ["src/db.ts", "src/tasks/claim.ts", "src/cli/tui/app.tsx", "test/db.test.ts", "docs/guide/README.md"];
// Fill the pane with a believable transcript (ANSI colour, a very long line).
for (let i = 0; i < 120; i++) say(`${C(32, "ok")} step ${i}: read ${files[i % files.length]} (${100 + i * 7} lines)`);
say(C(33, "warning: ") + "this line is deliberately very long, to see how scrollback wraps and truncates: " + "lorem ipsum ".repeat(30));
say(`profile=${profile} agent=${process.env.MU_AGENT_NAME} ws=${process.env.MU_WORKSTREAM}`);

const status = () => ({ v: 1, ok: true, state: state === "idle" ? "idle" : "busy", since, runs, pending: false,
  ...(profile === "legacy" ? {} : { tool }), ...(blocked ? { blocked } : {}), incarnation });
const server = createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    const i = buf.indexOf("\n");
    if (i < 0) return;
    let req; try { req = JSON.parse(buf.slice(0, i)); } catch { return c.end(); }
    const reply = (o) => c.end(JSON.stringify(o) + "\n");
    switch (req.op) {
      case "hello": return reply({ v: 1, ok: true, agent: process.env.MU_AGENT_NAME, workstream: process.env.MU_WORKSTREAM,
        piVersion: "fake", incarnation, ops: ["hello", "status", "send", "abort"], features: ["incarnation", "msgId"], extVersion: "fake" });
      case "status": return reply(status());
      case "send": case "fresh": case "interrupt":
        say(`${C(35, "received")} ${String(req.text).slice(0, 80)}`);
        startTool("bash"); return reply(status());
      case "abort": { const was = state === "busy"; setState("idle"); say("aborted"); return reply({ v: 1, ok: true, state, wasBusy: was }); }
      default: return reply({ v: 1, ok: false, error: `unknown op: ${req.op}`, ops: ["hello", "status"] });
    }
  });
  c.on("error", () => {});
});
mkdirSync(dirname(sock), { recursive: true });
rmSync(sock, { force: true });
server.listen(sock);
const bye = () => { try { rmSync(sock, { force: true }); } catch {} process.exit(0); };
process.on("SIGTERM", bye); process.on("SIGINT", bye); process.on("SIGHUP", bye);

const every = (lo, hi, f) => { const go = () => { f(); setTimeout(go, lo + rnd(hi - lo)); }; setTimeout(go, lo + rnd(hi - lo)); };
switch (profile) {
  case "busy": case "legacy":
    startTool("read");
    every(6000, 15000, () => { const t = tools[rnd(4)]; say(`${C(36, "tool")} ${t} ${files[rnd(5)]}`); setState("busy", profile === "legacy" ? null : { name: t, since: Date.now() }); });
    break;
  case "idle": setState("idle"); say("done; waiting for input"); break;
  case "stalled": startTool("bash", 3 * 3600e3); say(`${C(33, "tool")} bash: npm test (no output for 3h)`); break;
  case "blocked": setState("busy", null, { kind: "confirm", title: "Run `rm -rf build/`?", since: Date.now() - 20 * 60e3 }); say("waiting on a confirm dialog"); break;
  case "die": setTimeout(() => { say(C(31, "fatal: out of memory")); bye(); }, Number(opt("--after", "1")) * 1000); startTool("bash"); break;
  case "churn": {
    const step = () => {
      const r = rnd(10);
      if (r < 5) { const t = tools[rnd(4)]; startTool(t); }
      else if (r < 8) { setState("idle"); say("idle"); }
      else if (r < 9) { setState("busy", null, { kind: "confirm", title: `Allow ${tools[rnd(4)]}?`, since: Date.now() }); say("blocked on dialog"); }
      else { setState("busy", null); say("thinking"); }
    };
    step(); every(2500, 7000, step); break;
  }
  default: console.error("unknown profile", profile); process.exit(2);
}
setInterval(() => {}, 1 << 30);
