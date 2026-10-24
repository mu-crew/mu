// The one validator for a workstream name typed as scope (`-w`, a
// `<ws>/<name>` ref prefix, a record's `workstream`). Pure and
// dependency-free: the CLI (src/cli.ts) and the pi extension
// (extension/delegate.ts, extension/nudge.ts) all call it, so the
// answer to "is this a valid scope?" is the same everywhere.
//
// It never trims. Trimming turns a quoting accident (`-w ' auth'`) into
// a different, valid workstream. Empty, blank and padded names are
// rejected; it does not check the name's shape or that it exists.

/** Why `value` is not a usable workstream name, or undefined when it is. */
export function workstreamNameProblem(value: string, flag = "-w/--workstream"): string | undefined {
  if (value.length > 0 && value.trim().length === 0) {
    return `${flag} got a blank (whitespace-only) value ${JSON.stringify(value)}. Pass a workstream name.`;
  }
  if (value.length === 0 || value !== value.trim()) {
    return `${flag} got ${JSON.stringify(value)}: pass a bare workstream name with no surrounding whitespace.`;
  }
  return undefined;
}

/**
 * Names from repeated / comma-separated values. A structurally empty
 * fragment (`"a,"`) is a comma artifact and is dropped; a fragment is
 * never trimmed, and a padded or blank one, or a lone empty value, is a
 * problem.
 */
export function parseWorkstreamFragments(
  values: readonly string[],
  flag = "-w/--workstream",
): { names: string[] } | { problem: string } {
  const names: string[] = [];
  for (const value of values) {
    const lone = value === "" ? workstreamNameProblem(value, flag) : undefined;
    if (lone !== undefined) return { problem: lone };
    for (const fragment of value.split(",")) {
      if (fragment === "") continue;
      const problem = workstreamNameProblem(fragment, flag);
      if (problem !== undefined) return { problem };
      names.push(fragment);
    }
  }
  return { names };
}
