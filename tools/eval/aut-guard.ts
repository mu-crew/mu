// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// pi extension a pi AUT loads (runner.ts, staged into <sandbox>/.rt/lib): refuses a tool call
// that names the rig and cuts every line that names it from a tool result, so the rig's scenario
// sources, judges and rows never reach the model. The guard (roots, own sandbox, HOME) is the JSON
// file $EVAL_RIG_GUARD. A result that carries a rig file's canary (rig-private.ts: a read the
// path rules missed) is withheld whole. rig-guard.ts rigReads is the backstop: it counts a
// withheld result as a rig read.
import { readFileSync } from "node:fs";
import { BLOCKED, type RigGuard, redactRig, rigInInput, WITHHELD } from "./rig-guard.ts";
import { hasCanary } from "./rig-private.ts";

/** Typed structurally so pi stays a peer (as faux.ts does). */
interface PiLike {
  on(event: string, handler: (event: never) => unknown): void;
}

interface ContentPart {
  type?: string;
  text?: string;
}

export default function autGuard(pi: PiLike): void {
  const file = process.env.EVAL_RIG_GUARD;
  if (!file) return;
  const g = JSON.parse(readFileSync(file, "utf8")) as RigGuard;
  pi.on("tool_call", (e: { input?: unknown }) =>
    rigInInput(e.input, g).length > 0 ? { block: true, reason: BLOCKED } : undefined,
  );
  pi.on("tool_result", (e: { content?: unknown }) => {
    if (!Array.isArray(e.content)) return undefined;
    const parts = e.content as ContentPart[];
    if (parts.some((p) => typeof p.text === "string" && hasCanary(p.text)))
      return { content: [{ type: "text", text: WITHHELD }] };
    let cut = 0;
    const content = parts.map((p) => {
      if (p.type !== "text" || typeof p.text !== "string") return p;
      const r = redactRig(p.text, g);
      cut += r.cut;
      return { ...p, text: r.text };
    });
    return cut > 0 ? { content } : undefined;
  });
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
