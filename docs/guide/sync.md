# How to sync between machines

Set one environment variable to the same folder on every machine:

```bash
export MU_SYNC_DIR=$HOME/Sync/mu
```

Every `mu` command then writes your ops to
`$MU_SYNC_DIR/<machine_id>.jsonl` and reads every other `.jsonl` file
in the folder. There is no export, import, or peer list. A new machine
appears when its file does.

```bash
# laptop
mu task add auth_fix -w app -t "Fix the auth redirect" -i 80 -e 2
# devserver, after the folder syncs
mu task close auth_fix -w app --evidence "shipped in #412"
```

## Keep the DB out of the sync folder

Never put `MU_DB_PATH` inside `MU_SYNC_DIR`. A live SQLite DB is three
files (`mu.db`, `-wal`, `-shm`). A file syncer copies them out of
order and can bring back a stale `-wal`, which corrupts the DB with no
error. `mu doctor` fails the `db-vs-sync` row when you do this.

Also keep the DB off NFS, SMB, and sshfs. `mu doctor` warns in the
`db-filesystem` row.

## Move the files

mu never runs ssh, scp, or rsync. Segments are append-only and each
file has one writer, so any file mover works:

| Mover | How |
| ----- | --- |
| Syncthing (recommended) | share `$MU_SYNC_DIR` on every machine |
| rsync | `rsync -av host:$MU_SYNC_DIR/ $MU_SYNC_DIR/`, in both directions |
| sshfs or NFS | point `MU_SYNC_DIR` at the mounted folder |
| scp or a USB stick | copy the `.jsonl` files whenever you like |

Copying is safe in any direction and any number of times. An
interrupted copy leaves a cut last line that mu skips until the next
copy completes it.

On macOS, do not use iCloud Drive, Dropbox, Google Drive File Stream,
or OneDrive Files On-Demand. They replace idle files with network
stubs, and mu reads the folder on every command, so commands hang.

## Check peers

```bash
mu sync
```

The table lists each peer by `machine_id` prefix, when you last saw
it, and `behind`: lines you hold but have not applied. A non-zero
`behind` is either a copy in flight or a cut file.

```bash
mu sync --repair c8ec                              # re-read a peer's file from the start
mu sync --from /mnt/devserver/.local/state/mu/mu.db # read a peer's DB directly
MU_SYNC_DIR=/media/usb-stick mu state              # one-off folder
```

Ingest is idempotent, so `--repair` is safe at any time.

## Know what travels

Workstreams, tasks, edges, and notes travel. Agents and workspaces
stay on their machine, because a pane id and a local path mean nothing
elsewhere. So task ownership does not sync: a task claimed on the
devserver shows no owner on your laptop.

Merges are per field. If the laptop changes a task's impact while the
devserver closes it, both changes survive. If both machines change the
same field, the later hybrid logical clock (HLC) wins with no warning.
