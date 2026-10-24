// Parse one `--json` document printed by an in-process cmd* call and return
// its envelope `data` (src/output-contract.ts). For tests that call the SDK
// verb directly, not through runCli.

export function envelopeData<T = Record<string, unknown>>(raw: unknown): T {
  const doc = JSON.parse(String(raw)) as { ok?: unknown; data?: unknown };
  if (doc.ok !== true || !("data" in doc)) throw new Error(`not a success envelope: ${raw}`);
  return doc.data as T;
}
