// mu — deliver a prompt to an agent through its channel.
//
// `deliver` is the one delivery entry point for a prompt: it picks the
// agent's channel (`agentChannel`, from the row) and calls its `send`, or its
// `fresh` for `--fresh`. Each channel decides the rest: ctl runs a session
// command over its `command` op and refuses any other slash command; mux hands
// the text to the backend's `sendToPane`, or refuses on tmux. Nothing falls
// back to another channel.

import { agentChannel } from "./dispatch.js";
import type { DeliveryOptions, DeliveryTarget, SendResult } from "./types.js";

export function deliver(
  target: DeliveryTarget,
  text: string,
  opts: DeliveryOptions & { fresh?: boolean },
): Promise<SendResult> {
  const channel = agentChannel(target);
  return opts.fresh ? channel.fresh(target, text, opts) : channel.send(target, text, opts);
}
