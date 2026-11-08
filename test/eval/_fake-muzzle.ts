// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// A fake muzzle for the claim tests (tools/eval/claim.ts): holders that admit at once (or exit
// first), a `muzzle status --json` that lists the live holders, and a fixed ancestry so no `ps` runs.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  type MuzzleStatus,
  setAncestryForTests,
  setClaimSpawnForTests,
  setStatusForTests,
} from "../../tools/eval/claim.ts";

let nextPid = 900_000;

export class FakeHolder extends EventEmitter {
  pid = nextPid++;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  ended = false;
  stdin = {
    end: () => {
      this.ended = true;
      setImmediate(() => this.emit("close", 0));
    },
  };
}

export interface FakeMuzzle {
  args: string[][];
  held: number;
  peak: number;
  holders: FakeHolder[];
  /** Holders live right now, as `muzzle status` lists them. */
  live: Set<FakeHolder>;
}

export interface FakeMuzzleOpts {
  /** Every holder exits with this code before admission. */
  failCode?: number;
  /** Holders run nested: admitted, but `muzzle status` never lists them. */
  nested?: boolean;
  /** Extra holders `muzzle status` lists (an outer claim). */
  others?: MuzzleStatus["holders"];
  /** `muzzle status --json` fails. */
  statusFails?: boolean;
  budget?: number;
  /** The rig's ancestry (pid, pgid), default just this process. */
  ancestors?: { pid: number; pgid: number }[];
}

export function fakeMuzzle(o: FakeMuzzleOpts = {}): FakeMuzzle {
  const m: FakeMuzzle = { args: [], held: 0, peak: 0, holders: [], live: new Set() };
  setClaimSpawnForTests((_bin, args) => {
    const h = new FakeHolder();
    m.args.push(args);
    m.holders.push(h);
    setImmediate(() => {
      if (o.failCode !== undefined) {
        h.stderr.emit("data", Buffer.from("muzzle: gave up after 1s queued"));
        h.emit("close", o.failCode);
        return;
      }
      if (!o.nested) {
        m.held++;
        m.peak = Math.max(m.peak, m.held);
        m.live.add(h);
      }
      h.on("close", () => {
        if (m.live.delete(h)) m.held--;
      });
      h.stdout.emit("data", Buffer.from("admitted\n"));
    });
    return h as unknown as ChildProcess;
  });
  setStatusForTests(() =>
    o.statusFails
      ? null
      : {
          budget: o.budget ?? 22,
          holders: [
            ...(o.others ?? []),
            ...[...m.live].map((h) => ({ slots: 1, pid: h.pid, pgid: h.pid + 1 })),
          ],
        },
  );
  setAncestryForTests(() => o.ancestors ?? [{ pid: process.pid, pgid: process.pid }]);
  return m;
}

export function resetFakeMuzzle(): void {
  setClaimSpawnForTests(null);
  setStatusForTests(null);
  setAncestryForTests(null);
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
