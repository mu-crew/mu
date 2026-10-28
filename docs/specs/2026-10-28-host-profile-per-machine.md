# Host profiles name a machine; the repo is chosen at spawn

Status: implemented (unreleased). See [Resolved questions](#resolved-questions).
Date: 2026-10-28

## Problem

A host profile carries one `repo`. To run remote workers in two repos on the
same machine you must add the machine twice (`dev-mu`, `dev-web`) with
identical `shell`/`exec`/`fetch` templates. That is more than duplication:

1. **The quota leaks.** `host_channels` and `max_sessions` are keyed by
   profile name. Two profiles for one box at `--max-sessions 2` allow 4
   connections. The cap exists to protect the machine, and duplicate
   profiles defeat it.
2. **The recovery guard cannot see across profiles.** The remote worktree
   path, `~/.local/state/mu-next/remote-worktrees/<ws>/<name>`, does not
   depend on the repo. `assertRecoveryUsable` looks for "a newer record of
   the same host and path" by profile name, so two profiles that point at
   one box miss each other's records for the same path.
3. **Editing the repo strands records.** `assertRecoveryProfile` refuses
   when `profile.repo` differs from the record's `host_repo`. Changing a
   profile's default repo therefore blocks recovery-close of every older
   worker, even though the worktree itself knows its repo.

`repo` is a property of the **spawn**, not of the **machine**.

## Approach

A profile describes one machine: how to reach it (`shell`, `exec`,
`fetch`) and how many channels it may hold (`max_sessions`). The repo is
picked per spawn with `--root`, recorded on the agent row, and every later
remote command (close, recovery) reads it from the row, never from the
profile.

The profile's `repo` becomes an **optional default**, so the one-repo case
stays one flag shorter.

## Behaviour

### `mu host add`

- `--repo` becomes optional and means "default repo for spawns that pass
  no `--root`". `host_profiles.repo` is nullable.
- `host list` / `host show` print the default as `repo (default) <path>`,
  or `-` when there is none.
- `host init --ssh` drops the `--repo '<remote repo path>'` line from the
  starter.

### `mu agent spawn --host`

- `--root <path>` is accepted with `--host` and names a **remote** repo
  path (a leading `~` expands remotely, like `--cwd`). Today it is
  refused with `--host`. The flag already means "the repo to add the
  worktree to", so this adds no new flag.
- Resolution: `--root`, else the profile's default, else, with
  `--worktree`, refuse with exit 2:
  `host dev has no default repo: pass --root <remote repo path>`.
- Without `--worktree` (a plain `--cwd` agent, or a command gate) the repo
  is used only as the default cwd. With neither `--cwd`, `--root` nor a
  profile default, the remote cwd is the login directory (`cd ~`).
- The resolved remote repo, made absolute by the same exec that makes the
  worktree (`cd "$root" && pwd -P`, so a bare repo works; sent hex-encoded so
  a trailing space or newline survives), is stored in the new `agents.repo`
  column. A respawn hint carries it as `--root`; `--root` is part of the
  `--task` attempt identity. Only a
  `--worktree` agent records it. A `--cwd` or gate agent has no repo to
  record.
- Reclaim (a leftover from a lost answer) already checks that `$wt` is a
  worktree of `$root`. With a per-spawn root, a leftover from another repo
  at the same `<ws>/<name>` path is refused, as it is today, with "not a
  worktree of <root>".

### Close and recovery

- `closeRemoteWorktree` uses `agents.repo` as `root`, not `profile.repo`.
  There is no fallback: a row without a repo is not a closable remote
  worktree.
- `remote_recovery.host_repo` is filled from `OLD.repo`. It becomes
  provenance of the **worktree**, not of the profile.
- `assertRecoveryProfile` compares **`exec` only**: the exec template is
  what proves "this profile still reaches that machine". The repo comes
  from the record. A record with a null `host_exec` or `host_repo` refuses.
- A remote command gate reads and cleans its result record with `{cwd}` =
  `.` (the record lives under `$HOME`; its own cwd may be gone).
- Without a repo, every template gets `{cwd}` = `.`, never a quoted `~`.
- The newer-record guard is unchanged (same host profile, same path). With
  one profile per machine, "same profile" now does mean "same machine".

### `mu host check`

- `host check dev [--root <path>]`. The `repo` step runs against
  `--root`, else the profile default. With neither it is `ok: null`,
  `skipped: no repo given`, and does not fail the check; `{cwd}` is `.`.

### `mu agent collect`

Unchanged. `--fetch` already runs against `{cwd}`, the worktree path, and
never reads the repo.

## Schema

No version bump, and no migration (back-compat was explicitly waived).

- `ADDED_COLUMNS`: `["agents", "repo", "TEXT"]` (machine-local, like
  `host`/`cwd`/`base`).
- `host_profiles.repo` is nullable. A file whose `host_profiles.repo` is
  still `NOT NULL` gets the table **dropped** on open and recreated empty:
  re-add the profiles.
- The recovery triggers read `OLD.repo`/`a.repo`. `CREATE TRIGGER IF NOT
  EXISTS` would keep the old body, and `schemaIsCurrent` checks names only,
  so they are renamed `remote_recovery_agent_del_v2` /
  `remote_recovery_workstream_del_v2` and the upgrade drops the old names.

## Surface summary

| Verb | Change |
|---|---|
| `host add` | `--repo` optional (default repo) |
| `host list` / `show` | repo shown as the default, `-` when none |
| `host init --ssh` | no `--repo` line |
| `host check` | `--root <path>`; repo step skipped without one |
| `agent spawn --host` | `--root <remote path>` accepted; recorded as `agents.repo` |
| `agent close` / recovery | read the repo from the row/record; profile check is `exec` only |

## Docs

- VOCABULARY: **host profile** loses `repo` from its field list ("default
  `repo`"); add that `agents.repo` is a remote worker's repo.
- `docs/guide/remote.md`: one profile per machine; `--root` at spawn; the
  quota is per machine.
- `skills/mu/recipes/remote-workers.md`: add `--root <remote repo>` to the
  spawn line. One profile per machine, never one per repo; that is the trap
  `--help` cannot state.
- CHANGELOG `### Changed`.

## Testing

- Unit: spawn `--host --worktree --root A` and `--root B` on one profile.
  Both rows record their repo, and the second spawn at cap 1 is refused,
  naming the first (the quota is per machine).
- Unit: `--worktree` with no `--root` and no default refuses before any
  channel is taken.
- Unit: close uses `agents.repo` after the profile's default repo
  changes. Recovery-close succeeds after a default-repo edit and refuses
  after an `exec` edit.
- Upgrade: an older v13 file (repo-bound profiles, old trigger names) loses its profiles and gets the `_v2` triggers on open.
- Upgrade: a populated v13 fixture gets `agents.repo` and the renamed
  triggers in one transaction. The old trigger names are gone, and a
  deleted remote row writes `host_repo` from `OLD.repo`.
- `host check` without a repo: the repo step is skipped and the check
  passes.
- Smoke (real tmux, private `MU_DB_PATH`, blank `MU_SYNC_DIR`): one
  profile against localhost over ssh, two repos.

## Size

About 150 to 250 LOC of source (spawn resolution, close/recovery root,
trigger rename, check flag, CLI wiring), plus tests. That fits the <300 LOC
promotion bar.

## Out of scope

- Mapping a local repo to a remote path (per-profile `{repo}` template,
  basename conventions). That is config-file territory.
- Syncing profiles across machines.
- Repo-qualified worktree paths (`remote-worktrees/<repo-hash>/<ws>/<name>`).
  Agent names are unique per workstream, so the path is already unique
  among live agents. Reclaim refuses a foreign repo's leftover.
- herdr `--host`.

## Resolved questions

1. The profile keeps an optional default repo.
2. No `''` sentinel and no table rebuild: no migration at all. An older
   file's profiles are dropped; legacy remote rows get no repo fallback.
3. `--cwd` agents record no repo.

## Review (2026-10-28)

A five-angle review panel plus refuters (20/20 CONFIRMED) found 14 issues in
the first cut, all fixed with a test that fails on the unfixed code: bare
repos (`--show-toplevel`), byte-exact repo paths, `{cwd}` defaults for
spawn, host check and gates, `--root` in respawn hints and the attempt
identity, `--host --root` without `--worktree`, and six test gaps.
