// Fake-extension helpers for tests that stand in for the mu pi extension.
// A current extension answers `hello` with its ops and features; the CLI
// asks before it relies on msgId or incarnation (served-ops check).

import { CTL_FEATURES, CTL_OPS } from "../src/ctl/protocol.js";

/** The incarnation every fake extension reports unless a test says otherwise. */
export const INC = "inc-test-1";

/** A current extension's hello reply. */
export function helloReply(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    ok: true,
    ops: [...CTL_OPS],
    features: [...CTL_FEATURES],
    incarnation: INC,
    extVersion: "3.99.0",
    ...over,
  };
}

/** `hello` answers helloReply(); anything else answers `reply` (incarnation added to ok replies). */
export function withHello(
  req: { op?: unknown },
  reply: Record<string, unknown>,
  hello: Record<string, unknown> = helloReply(),
): Record<string, unknown> {
  if (req.op === "hello") return hello;
  return reply.ok === true && reply.incarnation === undefined
    ? { ...reply, incarnation: INC }
    : reply;
}
