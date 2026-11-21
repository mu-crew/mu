// Shared by the standalone fake and the handshake-only pipe peer.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const schema = new URL("../schemas/plugin-protocol-v1.json", import.meta.url);
const digest = `sha256:${createHash("sha256").update(readFileSync(schema)).digest("hex")}`;
const defaultSeams = {
  link: {
    fetch: true,
    slots: "self",
    remoteOnTimeout: "stopped",
    quiescence: "provable",
    maxScriptBytes: 131072,
    checks: ["reach"],
  },
};

export function initializeReply(c, id, params) {
  const [min, max] = c.speaks ?? [1, 1];
  const offered = params?.protocol ?? { min: 0, max: 0 };
  const hi = Math.min(max, offered.max);
  const common = hi >= Math.max(min, offered.min) ? hi : null;
  if (common === null && !c.liar) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: `no common protocol version: the fake speaks ${min}..${max}`,
        data: { kind: "permanent" },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocol: common ?? max,
      plugin: { name: c.name ?? "fake", version: c.version ?? "0.1.0" },
      instance: c.instance ?? "fake-1",
      schema: c.schema ?? digest,
      seams: c.seams ?? defaultSeams,
    },
  };
}
