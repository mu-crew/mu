# How to upgrade mu

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

## Upgrade from 3.1 or earlier

Before 3.2.0, mu pasted text into pi panes. Now it sends through a
control socket. Agents started before the pi package was installed have no socket, so
sends to them fail with `ctl missing` instead of pasting. Restart those
agents.

## Old DBs

A schema v12 DB upgrades to v13 on its first open, in one
transaction: it either completes or leaves the file as it was. mu
refuses a DB older than v12 with `SchemaTooOldError`, and a newer one
with `SchemaTooNewError`. Both exit 4 and leave the file alone. Back up an old DB and move it aside. mu-next does not import a 3.x DB:
it runs beside 3.x with its own DB, and workstreams move by a recipe
(docs/mu-next/README.md, Move).

## Run mu-next beside 3.x

mu-next keeps its state in `~/.local/state/mu-next` (`$XDG_STATE_HOME/mu-next`);
3.x keeps `~/.local/state/mu`. Sync stays off until you set `MU_SYNC_DIR`,
and the folder must be mu-next's own: if any segment in it opens with a
3.x (v1) line, every verb exits 4 with
`MU_SYNC_DIR holds 3.x segments; give mu-next its own dir` before it
reads or writes anything. Unset or change `MU_SYNC_DIR` in a shell that
also runs 3.x.

## Run mu from a checkout

```bash
npm install && npm run build
alias mu="node $PWD/dist/cli.js"
```

Or run `npm install -g .` in the checkout. Its `prepare` script builds
first. To load the checkout as the pi package instead of the installed
one, run `pi install /path/to/checkout`.
