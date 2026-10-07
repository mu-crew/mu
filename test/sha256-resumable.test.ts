import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Digest, sha256Initial, sha256Update } from "../src/sha256-resumable.js";

const nodeSha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("sha256-resumable", () => {
  it("matches node:crypto across padding boundaries", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const bytes = Buffer.alloc(n, 0x61 + (n % 26));
      expect(sha256Digest(sha256Update(sha256Initial(), bytes))).toBe(nodeSha(bytes));
    }
  });

  it("resumes from a JSON round-tripped state in arbitrary chunks", () => {
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) % 256));
    let state = sha256Initial();
    for (let i = 0; i < bytes.length; ) {
      const step = 1 + ((i * 7) % 150);
      state = JSON.parse(JSON.stringify(sha256Update(state, bytes.subarray(i, i + step))));
      i += step;
    }
    expect(state.n).toBe(bytes.length);
    expect(sha256Digest(state)).toBe(nodeSha(bytes));
  });
});
