// herdr IO against a REAL herdr server.
//
// SELF-SKIPS unless `MU_HERDR_SESSION` names a herdr session whose
// server already reports running + compatible. It never starts, stops,
// or deletes a server, and never touches the DEFAULT session: the
// isolated session is the operator's to provide, e.g.
//
//   herdr --session mu-iotest server &
//   MU_HERDR_SESSION=mu-iotest npm run test -- mux-herdr-io.integration
//
// The fast tier excludes this file by suffix.
//
// Every real herdr call goes through `herdrTestExec()` (or the backend,
// which reads the same MU_HERDR_SESSION), and the file asserts
// isolation up front: MU_HERDR_SESSION=default fails loudly instead of
// creating a workspace in the user's real server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  capturePane,
  isHerdrStatusUsable,
  resetHerdrExecutor,
  sendToPane,
} from "../src/mux/herdr.js";
import { assertHerdrIsolated, herdrTestExec } from "./_mux.js";

const SESSION = process.env.MU_HERDR_SESSION;
/** Unset or empty: the operator did not opt in, so self-skip. Anything
 *  else must pass `assertHerdrIsolated()`, which refuses "default"
 *  outright: a stray create/close there would land in the user's real
 *  panes. */
const OPTED_IN = SESSION !== undefined && SESSION.length > 0;
if (OPTED_IN) assertHerdrIsolated();

async function herdrCli(args: readonly string[]): Promise<{ stdout: string; ok: boolean }> {
  if (!OPTED_IN) return { stdout: "", ok: false };
  const r = await herdrTestExec(args).catch(() => undefined);
  if (r === undefined) return { stdout: "", ok: false };
  return { stdout: r.stdout, ok: r.exitCode === 0 };
}

function readResult(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) return {};
  const inner = (parsed as { result?: unknown }).result;
  return typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : {};
}

let ready = false;
let workspaceId: string | undefined;
let paneId: string | undefined;

beforeAll(async () => {
  if (!OPTED_IN) return;
  const status = await herdrCli(["status"]);
  if (!status.ok) return;
  if (!isHerdrStatusUsable(status.stdout)) return;
  ready = true;

  const label = `mu-iotest-${process.pid}-${Date.now()}`;
  const created = await herdrCli(["workspace", "create", "--label", label, "--no-focus"]);
  if (!created.ok) {
    ready = false;
    return;
  }
  const result = readResult(created.stdout);
  const ws = result.workspace;
  const root = result.root_pane;
  const wsId = typeof ws === "object" && ws !== null ? (ws as Record<string, unknown>) : {};
  const rootPane =
    typeof root === "object" && root !== null ? (root as Record<string, unknown>) : {};
  workspaceId = typeof wsId.workspace_id === "string" ? wsId.workspace_id : undefined;
  paneId = typeof rootPane.pane_id === "string" ? rootPane.pane_id : undefined;
  ready = paneId !== undefined;
}, 30_000);

afterAll(async () => {
  resetHerdrExecutor();
  // Close only the workspace WE created. Never the session, never the
  // server, never anything pre-existing.
  if (workspaceId !== undefined) await herdrCli(["workspace", "close", workspaceId]);
}, 20_000);

describe("herdr IO against a real server", () => {
  // ctx.skip() rather than `return`: an absent server must report as
  // skipped, not as a green pass that ran nothing.
  it("sendToPane reaches a plain shell pane via the pane-surface fallback", async (ctx) => {
    if (!ready || paneId === undefined) return ctx.skip();
    // No recognized agent in a fresh shell pane, so `agent prompt`
    // answers agent_not_found and sendToPane retries via `pane run`.
    await sendToPane(paneId, "echo mu-io-probe-42");
    let seen = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      seen = await capturePane(paneId, { lines: 50 });
      if (seen.includes("mu-io-probe-42")) break;
    }
    expect(seen).toContain("mu-io-probe-42");
  }, 20_000);

  it("capturePane returns plain text, not a JSON envelope", async (ctx) => {
    if (!ready || paneId === undefined) return ctx.skip();
    const visible = await capturePane(paneId, { lines: 0 });
    expect(typeof visible).toBe("string");
    expect(() => JSON.parse(visible)).toThrow();
  }, 20_000);
});
