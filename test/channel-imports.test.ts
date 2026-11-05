// The channel seam holds (spec D4, U5, U6): the call sites that read an
// agent's state, watch its run, count its baseline, ask a receipt, fence a
// write, read its last text, or deliver to it (send, fresh, command,
// interrupt, abort) import those from src/channels, never from src/ctl. The
// files that still import src/ctl are listed with exactly what they import:
// a new importer, or a new symbol in a listed one, fails here.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** The call sites that reach a pane agent's channel through src/channels only. */
const CHANNEL_CALL_SITES = [
  "src/agent-state.ts",
  "src/agents/abort.ts",
  "src/agents/observe.ts",
  "src/agents/task-spawn.ts",
  "src/agents/transport.ts",
  "src/auto-attempt.ts",
  "src/cli/agents.ts",
  "src/close-notice.ts",
  "src/dashboard-data.ts",
  "src/next-recover.ts",
  "src/next-refute.ts",
  "src/wait-actions.ts",
  "src/wait-ctl.ts",
  "src/wait-types.ts",
];

/**
 * The verb call sites: each reaches an agent through a channel entry point,
 * not just a type, so the seam cannot sit unused behind them.
 */
const VERB_CALL_SITES = [
  "src/agents/observe.ts",
  "src/agents/task-spawn.ts",
  "src/cli/agents.ts",
  "src/next-recover.ts",
  "src/next-refute.ts",
  "src/wait-actions.ts",
  "src/wait-ctl.ts",
];

/** The channel entry points a verb call site reaches an agent through. */
const CHANNEL_ENTRY_POINTS = ["agentChannel", "ctlChannel", "deliver", "readAgentStates"];

/**
 * The delivery call sites (U6): each sends, freshens, interrupts or aborts an
 * agent through `deliver` or its `agentChannel`, the routes that read the
 * channel from the agents row. `ctlChannel` alone is not enough here: a
 * delivery must never assume ctl.
 */
const DELIVERY_CALL_SITES = [
  "src/agents.ts",
  "src/agents/abort.ts",
  "src/agents/task-spawn.ts",
  "src/agents/transport.ts",
  "src/cli/agents.ts",
  "src/close-notice.ts",
  "src/wait-actions.ts",
];
const DELIVERY_ENTRY_POINTS = ["agentChannel", "deliver"];

/** The delivery verbs of `AgentChannel` (answer since U8), and the raw ctl ops they replace. */
const DELIVERY_VERBS = ["send", "fresh", "command", "interrupt", "abort", "answer"];
const CTL_DELIVERY_NAMES = [
  "ctlFailure",
  "ctlRequestFor",
  "ctlSendWithReceipt",
  "fencedHello",
  "runSessionCommand",
];

/**
 * ctl's raw-socket functions: they take a socket path, so a caller holding one
 * bypasses `AgentChannel`. The barrel does not export them; only these files
 * import them from src/channels/ctl.ts (the SDK hubs re-export them).
 */
const RAW_CTL_NAMES = ["checkMessage", "ctlRuntimeState", "watchAgentRun"];
const RAW_CTL_IMPORTERS = ["src/agents.ts", "src/index.ts"];

/**
 * Files outside src/ctl and src/channels that still import src/ctl, and the
 * only symbols each may import. Stays on ctl by D4: delegates, the spawn
 * handshake, doctor and host check, the lease carrier and remote socket
 * plumbing, and the socket file's cleanup. Delivery (send, interrupt, fresh,
 * command, abort) is on the channel since U6.
 */
