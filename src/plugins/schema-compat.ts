/** The published schema, relative to the package root. Ships in the package. */
export const PLUGIN_SCHEMA_FILE = "schemas/plugin-protocol-v1.json";

/** sha256 of the exact bytes of PLUGIN_SCHEMA_FILE (pinned by test/plugin-schema.test.ts). */
export const PLUGIN_SCHEMA_DIGEST: string =
  "sha256:6ea6e13cabf6baebe44e961e21370a66ddf523082bfd73bcf169ec627fc71a25";

/** Reviewed older digests by current digest. No approvals carry over to a new digest. */
export const COMPATIBLE_OLDER_SCHEMA_DIGESTS: ReadonlyMap<string, readonly string[]> = new Map();
