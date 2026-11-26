// OSC 7501 "waiting" sub-record: while delegates are in flight the pane
// reports `working` under id `mu/delegates`, so the multiplexer's tabs and
// borders show it active instead of idle. Written to the controlling tty,
// never stdout (pi owns that stream). Fail-silent: no tty, no record.

import { closeSync, constants, openSync, writeSync } from "node:fs";

export const DELEGATES_OSC_ID = "mu/delegates";

/** The OSC 7501 bytes for `count` delegates in flight (`clear` at 0). */
export function delegatesOsc(count: number): string {
  if (count <= 0) return `\x1b]7501;state=clear:id=${DELEGATES_OSC_ID}\x1b\\`;
  const noun = count === 1 ? "delegate" : "delegates";
  const msg = Buffer.from(`waiting on ${count} ${noun}`, "utf8").toString("base64");
  return `\x1b]7501;state=working:id=${DELEGATES_OSC_ID}:msg=${msg}\x1b\\`;
}

export type TtyWriter = (data: string) => void;

const MAX_EAGAIN_RETRIES = 20;

/** Block ~1 ms (a full tty buffer drains fast; bounded by MAX_EAGAIN_RETRIES). */
function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

/**
 * Write every byte of `data` to `fd`, looping over short writes, with a bounded
 * EAGAIN retry. False on a persistent error: a truncated escape sequence would
 * corrupt the terminal, so the caller stops rather than send half of one.
 */
export function writeAll(
  fd: number,
  data: string,
  write: (fd: number, buf: Buffer, off: number) => number = (f, b, o) => writeSync(f, b, o),
  wait: () => void = pause,
): boolean {
  const buf = Buffer.from(data, "utf8");
  let off = 0;
  let retries = 0;
  while (off < buf.length) {
    try {
      const n = write(fd, buf, off);
      if (n > 0) {
        off += n;
        retries = 0;
        continue;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") return false;
    }
    if (++retries > MAX_EAGAIN_RETRIES) return false;
    wait();
  }
  return true;
}

/** Non-blocking write to /dev/tty; swallows every failure (no tty, full buffer). */
export const writeToTty: TtyWriter = (data) => {
  let fd: number | undefined;
  try {
    fd = openSync("/dev/tty", constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
    writeAll(fd, data);
  } catch {
    // fail-silent: a status hint is never worth an error
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
};

let writer: TtyWriter = writeToTty;

/** Swap the tty writer (tests keep escape bytes off the developer's terminal). */
export function setTtyWriterForTests(w: TtyWriter | null): void {
  writer = w ?? writeToTty;
}

/** Report `count` delegates in flight to the pane's terminal. */
export function emitDelegatesStatus(count: number): void {
  writer(delegatesOsc(count));
}
