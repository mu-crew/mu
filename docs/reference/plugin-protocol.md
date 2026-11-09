# The plugin protocol, version 1

A **plugin** is an executable that implements one or more of mu's seams
out of process. mu runs it as a child, speaks JSON-RPC 2.0 to it over
stdio, and records what it reports. A plugin only reports facts. It never
writes mu's database, state directory or log, and it cannot call into mu.

This page is the normative prose. The machine-readable schema is
[`schemas/plugin-protocol-v1.json`](../../schemas/plugin-protocol-v1.json),
shipped in the package. Terms are in [VOCABULARY](../VOCABULARY.md#plugins-hosts-and-jobs).

Status: this build drives the **link** seam (`mu host add --plugin`). The
host, job and channel seams are declared and validated at the handshake.
Their methods (`host.*`, `job.*`, `channel.*`), effect keys and the watch
stream are not yet called.

## Registration and trust

```sh
mu plugin add <name> -- /absolute/path/mu-plugin-<name> [args…]
mu plugin list
mu plugin rm <name>
```

- mu never discovers a plugin. It does not scan `PATH`, a directory or a
  package; it runs only the argv you registered.
- The executable's basename is `mu-plugin-<name>`. mu refuses the plugin
  if the path is not absolute, if the file (or a symlink's target) is not
  a regular file you own, or if the group or the world can write it.
- `add` runs the handshake once and stores what the plugin declared.
  Running `add` again with the same argv re-checks the plugin and records
  its new declaration. A different argv for a registered name is refused
  (`mu plugin rm` first).
- `rm` is refused while a host profile names the plugin.
- mu does not hash the binary. The handshake's `instance` is the fence.

A host profile uses a plugin as its link:

```sh
mu host add box --plugin <name> --fetch '<template>' [--repo …] [--max-sessions …]
```

Such a profile has no `--shell` and no `--exec`. Its `--fetch` template
runs when the plugin's link declares `fetch: false`. Spawning an agent on
it is refused until the plugin job kind ships.

## Transport

- JSON-RPC 2.0. Each message is one JSON object on one line, UTF-8, at
  most 1 MiB, on the plugin's stdin (from mu) and stdout (from the
  plugin).
- stderr is drained and never parsed or stored. Its first line may appear
  in an error, cut to 400 characters.
- A reply always carries `result`; an absent result is `null`. An error
  carries `data.kind` (below).
- The plugin sends no request to mu. Its only notifications are
  `watch/settled` and `watch/restarted`, which end a watch.
- A message that is not valid (not JSON, an unknown field, a reply to no
  pending request, a request to mu) breaks the plugin for the rest of the
  invocation. mu reaps it and treats every pending call as unanswered.

## Process

- mu starts the registered argv on first need, as its child in its own
  process group, for one invocation.
- The plugin gets mu's environment minus mu's local-only variables
  (`MU_DB_PATH`, `MU_STATE_DIR`, `MU_SYNC_DIR`, the agent identity and
  control-socket variables). Every call's `target` carries the identity
  it needs.
- At a normal exit mu sends `shutdown`, closes stdin, waits 5 s and kills
  the group.
- On stdin EOF the plugin must cancel or finish its in-flight calls and
  exit within 5 s. This is what it sees when mu dies, even by SIGKILL.
- The plugin never detaches a helper (`setsid`, a double fork). Anything
  left in its group is killed with it.

## Handshake

mu sends:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"mu":"5"}}
```

The plugin answers with the protocol version it chose, its name and
version, an `instance`, the schema digest and its seams:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocol":1,"plugin":{"name":"box","version":"0.1.0"},"instance":"prod-eu","schema":"sha256:…","seams":{"link":{"fetch":false,"slots":"self","remoteOnTimeout":"unknown","quiescence":"provable","maxScriptBytes":131072,"checks":["reach"]}}}}
```

- `instance` names the backend configuration the plugin addresses (1–128
  characters). A `--plugin` host's identity is `plugin:<name>:<instance>`:
  a worktree recovery pinned under one instance refuses under another.
- `schema` is `sha256:` and the hex sha256 of the exact bytes of the
  `schemas/plugin-protocol-v<n>.json` the plugin was built against.

### Seams

