#!/usr/bin/env node
// A pi stand-in that loads the REAL built mu ctl extension (dist/extension/mu-pi.js),
// for scripts/smoke-lease.sh only. Unlike smoke-fake-pi.mjs (its own ctl server), the
// ctl protocol here is served by the extension: it registers through the extension's
// default export against a recording MuPiApi, session_start binds $MU_CTL_SOCK, and
// a `send` becomes one deterministic tool turn (agent_start, tool_execution_start/end,
// agent_end with the assistant text "smoke-echo: <text>", agent_settled). No model, no
// network, no real pi. Needs $SMOKE_EXT (the built extension). It writes what the
// extension registered to $HOME/smoke-ext-registration.json.
//
// A sent text "smoke-sh: <cmd>" (scripts/smoke-hybrid.sh) is the worker's own shell:
// the turn runs `sh -c <cmd>` in the pi's cwd (its worktree, on its job machine) and
// replies "smoke-sh exit=<n> cwd=<dir>" plus the command's stdout and stderr.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = process.argv[2];
if (arg === "--version") {
  console.log("0.0.0-smoke");
  process.exit(0);
}
if (arg === "list") {
  console.log("npm:@mu-crew/mu (smoke ext pi)");
  process.exit(0);
}
if (!process.env.MU_CTL_SOCK || !process.env.SMOKE_EXT) {
  console.error("smoke-ext-pi: MU_CTL_SOCK and SMOKE_EXT must be set");
  process.exit(2);
}

const handlers = new Map();
const commands = [];
const tools = [];
const TURN_MS = 300;
const ctx = {
  isIdle: () => !busy,
  hasPendingMessages: () => false,
  abort: () => {},
  sessionManager: { getSessionFile: () => undefined, getSessionId: () => "smoke-session" },
  ui: { notify() {}, setStatus() {} },
  hasUI: false,
};
let busy = false;
let turns = 0;

const emit = async (name, event) => {
  for (const h of handlers.get(name) ?? []) await h(event, ctx);
};

const pi = {
  on(name, h) {
    handlers.set(name, [...(handlers.get(name) ?? []), h]);
  },
  registerCommand(name) {
    commands.push(name);
  },
  registerTool(t) {
    tools.push(t?.name);
  },
  sendMessage() {},
  events: { emit() {}, on() {} },
  sendUserMessage(text) {
    if (text.startsWith("/") || busy) return;
    busy = true;
    const id = `smoke-tool-${++turns}`;
    void emit("agent_start", {});
    void emit("tool_execution_start", { toolCallId: id, toolName: "smoke-tool" });
    setTimeout(async () => {
      await emit("tool_execution_end", { toolCallId: id, toolName: "smoke-tool" });
      let reply = `smoke-echo: ${text}`;
      if (text.startsWith("smoke-sh: ")) {
        const r = spawnSync("sh", ["-c", text.slice("smoke-sh: ".length)], {
          encoding: "utf8",
          timeout: 60_000,
        });
        reply = `smoke-sh exit=${r.status ?? "signal"} cwd=${process.cwd()}\n${r.stdout ?? ""}${r.stderr ?? ""}`;
      }
      await emit("agent_end", {
        messages: [{ role: "assistant", content: [{ type: "text", text: reply }] }],
      });
      busy = false;
      await emit("agent_settled", {});
      console.log(`smoke-ext-pi: settled turn ${turns}`);
    }, TURN_MS);
  },
};

const mod = await import(pathToFileURL(process.env.SMOKE_EXT).href);
if (typeof mod.default !== "function") {
  console.error("smoke-ext-pi: the extension has no default export");
  process.exit(2);
}
mod.default(pi);
writeFileSync(
  join(process.env.HOME ?? ".", "smoke-ext-registration.json"),
  JSON.stringify({ events: [...handlers.keys()].sort(), commands, tools }),
);
await emit("session_start", { reason: "startup" });
console.log("smoke-ext-pi: extension loaded, ctl served by it");

let down = false;
const stop = async () => {
  if (down) return;
  down = true;
  try {
    await emit("session_shutdown", { reason: "quit" });
  } finally {
    process.exit(0);
  }
};
for (const s of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(s, stop);
setInterval(() => {}, 1 << 30);
