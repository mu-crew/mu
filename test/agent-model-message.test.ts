// The refusal's suggested command must be one `mu agent spawn` accepts:
// `--cli` is a harness key, the model goes through `--model`.

import { describe, expect, it } from "vitest";
import { AgentModelNeedsCtlError } from "../src/agents/errors.js";

describe("AgentModelNeedsCtlError", () => {
  it("suggests spawning with --model, never a command string in --cli", () => {
    const msg = new AgentModelNeedsCtlError("w1", "demo", "hooks").message;
    expect(msg).toContain("mu agent spawn ... --model <provider/id> -w demo");
    expect(msg).not.toMatch(/--cli '/);
  });
});
