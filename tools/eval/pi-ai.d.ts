// pi aliases "@earendil-works/pi-ai" for extensions at runtime only; this repo has no dependency
// on it. Ambient declaration of the slice faux.ts uses. Do not add pi-ai to package.json.
declare module "@earendil-works/pi-ai" {
  export interface FauxBlock {
    type: string;
    [key: string]: unknown;
  }
  export interface FauxMessage {
    role: string;
    [key: string]: unknown;
  }
  /** Transcript handed to a response factory (system prompt and tools are system messages). */
  export interface FauxContext {
    messages: Array<{ role: string; content?: unknown }>;
  }
  export type FauxResponseFactory = (
    context: FauxContext,
    options: unknown,
    state: unknown,
    model: { id: string },
  ) => FauxMessage | Promise<FauxMessage>;
  export interface FauxProviderOptions {
    provider?: string;
    models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>;
  }
  export interface FauxProviderHandle {
    provider: unknown;
    setResponses(responses: Array<FauxMessage | FauxResponseFactory>): void;
    appendResponses(responses: Array<FauxMessage | FauxResponseFactory>): void;
  }
  export function fauxProvider(options?: FauxProviderOptions): FauxProviderHandle;
  export function fauxToolCall(
    name: string,
    args: Record<string, unknown>,
    options?: { id?: string },
  ): FauxBlock;
  export function fauxText(text: string): FauxBlock;
  export function fauxAssistantMessage(
    content: string | FauxBlock | FauxBlock[],
    options?: { stopReason?: "stop" | "toolUse" | "error" | "aborted"; errorMessage?: string },
  ): FauxMessage;
}