const CTL_IMPORTS: Record<string, readonly string[]> = {
  // socket file cleanup on close and teardown
  "src/agents.ts": ["unlinkCtlSocket"],
  "src/agents/close.ts": ["unlinkCtlSocket"],
  "src/workstream.ts": ["unlinkCtlSocket"],
  // delegates: child pi processes, not panes
  "src/delegate-process.ts": [
    "CTL_SOCK_ENV",
    "CtlDeliveryUnknownError",
    "CtlProbe",
    "ctlProbe",
    "ctlRequest",
    "ctlSocketPath",
    "errCode",
  ],
  // doctor and host check
  "src/doctor-summary.ts": ["CTL_OPS", "CtlProbe", "ctlProbe", "ctlSocketPath"],
  "src/hosts.ts": ["ctlProbe", "ctlSocketPath"],
  // the spawn handshake, the lease carrier and remote socket plumbing
  "src/agents/spawn.ts": ["CTL_SOCK_ENV", "ctlSocketPath"],
  "src/agents/spawn-ready.ts": ["CtlProbe", "ctlProbe"],
  "src/agents/lease-carrier.ts": ["carrierJobFilePath"],
  "src/remote-agent.ts": ["remoteCtlSocketPath"],
};

interface ImportStmt {
  /** Repo-relative POSIX path of the imported module. */
  target: string;
  names: string[];
  /** Erased at runtime: `import type`, or every name marked `type`. */
  typeOnly: boolean;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

const repoPath = (abs: string): string => relative(ROOT, abs).split(sep).join("/");

/** Every static `import … from` / `export … from` of a relative module in `file`. */
function importsOf(file: string, text: string): ImportStmt[] {
  const out: ImportStmt[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(\.[^"]+)"/g;
  for (const m of text.matchAll(re)) {
    const [, typeKw, clause = "", spec = ""] = m;
    const target = posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, ".ts");
    const braced = /\{([\s\S]*)\}/.exec(clause)?.[1];
    const parts = (braced ?? clause)
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "" && n !== "*");
    const names = parts.flatMap((n) => n.replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? []);
    const typeOnly = typeKw !== undefined || parts.every((n) => n.startsWith("type "));
    out.push({ target, names, typeOnly });
  }
  return out;
}

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const isCtl = (target: string): boolean => target.startsWith("src/ctl/");
const isChannels = (target: string): boolean => target.startsWith("src/channels/");
/** The modules a call site may import channels from: the barrel, or bare types. */
const CHANNEL_FACES = ["src/channels/index.ts", "src/channels/types.ts"];

describe("channel import boundary", () => {
  it("the import parser sees multi-line, type-only and renamed imports", () => {
    const text = [
      'import type { A } from "./ctl/protocol.js";',
      "import {",
      "  b,",
      "  type C,",
      "  d as e,",
      '} from "../ctl/client.js";',
      'export { f } from "./channels/index.js";',
    ].join("\n");
    expect(importsOf("src/agents/x.ts", text)).toEqual([
      { target: "src/agents/ctl/protocol.ts", names: ["A"], typeOnly: true },
      { target: "src/ctl/client.ts", names: ["b", "C", "d"], typeOnly: false },
      { target: "src/agents/channels/index.ts", names: ["f"], typeOnly: false },
    ]);
  });

  it.each(CHANNEL_CALL_SITES)(
    "%s imports no src/ctl module and reads channels from src/channels",
    (file) => {
      const imports = importsOf(file, read(file));
      expect(imports.filter((i) => isCtl(i.target))).toEqual([]);
      expect(imports.some((i) => isChannels(i.target))).toBe(true);
      expect(
        imports.filter((i) => isChannels(i.target) && !CHANNEL_FACES.includes(i.target)),
      ).toEqual([]);
      // From any module, hubs included: no raw ctl function, no namespace import.
      const names = imports.flatMap((i) => i.names);
      expect(names.filter((n) => RAW_CTL_NAMES.includes(n) || n === "*")).toEqual([]);
    },
  );

  it.each(VERB_CALL_SITES)("%s reaches agents through a channel entry point", (file) => {
    const used = importsOf(file, read(file))
      .filter((i) => isChannels(i.target) && !i.typeOnly)
      .flatMap((i) => i.names)
      .filter((n) => CHANNEL_ENTRY_POINTS.includes(n));
    expect(used).not.toEqual([]);
  });

  it("the barrel exports no raw-socket ctl function", async () => {
    const barrel: Record<string, unknown> = await import("../src/channels/index.js");
    expect(RAW_CTL_NAMES.filter((n) => n in barrel)).toEqual([]);
  });

  it("only the listed files import src/channels/ctl.ts", () => {
    const found = sourceFiles(SRC)
      .map(repoPath)
      .filter((file) => !file.startsWith("src/channels/"))
      .filter((file) =>
        importsOf(file, read(file)).some((i) => i.target === "src/channels/ctl.ts"),
      );
    expect(found.sort()).toEqual([...RAW_CTL_IMPORTERS].sort());
  });

  it("every verb call site is a listed call site", () => {
    expect(VERB_CALL_SITES.filter((f) => !CHANNEL_CALL_SITES.includes(f))).toEqual([]);
  });

  it("only the listed files import src/ctl, and only the listed symbols", () => {
    const found: Record<string, string[]> = {};
    for (const abs of sourceFiles(SRC)) {
      const file = repoPath(abs);
      if (file.startsWith("src/ctl/") || file.startsWith("src/channels/")) continue;
      const names = importsOf(file, readFileSync(abs, "utf8"))
        .filter((i) => isCtl(i.target))
        .flatMap((i) => i.names);
      if (names.length > 0) found[file] = [...new Set(names)].sort();
    }
    const expected = Object.fromEntries(
      Object.entries(CTL_IMPORTS).map(([f, n]) => [f, [...n].sort()]),
    );
    expect(found).toEqual(expected);
  });

  it("no listed call site is also allowed to import src/ctl", () => {
    expect(CHANNEL_CALL_SITES.filter((f) => f in CTL_IMPORTS)).toEqual([]);
  });

  it("src/channels takes no runtime import from a hub that re-exports it", () => {
    const hubs = ["src/agents.ts", "src/index.ts"];
    for (const abs of sourceFiles(join(SRC, "channels"))) {
      const file = repoPath(abs);
      const bad = importsOf(file, readFileSync(abs, "utf8")).filter(
        (i) => !i.typeOnly && hubs.includes(i.target),
      );
      expect(bad, file).toEqual([]);
    }
  });

  it.each(DELIVERY_CALL_SITES)("%s delivers through deliver or agentChannel", (file) => {
    const imports = importsOf(file, read(file));
    const used = imports
      .filter((i) => isChannels(i.target) && !i.typeOnly)
      .flatMap((i) => i.names)
      .filter((n) => DELIVERY_ENTRY_POINTS.includes(n));
    expect(used).not.toEqual([]);
    // No ctl delivery op from src/ctl, and none of the old transport helpers from anywhere.
    expect(imports.filter((i) => isCtl(i.target) && !(file in CTL_IMPORTS))).toEqual([]);
    const names = imports.flatMap((i) => i.names);
    expect(
      names.filter((n) => CTL_DELIVERY_NAMES.includes(n) || RAW_CTL_NAMES.includes(n)),
    ).toEqual(file === "src/agents.ts" ? ["checkMessage", "watchAgentRun"] : []);
  });

  it("no delivery call site sends through ctlChannel directly", () => {
    // `ctlChannel.receipt(...)` asks about an earlier ctl write; a delivery verb on it would skip the row.
    const verb = new RegExp(`ctlChannel\\.(${DELIVERY_VERBS.join("|")})\\(`);
    expect(DELIVERY_CALL_SITES.filter((f) => verb.test(read(f)))).toEqual([]);
  });

  it("no file outside src/channels imports ctl delivery or the delivery router by path", () => {
    const found = sourceFiles(SRC)
      .map(repoPath)
      .filter((file) => !file.startsWith("src/channels/"))
      .filter((file) =>
        importsOf(file, read(file)).some(
          (i) =>
            i.target === "src/channels/ctl-deliver.ts" || i.target === "src/channels/deliver.ts",
        ),
      );
    expect(found).toEqual([]);
  });

  it("every delivery call site but the hub is a listed call site", () => {
    expect(
      DELIVERY_CALL_SITES.filter((f) => f !== "src/agents.ts" && !CHANNEL_CALL_SITES.includes(f)),
    ).toEqual([]);
  });
});
