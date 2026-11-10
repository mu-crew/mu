// mu — the plugin protocol's typed errors (spec 2026-11-09-mu-plugins.md, D13,
// D14). Each maps to one exit code in src/cli/handle.ts. Imports nothing, so
// root files (src/hosts.ts) can refuse with them without an import cycle.

/** A load rule, a trust rule or a changed declaration refused the plugin. Exit 4. */
export class PluginRefusedError extends Error {
  override readonly name = "PluginRefusedError";
  constructor(
    public readonly plugin: string,
    public readonly reasons: readonly string[],
  ) {
    super(`plugin ${plugin} refused: ${reasons.join("; ")}`);
  }
}

/** No registration by that name (`mu plugin add` makes one). Exit 3. */
export class PluginNotFoundError extends Error {
  override readonly name = "PluginNotFoundError";
  constructor(public readonly plugin: string) {
    super(`no plugin named ${plugin} (mu plugin add ${plugin} -- /abs/path/mu-plugin-${plugin})`);
  }
}

/** `mu plugin add` of a name registered with another argv. Exit 4. */
export class PluginExistsError extends Error {
  override readonly name = "PluginExistsError";
  constructor(public readonly plugin: string) {
    super(
      `plugin ${plugin} is registered with another argv: mu plugin rm ${plugin} first (the same argv re-checks it)`,
    );
  }
}

/** `mu plugin rm` while something names the plugin. Exit 4. */
export class PluginInUseError extends Error {
  override readonly name = "PluginInUseError";
  constructor(
    public readonly plugin: string,
    public readonly users: readonly string[],
  ) {
    super(`plugin ${plugin} is in use by ${users.join(", ")}: remove those first`);
  }
}

/**
 * A call the plugin answered with an error that says nothing happened: `retryable` (after
 * mu's three retries), `permanent`, or `human` (a person must act: `remedy`). Also a call mu
 * never sent, to a plugin already broken in this invocation (`permanent`). Exit 5.
 */
export class PluginCallError extends Error {
  override readonly name = "PluginCallError";
  constructor(
    public readonly plugin: string,
    public readonly method: string,
    public readonly kind: "retryable" | "permanent" | "human",
    public readonly detail: string,
    public readonly remedy?: string,
  ) {
    super(`plugin ${plugin} ${method}: ${kind}: ${detail}`);
  }
}

/**
 * A read with no answer: cancelled, timed out, the plugin gone or its reply invalid. The
 * seam's adapter turns it into the seam's `unknown`; escaping, it is exit 5.
 */
export class PluginAnswerUnknownError extends Error {
  override readonly name = "PluginAnswerUnknownError";
  constructor(
    public readonly plugin: string,
    public readonly method: string,
    public readonly reason: string,
  ) {
    super(`plugin ${plugin} ${method}: no answer: ${reason}`);
  }
}

/**
 * An effect that may have happened: the plugin said `unknown-outcome`, or it was cancelled,
 * timed out, the plugin died or its reply was invalid after the request went out. Exit 1.
 */
export class EffectOutcomeUnknownError extends Error {
  override readonly name = "EffectOutcomeUnknownError";
  constructor(
    public readonly plugin: string,
    public readonly method: string,
    public readonly reason: string,
  ) {
    super(`plugin ${plugin} ${method}: outcome unknown: ${reason}`);
  }
}

/**
 * The plugin's instance is not the one recorded for the job, host or effect a call names
 * (D4 step 2, D13): the backend configuration changed, so mu sends nothing. `stop-changed` for
 * a stop, a release or an effect's resolution; `instance-changed` for an ask. Exit 4.
 */
export class EffectFencedError extends Error {
  override readonly name = "EffectFencedError";
  constructor(
    public readonly plugin: string,
    /** What the call names: an effect key, or `<method> of <job key>`. */
    public readonly subject: string,
    public readonly recorded: string,
    public readonly current: string,
    public readonly why: "stop-changed" | "instance-changed" = "stop-changed",
  ) {
    super(
      `${subject}: plugin ${plugin}'s instance is ${current}, not ${recorded} as recorded (${why}): nothing is sent; a human decides (abandon)`,
    );
  }
}
