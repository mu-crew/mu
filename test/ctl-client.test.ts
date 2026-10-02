import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CtlTimeoutError,
  CtlUnknownOpError,
  CtlVersionError,
  ctlProbe,
  ctlRequest,
} from "../src/ctl/client.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";

let dir: string;
let servers: Server[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muc-"));
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  rmSync(dir, { recursive: true, force: true });
});

/** Serve a unix socket whose handler answers each request line. */
async function serve(onLine: (line: string, sock: Socket) => void): Promise<string> {
  const path = join(dir, "s.sock");
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) onLine(line, sock);
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return path;
}

const IDLE = { state: "idle", since: 1, runs: 0, pending: false };

describe("LineDecoder", () => {
  it("splits on \\n and buffers the partial tail", () => {
    const d = new LineDecoder();
    expect(d.push("a\nb\nc")).toEqual(["a", "b"]);
    expect(d.push("d\n")).toEqual(["cd"]);
  });

  it("does not split on U+2028 / U+2029", () => {
    const d = new LineDecoder();
    expect(d.push("x\u2028y\u2029z\n")).toEqual(["x\u2028y\u2029z"]);
  });

  it("round-trips encode", () => {
    const d = new LineDecoder();
    const msg = { op: "send", text: "line1\nline2\u2028" };
    const lines = d.push(encode(msg));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(msg);
  });
});

describe("ctlProbe", () => {
  it("reports missing for a nonexistent path", async () => {
    expect(await ctlProbe(join(dir, "nope.sock"))).toEqual({ kind: "missing" });
  });

  it("reports refused for a regular file (stale socket stand-in)", async () => {
    const p = join(dir, "f.sock");
    writeFileSync(p, "");
    const r = await ctlProbe(p);
    expect(r.kind).toBe("refused");
  });

  it("returns status from a v1 server", async () => {
    const seen: string[] = [];
    const p = await serve((line, sock) => {
      const req = JSON.parse(line) as { op: string };
      seen.push(req.op);
      sock.end(
        encode(
          req.op === "hello" ? { v: 1, ok: true, piVersion: "x" } : { v: 1, ok: true, ...IDLE },
        ),
      );
    });
    expect(await ctlProbe(p)).toEqual({ kind: "ok", status: IDLE });
    expect(seen).toEqual(["hello", "status"]);
  });

  it("carries hello's ops and extVersion on an ok probe", async () => {
    const p = await serve((line, sock) => {
      const req = JSON.parse(line) as { op: string };
      sock.end(
        encode(
          req.op === "hello"
            ? { v: 1, ok: true, ops: ["hello", "status"], extVersion: "3.1.0" }
            : { v: 1, ok: true, ...IDLE },
        ),
      );
    });
    expect(await ctlProbe(p)).toEqual({
      kind: "ok",
      status: IDLE,
      ops: ["hello", "status"],
      extVersion: "3.1.0",
    });
  });

  it("reports version for a reply without v", async () => {
    const p = await serve((_line, sock) => {
      sock.end(encode({ ok: true, ...IDLE }));
    });
    expect(await ctlProbe(p)).toEqual({ kind: "version", got: undefined });
  });

  it("reports refused when the server never replies", async () => {
    const p = await serve(() => {});
    const r = await ctlProbe(p, 100);
    expect(r.kind).toBe("refused");
  });
});

describe("ctlRequest", () => {
  it("sends one line and returns the reply", async () => {
    let got: unknown;
    const p = await serve((line, sock) => {
      got = JSON.parse(line);
      sock.end(encode({ v: 1, ok: true }));
    });
    const reply = await ctlRequest(p, { op: "send", text: "hi", mode: "steer" });
    expect(reply).toEqual({ v: 1, ok: true });
    expect(got).toEqual({ op: "send", text: "hi", mode: "steer" });
  });

  it("returns an ok:false reply as-is", async () => {
    const p = await serve((_l, sock) => sock.end(encode({ v: 1, ok: false, error: "boom" })));
    expect(await ctlRequest(p, { op: "abort" })).toEqual({ v: 1, ok: false, error: "boom" });
  });

  it("throws CtlUnknownOpError, with the served ops, on an unknown-op refusal", async () => {
    const p = await serve((_l, sock) =>
      sock.end(encode({ v: 1, ok: false, error: "unknown op: fresh", ops: ["hello"] })),
    );
    const err = await ctlRequest(p, { op: "fresh", text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CtlUnknownOpError);
    expect(err).toMatchObject({ op: "fresh", ops: ["hello"] });
  });

  it("throws CtlVersionError on an unknown version", async () => {
    const p = await serve((_l, sock) => sock.end(encode({ v: 2, ok: true })));
    await expect(ctlRequest(p, { op: "status" })).rejects.toBeInstanceOf(CtlVersionError);
  });

  it("times out against a server that never replies", async () => {
    const p = await serve(() => {});
    const t0 = Date.now();
    await expect(ctlRequest(p, { op: "status" }, { timeoutMs: 150 })).rejects.toBeInstanceOf(
      CtlTimeoutError,
    );
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it("wait defaults its client timeout to timeoutMs + 5s", async () => {
    const p = await serve((_l, sock) => {
      setTimeout(() => sock.end(encode({ v: 1, ok: true, ...IDLE, runs: 1 })), 30);
    });
    const reply = await ctlRequest(p, { op: "wait", afterRuns: 0, timeoutMs: 10 });
    expect(reply).toMatchObject({ ok: true, runs: 1 });
  });

  it("rejects when the server closes without replying", async () => {
    const p = await serve((_l, sock) => sock.end());
    await expect(ctlRequest(p, { op: "status" })).rejects.toThrow(/closed/);
  });
});
