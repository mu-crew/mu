// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import type { RunMetrics } from "../../tools/eval/types.ts";

export const emptyRun = (): RunMetrics => ({
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0 },
  turns: 0,
  toolCalls: [],
  muCalls: 0,
  muErrors: 0,
  prods: 0,
  wallMs: 0,
  aborted: null,
  lastError: null,
  finalText: "",
  events: [],
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
