// A stand-in for `pi --mode rpc` + the mu extension's control socket: serves
// $MU_CTL_SOCK (hello/status/send/wait/abort) and exits when stdin closes.
// FAKE_PI: answer (default) | silent (never serves) | die (exits at once) |
// lost (closes on the send, never accepts it) | drop (accepts the send, reply lost) | refuse (send ok:false) |
// crash (accepts the send, then exits) | hang (never settles) | blocked | error | empty.
// FAKE_PI_LOG appends one line per request op, so a test can count sends.
import { appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";

const mode = process.env.FAKE_PI ?? "answer";
const sock = process.env.MU_CTL_SOCK;
if (mode === "die") process.exit(3);
if (mode === "silent") {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else {
  const inc = `inc-${process.pid}`;
  const accepted = new Map();
  let runs = 0;
  let state = "idle";
  const waiters = new Set();
  const status = () => ({ incarnation: inc, state, since: 0, runs, pending: false });
  const settle = () => {
    state = "idle";
    runs++;
    for (const w of waiters) w();
  };
  const reply = (c, o) => c.end(`${JSON.stringify({ v: 1, ...o })}\n`);
  rmSync(sock, { force: true });
  const server = createServer((c) => {
    c.setEncoding("utf8");
    c.on("error", () => {});
    c.once("data", (d) => {
      const req = JSON.parse(d.split("\n")[0]);
      if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, `${req.op}\n`);
      if (req.expectIncarnation !== undefined && req.expectIncarnation !== inc)
        return reply(c, { ok: false, error: "incarnation mismatch", incarnation: inc });
      switch (req.op) {
        case "hello":
          return reply(c, {
            ok: true,
            incarnation: inc,
            ops: [],
            features: ["incarnation", "msgId"],
          });
        case "status": {
          const got = accepted.get(req.msgId);
          return reply(c, {
            ok: true,
            ...status(),
            ...(req.msgId
              ? {
                  msg: got
                    ? { id: req.msgId, accepted: true, ...got }
                    : { id: req.msgId, accepted: false },
                }
              : {}),
          });
        }
        case "send": {
          if (mode === "refuse") return reply(c, { ok: false, error: "no session" });
          const before = status();
          if (mode === "lost") return c.destroy();
          accepted.set(req.msgId, { runs: before.runs });
          if (mode === "crash") {
            reply(c, { ok: true, ...before });
            return setTimeout(() => process.exit(1), 10);
          }
          state = "busy";
          if (mode !== "hang" && mode !== "blocked") setTimeout(settle, 20);
          return mode === "drop" ? c.destroy() : reply(c, { ok: true, ...before });
        }
        case "wait": {
          const done = () => {
            if (mode === "blocked") return reply(c, { ok: true, ...status(), ended: "blocked" });
            if (mode === "empty")
              return reply(c, { ok: true, ...status(), lastText: "", ended: "settled" });
            if (mode === "error")
              return reply(c, {
                ok: true,
                ...status(),
                lastText: "",
                lastError: "429 rate limited",
                ended: "settled",
              });
            reply(c, {
              ok: true,
              ...status(),
              lastText: "VERDICT: CONFIRMED\nEVIDENCE: read it",
              sessionFile: `${process.env.MU_STATE_DIR}/fake-session.jsonl`,
              ended: "settled",
            });
          };
          if (mode === "blocked" || runs > (req.afterRuns ?? -1)) return done();
          waiters.add(done);
          if (req.timeoutMs !== undefined)
            setTimeout(() => {
              if (waiters.delete(done)) reply(c, { ok: false, error: "timeout" });
            }, req.timeoutMs);
          return;
        }
        case "abort": {
          const wasBusy = state === "busy";
          if (wasBusy) settle();
          return reply(c, { ok: true, state, wasBusy });
        }
      }
      reply(c, { ok: false, error: `unknown op: ${req.op}` });
    });
  });
  server.listen(sock);
  process.stdin.resume();
  process.stdin.on("end", () => {
    rmSync(sock, { force: true });
    process.exit(0);
  });
}
