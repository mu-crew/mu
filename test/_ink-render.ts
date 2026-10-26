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
  /** Every `setRawMode(on)` call, in order: evidence of who owned the terminal. */
  readonly rawModes: boolean[] = [];
  setRawMode(on: boolean): this {
    this.rawModes.push(on);
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
  /** Type `keys`, then let React commit (state set by one key is seen by the next press). */
  press(keys: string): Promise<void>;
  /** Raw mode as Ink last set it (true = Ink owns the keyboard); null before any call. */
  rawMode(): boolean | null;
  /** Everything written to the terminal, in order (frames, mode switches, OSC sequences). */
  writes(): readonly string[];
  /** Resize the fake terminal; Ink re-renders on the `resize` event. */
  resize(columns: number, rows: number): void;
  /** Yield to the event loop until `predicate` holds (bounded; no sleeps). */
  until(predicate: (screen: string) => boolean): Promise<void>;
  unmount(): void;
  exited: Promise<void>;
}

export async function renderApp(
  node: ReactElement,
  size: { columns?: number; rows?: number } = {},
): Promise<InkHarness> {
  const stdout = new FakeStdout();
  stdout.columns = size.columns ?? stdout.columns;
  stdout.rows = size.rows ?? stdout.rows;
  const stdin = new FakeStdin();
  const app = render(node, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new PassThrough() as never,
    debug: true,
    interactive: true,
    alternateScreen: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  // The last NON-empty write: debug mode also writes an empty chunk after a resume redraw.
  const screen = (): string => [...stdout.frames].reverse().find((f) => f !== "") ?? "";
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  // A lone ESC is held by Ink's input parser until a short timer flushes it, so
  // `until` waits in 2 ms steps (bounded: 200 steps) rather than only yielding.
  const step = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));
  return {
    screen,
    press: async (keys) => {
      stdin.write(keys);
      for (let i = 0; i < 5; i++) await tick();
    },
    rawMode: () => stdin.rawModes.at(-1) ?? null,
    writes: () => stdout.frames,
    resize: (columns, rows) => {
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit("resize");
    },
    async until(predicate) {
      for (let i = 0; i < 200; i++) {
        if (predicate(screen())) return;
        await step();
      }
      throw new Error(`screen never matched:\n${screen()}`);
    },
    unmount: () => app.unmount(),
    exited: app.waitUntilExit().then(() => undefined),
  };
}
