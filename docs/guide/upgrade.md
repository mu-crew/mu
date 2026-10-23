# How to upgrade mu

## Upgrade the package

```bash
npm i -g @mu-crew/mu@latest
mu link pi
mu doctor
```

`mu link pi` installs a one-line shim at
`~/.pi/agent/extensions/mu.ts` that loads the installed extension, and
links `~/.agents/skills/mu` to the package's skill. Later upgrades
update both with no relink. `MU_PI_HOME` changes the home directory
that both paths start from.

- `--copy` copies the extension instead of the shim. You then have to
  relink after every upgrade.
- `--force` replaces an extension or skill symlink that points
  elsewhere, such as a dev checkout. mu replaces the link, never its
  target, and never replaces a real skill directory (exit 4).
- `--extension-only` and `--skill-only` install one part.

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
control socket. Agents started before `mu link pi` have no socket, so
sends to them fail with `ctl missing` instead of pasting. Restart those
agents.

## Old DBs

mu refuses a DB older than schema v11 with `SchemaTooOldError`, and a
newer one with `SchemaTooNewError`. Both exit 4 and leave the file
alone. Back up an old DB and move it aside; mu-next imports a 3.x DB
at cut-over.

## Run mu from a checkout

```bash
npm install && npm run build
alias mu="node $PWD/dist/cli.js"
```

Or run `npm install -g .` in the checkout. Its `prepare` script builds
first. Run `mu link pi --force` to point the skill link at the
checkout.
