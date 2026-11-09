# How to upgrade mu

Coming from 3.x? Read [Upgrade from 3.x to 4.0](#upgrade-from-3x-to-40)
first: `npm i -g @mu-crew/mu@latest` replaces your 3.x `mu`.

## Upgrade the package

```bash
npm i -g @mu-crew/mu@latest
pi update --extensions    # only if the package is already registered in pi
mu doctor
```

pi loads mu as a package: one extension, one skill, and the recipe
prompts, all from the declared `pi` manifest. There is no relink step.

### Coming from the old `link pi` install

Before the package, the old `link pi` verb wrote a shim at
`~/.pi/agent/extensions/mu.ts` and a skill link at
`~/.agents/skills/mu`. `pi update` registers nothing for that install,
and a shim left in place loads a second copy of the extension next to
the package. In this order:

```bash
npm i -g @mu-crew/mu@latest
pi install npm:@mu-crew/mu    # once: registers the package
mu pi migrate                 # report only
mu pi migrate --apply         # move mu-owned files aside; nothing is deleted
```

Then restart pi agents or send them `/reload`.

Only a file mu can prove it generated is moved, into a `disabled/`
folder pi does not read: a file byte for byte equal to the shim `link pi` generated (only its
generated import URL may differ), or a skill
link into this install's `skills/mu` (or a skill copy identical to a
released one). Anything else (your own `mu.ts`, an edited copy, a link
to somewhere else, even one named `mu`) is reported with its path and
left for you. `MU_PI_HOME` changes the home directory both start from.

