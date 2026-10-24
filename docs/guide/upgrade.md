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
folder pi does not read: the exact shim `link pi` wrote, or a skill
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

mu refuses a DB older than schema v12 with `SchemaTooOldError`, and a
newer one with `SchemaTooNewError`. Both exit 4 and leave the file
alone. Back up an old DB and move it aside; mu-next imports a 3.x DB
at cut-over.

## Run mu from a checkout

```bash
npm install && npm run build
alias mu="node $PWD/dist/cli.js"
```

Or run `npm install -g .` in the checkout. Its `prepare` script builds
first. To load the checkout as the pi package instead of the installed
one, run `pi install /path/to/checkout`.
