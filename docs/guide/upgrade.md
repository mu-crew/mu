# How to upgrade mu

Coming from 3.x? Read [Upgrade from 3.x](#upgrade-from-3x) first:
`npm i -g @mu-crew/mu@latest` replaces your 3.x `mu`.

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

## Upgrade from 3.x

mu 5 never imports a 3.x DB. 3.x keeps its state in `~/.local/state/mu`, mu 5
in `~/.local/state/mu5`, so the two never share a DB, socket or worktree.
`npm i -g @mu-crew/mu@latest` replaces the `mu` on your `PATH`: to read the
old DB or park tasks, install 3.x into its own prefix
(`npm i --prefix ~/.local/share/mu3 @mu-crew/mu@3.13.3`) and read it with
`sqlite3 -readonly`. Close the 3.x agents you no longer need, then move open
work by hand with `mu task add` (briefs, `--blocks` edges, one workstream at
a time; the old DB stays an archive). Give mu 5 its own `MU_SYNC_DIR`, or
none: it refuses a folder holding 3.x segments. `mu pi migrate --apply` moves
aside the shim 3.x's pi agents load. Rollback: `pi remove npm:@mu-crew/mu`,
`npm i -g @mu-crew/mu@3`, then 3.x's `link pi`. A harness that runs `mu`
through your shell rc may pick the wrong one: see
[Pin the mu the harness runs](other-agent-clis.md#pin-the-mu-the-harness-runs).

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