| Seam | Object | Notes |
| --- | --- | --- |
| `link` | `fetch`, `slots` (`mu`: each call holds a host channel; `self`: the plugin arbitrates), `remoteOnTimeout` (`stopped` or `unknown`), `quiescence` (`provable` or `unprovable`), `maxScriptBytes`, `checks` | `maxScriptBytes` is required |
| `job` | `kind`, `view` (`bound`, `detached`), `handle` (`pane`, `file`, `reply`), `start` (key capabilities), `channel`, `checks` | |
| `host` | `acquire` (key capabilities) | needs `link` and `job` |
| `channel` | `name`, `caps` (`fence`, `receipt`, `dedupe`, `steer`, `interrupt`, `fresh`, `answer`, `command`, `watch`, `settleText`) | |

Key capabilities are `{lookup, fenceKey, dedupe?: {exact: true, windowMs}, inFlightMs?}`.
`checks` lists the `host check` phases (`template`, `reach`, `agent`) the
seam contributes steps to.

### Load rules

mu refuses the plugin (exit 4) when:

- the protocol version is outside mu's range, or the plugin answered the
  handshake with an error;
- its name is not the registered name, or its schema digest is not the
  published file's;
- the declaration does not match the schema: a missing or unknown field,
  an unknown seam or value;
- a seam the registration or a host needs is missing, or no seam is
  declared;
- a `host` seam comes without `link` and `job`;
- `host.acquire`, or `job.start` with `handle: "reply"`, declares neither
  `lookup` nor exact `dedupe`;
- a channel declares `watch` other than `stream`, `settleText: "none"`, or
  a `fence` other than `none`;
- `job.channel` is not the channel seam's `name`;
- the declaration differs from the one recorded by `mu plugin add`.

## Calls

Every request's `params` carries `deadline` (epoch ms) and a `target`:

```ts
{
  agent?: { workstream: string; name: string; incarnation: number },
  job?: { kind: string; key: string; handle?: string },
  host: { name: string; handle?: string; instance?: string },
}
```

The `params` mu sends are the same on every resend. Only the envelope `id`
and the `deadline` are new each time.

### The link

| Method | Params beyond `target`, `deadline` | Result |
| --- | --- | --- |
| `link.exec` | `script` (POSIX sh), `cwd` (`.` is the login directory), `timeoutMs` | `{exitCode, stdout, stderr, partial}`; `exitCode: null` when timed out, `partial` when output was cut |
| `link.fetch` | `remoteCwd`, `localRepo`, `timeoutMs` | as `link.exec`. On success `localRepo`'s `FETCH_HEAD` names `remoteCwd`'s HEAD |
| `link.checkSteps` | `phase`, `root?`, `agent?` | `[{step, ok, detail}]`; mu names each step `<plugin>:<step>` |

The plugin enforces `timeoutMs` itself and answers with `exitCode: null`.
With `remoteOnTimeout: "stopped"` it guarantees nothing it started still
runs. mu computes `fits` (a script's bytes against `maxScriptBytes`) and
the host identity, and deletes `FETCH_HEAD` before a fetch. These are not
wire calls.

## Errors

| `data.kind` | Means | mu does |
| --- | --- | --- |
| `retryable` | nothing happened | retries with the same params, at most three times; else exit 5 |
| `permanent` | nothing happened, and a retry will not help | exit 5 |
| `human` | a person must act (`data.remedy`) | a host hand-back, exit 5; never retried |
| `unknown-outcome` | it may have happened | an effect's outcome is unknown (exit 1); a `link.exec` returns no exit code |

## Timeouts and cancel

- `link.exec` and `link.fetch` take the caller's `timeoutMs` (20 s by
  default). mu waits that long plus 5 s for the reply.
- Reads (the handshake, `link.checkSteps`) take 10 s.
- Past the deadline, or when the verb cancels the call (its abort signal),
  mu sends `{"jsonrpc":"2.0","method":"$/cancel","params":{"id":<id>}}`,
  waits up to 5 s, and kills the plugin's group. A reply that arrives
  after the cancel is ignored. The call has no answer: a read is unknown,
  an effect is an unknown outcome.
- A mu that exits on a signal kills the plugin's group at once.

## Secrets

mu stores only typed reply fields and first-line error text. The contract
suite runs a plugin with `MU_PLUGIN_CANARY=<random>` in its environment,
and fails it if the canary appears in any reply, message or stderr line.
