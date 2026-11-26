// A scripted model for scripts/smoke-remote-workspace.sh: a pi extension that registers
// pi-ai's faux provider as "smoke/scripted". Real pi runs the turn: it calls
// the tools the active extensions registered (the mule workspace extension's
// read/write/edit/bash), so every tool call goes through the real stack. No
// network, no credentials.
//
// A prompt "smoke-turn <json>" scripts one turn. <json> is {"steps": [[call,
// ...], ...]}: each step is one assistant message whose calls pi runs (in
// parallel when there are several), and call is {"tool": name, "args": {...}}.
// A call may add "fill": {"key": k, "bytes": n}, which sets args[k] to
// fillText(n) (a 200 KB write never travels through the send). Call ids are
// t<turn>s<step>c<call>. After the last step the model writes
// $SMOKE_RESULTS/<tag>.json (tag from the script): one {id, tool, error, text}
// per tool result of the turn, text cut to 4000 characters; it answers
// "smoke-results <tag> calls=<n> errors=<n>". Any other prompt gets
// "smoke-echo: <text>".

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const TEXT_CAP = 4000;

/** n bytes of ASCII, the same as smoke-remote-workspace.sh's expected content. */
export function fillText(n) {
  let s = "";
  for (let i = 0; s.length < n; i++) s += `remote-workspace line ${i}\n`;
  return s.slice(0, n);
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("\n");

function reply(context) {
  const messages = context.messages ?? [];
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      last = i;
      break;
    }
  }
  const prompt = last === -1 ? "" : textOf(messages[last].content).trim();
  if (!prompt.startsWith("smoke-turn ")) return fauxAssistantMessage(`smoke-echo: ${prompt}`);
  let script;
  try {
    script = JSON.parse(prompt.slice("smoke-turn ".length));
  } catch (err) {
    return fauxAssistantMessage(`smoke-error: bad script: ${String(err)}`);
  }
  // Call ids are unique in the session, as a real model's are: the mule
  // extension keys a job by session and call id, so a repeated id reattaches.
  const turn = messages.filter((m) => m?.role === "user").length;
  const after = messages.slice(last + 1);
  const step = after.filter((m) => m?.role === "assistant").length;
  const steps = Array.isArray(script.steps) ? script.steps : [];
  if (step < steps.length) {
    const calls = steps[step].map((call, j) => {
      const args = { ...(call.args ?? {}) };
      if (call.fill) args[call.fill.key] = fillText(call.fill.bytes);
      return fauxToolCall(call.tool, args, { id: `t${turn}s${step}c${j}` });
    });
    return fauxAssistantMessage(calls, { stopReason: "toolUse" });
  }
  const results = after
    .filter((m) => m?.role === "toolResult")
    .map((m) => ({
      id: m.toolCallId,
      tool: m.toolName,
      error: m.isError === true,
      text: textOf(m.content).slice(0, TEXT_CAP),
    }));
  // mu's lastText keeps only a tail: the results go to a file, the text names it.
  const tag = /^[A-Za-z0-9_-]+$/.test(script.tag ?? "") ? script.tag : `turn${turn}`;
  writeFileSync(join(process.env.SMOKE_RESULTS ?? ".", `${tag}.json`), JSON.stringify(results));
  const errors = results.filter((r) => r.error).length;
  return fauxAssistantMessage([
    fauxText(`smoke-results ${tag} calls=${results.length} errors=${errors}`),
  ]);
}

export default function (pi) {
  // One chunk per block: a 200 KB argument is not re-parsed per small delta.
  const faux = fauxProvider({
    provider: "smoke",
    api: "smoke-faux",
    models: [
      { id: "scripted", name: "Smoke scripted", contextWindow: 1_000_000, maxTokens: 1_000_000 },
    ],
    tokenSize: { min: 1 << 22, max: 1 << 22 },
  });
  const next = (context) => {
    faux.appendResponses([next]);
    return reply(context);
  };
  faux.setResponses([next]);
  pi.registerProvider(faux.provider);
}