For agents other than pi, see [README § Install](../../README.md#install).

## Reload running pi agents

A running pi keeps the extension it loaded at start. After an upgrade,
send `/reload` to each agent, or respawn the agent. From a shell:

```bash
mu agent send worker-1 -w auth '/reload'   # extension serves op command; older: respawn
```

Until then, the `ctl` row of `mu doctor` warns
`extension X older than installed Y` or `extension lacks ops`. Ops the old extension lacks,
such as `send --fresh`, fail with exit 4.

An agent started before the pi package was installed has no control
socket, so a send to it fails with `ctl missing`. Restart it.

## Upgrade from 4.x to 5

mu 5 uses schema 14 and its own state dir, `~/.local/state/mu5`
(`$XDG_STATE_HOME/mu5`). Every mu 4 build refuses a v14 DB, and mu 5
never opens mu 4's DB in place. Instead, the first mu 5 verb imports
`~/.local/state/mu-next/mu.db` once, and says so on stderr. mu 4's
directory is never written, so mu 4 keeps working on its own copy. From
then on the two are separate sync peers and cannot see each other's
agents.

The import refuses, leaving everything as it was, until two things hold:

1. Every mu 4 agent, lease reservation and unfinished delegate call is
   closed with mu 4: their sockets, job files and locks live under
   `mu-next`.
2. With `MU_SYNC_DIR` set, mu 4 has published all its ops: run `mu sync`
   with mu 4 first. mu 5 gets a new machine id and never publishes mu 4's.

Then run mu 5 again. With `MU_STATE_DIR` or `MU_DB_PATH` set, nothing is
imported. To start fresh instead, create mu 5's DB once with any verb run
as `MU_DB_PATH=~/.local/state/mu5/mu.db mu state`.

## Upgrade from 3.x to 4.0

4.0 is a breaking release with its own DB. It does not import a 3.x DB,
and nothing converts one. 3.x keeps its state in `~/.local/state/mu`
(`$XDG_STATE_HOME/mu`); 4.0 keeps its state in `~/.local/state/mu-next`
(`$XDG_STATE_HOME/mu-next`), a name kept so the two never share a DB,
socket or worktree. The release notes list every breaking change:
[CHANGELOG](../../CHANGELOG.md).

There is no flag day. Each machine switches when its human decides:

1. Close the 3.x agents you no longer need (`mu agent close`); 4.0 cannot
   see them.
2. If you still need the old DB, [keep 3.x runnable](#keep-3x-runnable)
   before you install: `npm i -g @mu-crew/mu@latest` replaces the `mu` on
   your `PATH`.
3. Install 4.0 as above (`npm i -g @mu-crew/mu@latest`, `pi install`,
   `mu pi migrate --apply`). `mu --version` should print `4.x`.
4. Give 4.0 its own sync folder, or none. Sync stays off until you set
   `MU_SYNC_DIR`. If any segment in the folder opens with a 3.x (v1)
   line, every 4.0 verb exits 4 with `MU_SYNC_DIR holds 3.x segments;
   give mu 4 its own dir` before it reads or writes anything. Unset
   or change `MU_SYNC_DIR` in a shell that also runs 3.x.
5. Move workstreams one at a time, from the machine that holds each one,
   with [Move a 3.x workstream](#move-a-3x-workstream). Only open tasks
   move; owners, agents and history stay in the 3.x DB, an archive. Its
   one 3.x write is the last step: it parks each moved task with
   `--why "moved to 4.0"`, so nobody works it twice.

Rollback: `pi remove npm:@mu-crew/mu`, `npm i -g @mu-crew/mu@3`, then
3.x's `link pi` to relink its shim. Nothing needs converting. For each
moved workstream, run `mu task unpark <id> -w <ws>` on 3.x per task. Work
done in 4.0 since the move stays in 4.0's DB.

## Keep 3.x runnable

`npm i -g @mu-crew/mu@latest` replaces the `mu` on your `PATH`, so the
3.x move needs 3.x from somewhere else. Install it into its own
prefix, or run it once with npx:

```bash
npm i --prefix ~/.local/share/mu3 @mu-crew/mu@3.13.3
~/.local/share/mu3/node_modules/.bin/mu --version   # 3.13.3

npx -y @mu-crew/mu@3.13.3 --version                # no install; slower to start
```

Use that path, or the `npx` command, as `<mu3>` in [Move a 3.x workstream](#move-a-3x-workstream). 3.x reads its own state dir, so
it finds the old DB with no flags. Use it to read the archive and to park
moved tasks, not for new work: `mu pi migrate --apply` moved aside the
shim 3.x's pi agents load. A harness that runs `mu` through your shell rc
may pick the wrong one; see
[Pin the mu the harness runs](other-agent-clis.md#pin-the-mu-the-harness-runs).

## Move a 3.x workstream

Run this on the machine holding the 3.x workstream. `mu` is 4.x;
`<mu3>` is 3.x (see [Keep 3.x runnable](#keep-3x-runnable)). 4.x runs on
its own state dir and `MU_SYNC_DIR` (or none).

1. Read the old DB with `sqlite3 -readonly -json <old.db> "<query>"`,
   never through `MU_DB_PATH`.
2. Finish each IN_PROGRESS task, or `<mu3> task release <id> -w <ws>`
   (park refuses it).
3. Select the open tasks (local_id, title, impact, effort_days,
   substate), each one's first and last note (the brief; the park reason
   or status), and the `task_edges` with both ends open (`from_task_id`
   blocks `to_task_id`). A last note that is the brief or
   `CLAIM: dispatch` is no status: write one.
4. Script it (argv lists: briefs hold quotes), dependents first, since
   `--blocks` needs the dependent to exist:
   `mu task add <id> -t <title> -i <impact> -e <effort> --blocks <dependents> --note - -w <ws>`
   with the brief on stdin, then
   `mu task note <id> -w <ws> -` with `moved from 3.x <ws>/<id>; last note: <it, capped 2 KB>`.
   For a parked task pass that text to `mu task park <id> -w <ws> --why`
   instead. Keep the ids.
5. Check that open-task and edge counts match (`mu sql ... --all`) and
   that `mu task tree <a root> -w <ws>` matches. Fix a mismatch.
6. Mark the old tasks:
   `MU_DB_PATH=<old.db> <mu3> task park <id> -w <ws> --why "moved to 4.0"`
   per moved task.

To move a 4.x workstream between machines, see the
[move recipe](../../skills/mu/recipes/move.md).

## Old DBs

A v14 DB missing a later addition is completed on its first open, in one
transaction: it either completes or leaves the file as it was. mu
refuses a DB older than v14 with `SchemaTooOldError`, and a newer one
with `SchemaTooNewError`. Both exit 4 and leave the file alone, so
pointing mu 5 at a mu 4 or 3.x DB (`MU_DB_PATH`) is safe. Back up an old
DB and move it aside.

## Run mu from a checkout

```bash
npm install && npm run build
alias mu="node $PWD/dist/cli.js"
```

Or run `npm install -g .` in the checkout. Its `prepare` script builds
first. To load the checkout as the pi package instead of the installed
one, run `pi install /path/to/checkout`.
