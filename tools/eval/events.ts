// pi JSONL event stream (rpc mode) -> RunMetrics. Pure: no I/O.
import type { Aborted, LifecycleEvent, RunMetrics, ToolCall, Usage } from "./types.ts";

/** A mu call is a bash command that runs `mu ...`, or the mu_delegate tool. */
const MU_CMD = /(^|[\s;&|(`$])mu\s/;

export function isMuCall(name: string, args: Record<string, unknown>): boolean {
  if (name === "mu_delegate") return true;
  if (name !== "bash") return false;
  return typeof args.command === "string" && MU_CMD.test(args.command);
}

/** Split a buffer into complete LF-terminated lines. Never splits on U+2028/U+2029. */
export function splitLf(buf: string): { lines: string[]; rest: string } {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  const lines = parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l !== "");
  return { lines, rest };
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Concatenate the text blocks of a content value (string or block array). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isRec(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter((t) => t !== "")
    .join("\n");
}

const EXIT_CODE = /Command exited with code (\d+)/;

export class MetricsCollector {
  private usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  private turns = 0;
  private calls: ToolCall[] = [];
  private byId = new Map<string, ToolCall>();
  private lastError: string | null = null;
  private finalText = "";
  private settled = false;
  private activity: number;
  private events: LifecycleEvent[] = [];

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.activity = now();
  }

  push(event: unknown): void {
    if (!isRec(event)) return;
    const type = event.type;
    if (type === "response") return;
    this.activity = this.now();
    switch (type) {
      case "agent_start":
        this.settled = false;
        this.mark("agent_start");
        break;
      case "agent_end":
        this.mark("agent_end");
        break;
      case "agent_settled":
        this.settled = true;
        this.mark("agent_settled");
        break;
      case "message_start":
        this.onMessageStart(event.message);
        break;
      case "turn_end":
        this.turns++;
        break;
      case "message_end":
        this.onMessageEnd(event.message);
        break;
      case "tool_execution_start":
        this.onToolStart(event);
        break;
      case "tool_execution_end":
        this.onToolEnd(event);
        break;
    }
  }

  private mark(kind: LifecycleEvent["kind"], rest: Partial<LifecycleEvent> = {}): void {
    this.events.push({ t: this.now(), kind, ...rest });
  }

  /** A custom message (a delegate's delivery) entering the conversation. */
  private onMessageStart(message: unknown): void {
    if (!isRec(message) || message.role !== "custom") return;
    this.mark("delegate_msg", {
      name: String(message.customType ?? ""),
      text: textOf(message.content),
    });
  }

  private onMessageEnd(message: unknown): void {
    if (!isRec(message) || message.role !== "assistant") return;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const calls = blocks.some((b) => isRec(b) && b.type === "toolCall");
    if (!calls && textOf(message.content) !== "")
      this.mark("assistant_text", { text: textOf(message.content) });
    const u = message.usage;
    if (isRec(u)) {
      this.usage.input += num(u.input);
      this.usage.output += num(u.output);
      this.usage.cacheRead += num(u.cacheRead);
      this.usage.cacheWrite += num(u.cacheWrite);
      this.usage.total += num(u.totalTokens);
      this.usage.cost += isRec(u.cost) ? num(u.cost.total) : 0;
    }
    if (typeof message.errorMessage === "string") this.lastError = message.errorMessage;
    const text = textOf(message.content);
    if (text !== "") this.finalText = text;
  }

  private onToolStart(event: Rec): void {
    const id = String(event.toolCallId ?? "");
    const call: ToolCall = {
      id,
      name: String(event.toolName ?? ""),
      args: isRec(event.args) ? event.args : {},
      isError: false,
      output: "",
      exitCode: null,
      durationMs: null,
    };
    this.calls.push(call);
    this.byId.set(id, call);
    this.mark("tool_start", { id, name: call.name });
  }

  private onToolEnd(event: Rec): void {
    const call = this.byId.get(String(event.toolCallId ?? ""));
    if (!call) return;
    this.mark("tool_end", { id: call.id, name: call.name });
    call.isError = event.isError === true;
    call.output = isRec(event.result) ? textOf(event.result.content) : "";
    call.durationMs = typeof event.durationMs === "number" ? event.durationMs : null;
    const m = EXIT_CODE.exec(call.output);
    if (m?.[1] !== undefined) call.exitCode = Number(m[1]);
    else call.exitCode = call.name === "bash" && !call.isError ? 0 : null;
  }

  /** The caller just sent a prompt: not settled until pi says so, and the quiet clock restarts. */
  markPrompted(): void {
    this.mark("prompt");
    this.settled = false;
    this.activity = this.now();
  }

  isSettled(): boolean {
    return this.settled;
  }

  /** Epoch ms of the last non-response event (or construction). */
  lastActivity(): number {
    return this.activity;
  }

  result(extra: { wallMs: number; prods: number; aborted: Aborted }): RunMetrics {
    const mu = this.calls.filter((c) => isMuCall(c.name, c.args));
    return {
      usage: { ...this.usage },
      turns: this.turns,
      toolCalls: this.calls.map((c) => ({ ...c })),
      muCalls: mu.length,
      muErrors: mu.filter((c) => c.isError).length,
      prods: extra.prods,
      wallMs: extra.wallMs,
      aborted: extra.aborted,
      lastError: this.lastError,
      finalText: this.finalText,
      events: this.events.map((e) => ({ ...e })),
    };
  }
}
