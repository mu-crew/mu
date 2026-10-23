// pi extension: a scripted faux model. Registers provider "evalfaux" with models "aut" and "worker".
//   evalfaux/aut    script from $EVAL_FAUX_SCRIPT (the AUT selftest)
//   evalfaux/worker script from $EVAL_WORKER_DIR by $MU_AGENT_NAME and attempt (workers, delegates)
// Step selection lives in faux-steps.ts. pi's faux provider only ESTIMATES tokens: usage.total > 0,
// cost 0.
import {
  type FauxContext,
  type FauxMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type FauxAction,
  FauxScript,
  loadAutScript,
  loadWorkerScript,
  type StepContext,
} from "./faux-steps.ts";

export type { FauxStep } from "./faux-steps.ts";

/** Typed structurally so pi stays a peer (as extension/mu-pi.ts does). */
interface PiLike {
  registerProvider(provider: unknown): void;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : ""))
    .filter((t) => t !== "")
    .join("\n");
}

function stepContext(context: FauxContext): StepContext {
  const msgs = context.messages;
  let lastUser = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "user") {
      lastUser = textOf(m.content);
      break;
    }
  }
  const last = msgs[msgs.length - 1];
  return { lastUser, lastResult: last?.role === "toolResult" ? textOf(last.content) : null };
}

function toMessage(action: FauxAction): FauxMessage {
  switch (action.kind) {
    case "calls":
      return fauxAssistantMessage(
        action.calls.map((c) => fauxToolCall(c.name, c.args)),
        { stopReason: "toolUse" },
      );
    case "text":
      return fauxAssistantMessage(fauxText(action.text));
    case "error":
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: action.message });
    case "die":
      process.exit(137);
  }
}

export default function (pi: PiLike): void {
  const faux = fauxProvider({
    provider: "evalfaux",
    models: [{ id: "aut" }, { id: "worker" }],
  });
  const workerDir = process.env.EVAL_WORKER_DIR ?? null;
  const scripts = new Map<string, FauxScript>();

  const script = (modelId: string): FauxScript => {
    const existing = scripts.get(modelId);
    if (existing) return existing;
    const created =
      modelId === "aut"
        ? new FauxScript(loadAutScript(process.env.EVAL_FAUX_SCRIPT), workerDir, "aut")
        : (() => {
            const agent = process.env.MU_AGENT_NAME || "worker";
            return new FauxScript(
              workerDir ? loadWorkerScript(workerDir, agent) : [],
              workerDir,
              agent,
            );
          })();
    scripts.set(modelId, created);
    return created;
  };

  // pi's faux provider consumes one queued response per model call; requeue ourselves each time.
  const respond = (context: FauxContext, _o: unknown, _s: unknown, model: { id: string }) => {
    faux.appendResponses([respond]);
    return toMessage(script(model.id).next(stepContext(context)));
  };
  faux.setResponses([respond]);
  pi.registerProvider(faux.provider);
}
