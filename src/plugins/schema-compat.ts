/** The published schema, relative to the package root. Ships in the package. */
export const PLUGIN_SCHEMA_FILE = "schemas/plugin-protocol-v1.json";

/** sha256 of the exact bytes of PLUGIN_SCHEMA_FILE (pinned by test/plugin-schema.test.ts). */
export const PLUGIN_SCHEMA_DIGEST: string =
  "sha256:54d56d9a865c4e9302f2b63158cb595010ecbb0b59037550609a54d79392ac36";

/**
 * The digest before the D15 file handle (placement spec §10): it added the optional
 * `jobSpec.jobFile` and `jobAttachParams` (`jobFile`, `sockets`). mu sends them only to a
 * `handle: "file"` kind, which that schema gave no job file to write (its jobs never got a
 * handle), so every kind a plugin built against it could serve gets the same requests.
 */
const BEFORE_JOB_FILE = "sha256:6ea6e13cabf6baebe44e961e21370a66ddf523082bfd73bcf169ec627fc71a25";

/** Reviewed older digests by current digest. No approvals carry over to a new digest. */
export const COMPATIBLE_OLDER_SCHEMA_DIGESTS: ReadonlyMap<string, readonly string[]> = new Map([
  [PLUGIN_SCHEMA_DIGEST, [BEFORE_JOB_FILE]],
]);
