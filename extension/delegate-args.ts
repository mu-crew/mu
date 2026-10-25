/**
 * Reading a mu_delegate call's arguments: label stems, model ids and the
 * command a model implies. Pure; split from delegate.ts.
 */

/** A label → agent-name stem: lowercase, [a-z0-9-], ≤ 20 chars. */
export function labelStem(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const stem = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  return stem || undefined;
}

/** Model values that need no shell quoting inside a `--command` string. */
const MODEL_BARE_RE = /^[A-Za-z0-9._:/@+=-]+$/;

/**
 * Forgive the usual slips in a `model` value: surrounding quotes or
 * backticks, a pasted `--model ` / `--model=` prefix, stray whitespace.
 * Anything else (brackets as in `gpt-6.1-sol[1m]`, odd provider ids) is
 * kept and shell-quoted by `modelCommand`, so pi gets to judge the id.
 * Returns undefined for an empty value or one with inner whitespace,
 * which no model id has.
 */
export function normalizeModel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let m = raw.trim();
  for (let prev = ""; prev !== m; ) {
    prev = m;
    m = m
      .replace(/^--model(?:=|\s+)/, "")
      .replace(/^(["'`])(.*)\1$/s, "$2")
      .trim();
  }
  return m && !/\s/.test(m) ? m : undefined;
}

function shellArg(s: string): string {
  return MODEL_BARE_RE.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The command a delegate with `model` runs: the cli key's command
 * (`$MU_<KEY>_COMMAND`, else the key itself, as `resolveCliCommand` in
 * src/agents/spawn.ts does) plus `--model <model>`. Inlined: the extension
 * bundles standalone and spawn.ts pulls in the DB.
 */
export function modelCommand(
  cli: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[`MU_${cli.toUpperCase().replace(/-/g, "_")}_COMMAND`];
  const base = override && override.trim() !== "" ? override.trim() : cli;
  return `${base} --model ${shellArg(model)}`;
}
