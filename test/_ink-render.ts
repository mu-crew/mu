// Minimal Ink render harness for the dashboard: fake TTY streams, no real
// terminal, no timers. `debug: true` makes Ink write every frame whole, so the
// last write IS the screen. Keys go in through the fake stdin like a terminal.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";

class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  columns = 100;
  rows = 30;
  frames: string[] = [];
  // Ink waits for the write callback before `waitUntilExit` settles.
  write(chunk: string, cb?: () => void): boolean {
    this.frames.push(chunk);
    cb?.();
    return true;
  }
}

class FakeStdin extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

export interface InkHarness {
  /** The screen as plain text (the last frame). */
  screen(): string;
  press(keys: string): void;
  /** Yield to the event loop until `predicate` holds (bounded; no sleeps). */
  until(predicate: (screen: string) => boolean): Promise<void>;
  unmount(): void;
  exited: Promise<void>;
}

export async function renderApp(node: ReactElement): Promise<InkHarness> {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const app = render(node, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new PassThrough() as never,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const screen = (): string => stdout.frames.at(-1) ?? "";
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  return {
    screen,
    press: (keys) => {
      stdin.write(keys);
    },
    async until(predicate) {
      for (let i = 0; i < 200; i++) {
        if (predicate(screen())) return;
        await tick();
      }
      throw new Error(`screen never matched:\n${screen()}`);
    },
    unmount: () => app.unmount(),
    exited: app.waitUntilExit().then(() => undefined),
  };
}
