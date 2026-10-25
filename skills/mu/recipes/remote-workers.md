# Remote workers

Use when an agent's process runs on another machine (a devserver, a
bigger box) while its pane stays local. mu never connects and knows no
ssh flags: a **host profile** holds your own command templates
(`mu host add`) and `mu agent spawn --host` fills them.

**If you read one thing:** with `--max-sessions 1` the pane's own channel
is the only one. mu holds it for the agent's life, so a bare `ssh dev ...`
or a `git fetch` over ssh fails while an agent runs. Close the agent
first, or run host commands through `mule`.

## The model

- **The pane is the transport.** The local pane runs the profile's
  `--shell` template: it starts the remote pi and forwards its control
  socket to the local derived path. `send`, `read`, `wait`, `abort` and
  the reaper work unchanged, and **the pane dying is the agent dying**
  (close, reconcile, teardown need no remote case).
- **One orchestrator DB.** The host has the pi package (`pi install
  npm:@mu-crew/mu`) but no mu DB. mu gives the remote pi five variables
  only (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`, `MU_WORKSTREAM`,
  `MU_CTL_SOCK`, `MU_REMOTE`), never your DB, state or sync dir. A remote
  worker cannot claim or close tasks: **you close.** Its brief says so and
  asks for the final `git rev-parse HEAD` sha.
- **Everything is orchestrator-pull.** The host usually has no route back
  to your laptop. Fetch commits back.
- **Remote rows are registry fields**: `agents.host`, `cwd` (a path on the
  host) and `base` (the worktree's start commit). `mu state` lists them;
  there is no `REMOTE:` note.

## The recipe

```bash
# 0. ONCE: a profile (print a starter, edit it, add it) and a check
mu host init dev --ssh          # prints a starter `mu host add`; runs nothing
mu host check dev               # host, repo, pi, mu extension

# 1. SPAWN + CLAIM + BRIEF in one journaled attempt
mu agent spawn worker-1 -w big --host dev --worktree --task t1 --send 'Read: mu task notes t1 -w big'

# 2. WAIT: as for a local agent (the forward is the socket)
mu agent wait worker-1 -w big --after-runs <runs> --json

# 3. COLLECT (from the local repo's directory), merge the printed sha, then close
mu agent collect worker-1 -w big
git cherry-pick <sha>
mu agent close worker-1 -w big --if <rev>
```

`--worktree` makes a detached `git worktree add` of HEAD (or `--from`) in
the profile's `--repo`, at `~/.local/state/mu-next/remote-worktrees/<ws>/<name>`
on the host, through the profile's `--exec`. `--cwd` names an existing
remote directory instead. `--root` is refused (it names a local repo).
mu reserves the host's channel **before** its first remote command and
keeps it until the pane dies, so a full host refuses the spawn up front
with the holder named, and a failed spawn removes only the worktree it
made (still clean, still at its base) and frees the slot.

`collect` runs the profile's `--fetch` locally and pins the commit as
`refs/mu/collect/<ws>/<agent>`; a live worker holds the pane's channel, so at
`--max-sessions 1` it is refused until the pane is gone (raise the cap to
collect mid-run). `close` kills the pane, then removes the remote worktree
only if clean and at its base or the collected HEAD (never `--force`); a newer
HEAD refuses: collect again, or `--keep-branch`. Dirty always refuses.

Done when the worker's commits are merged locally, the merged
tree passes the merged-tree gates (host and local checks below), and the
agent is closed.

### The control-socket forward

Spawn reports `ctl: ok` when all of these hold (`mu doctor` has a ctl
row per agent, `mu host check dev --agent <name> -w <ws>` probes one):

- The host has the mu extension: `pi install npm:@mu-crew/mu` there.
- The shell template's transport binds the local socket and does not
  multiplex (ssh: `ControlMaster=no ControlPath=none`; the `host init`
  starter has them). A multiplexed ssh never binds the forward and spawn
  reports `ctl: missing`.
- The host allows the forward (sshd `AllowStreamLocalForwarding`). A
  refused forward kills the pane at spawn (`ExitOnForwardFailure=yes`).

A dead transport leaves the socket file, which probes `refused`, never a
stale `ok`. herdr cannot run a profile's shell template: `--host` is
refused there in one line (use tmux).

### Wait once per reported-done turn

For a pi worker, block on `mu agent wait <name> --after-runs <runs>
--json`, with `runs` from the spawn or send. It settles exactly over the
forwarded socket, and returns at once for a run that settled before the
wait started. On exit 5 (timeout), or a wait that returns while the
worker asks a question, read the pane (`mu agent read <name> -n 20`) and
answer. Never `sleep` in a tool call, and set a deadline before dispatch.

### Fetch from the worktree

- No shared remote or bare repo is needed. It exits 128 on failure, so
  `&&` chaining is safe.
- Quote the URL. Unquoted, your local shell expands `~` to your laptop's
  home.
- Bucket work by file cluster, not by machine.

### Run the merged gate on the host

Reuse only equivalent [gate records](test-health.md#gate-contract).
Cherry-pick a merge batch locally, push its pinned head to the host, and run
full slow there with warm dependencies, plus fast if slow excludes it:

```bash
git cherry-pick <sha>
git push -q "ssh://dev/~/hacking/<repo>.git" HEAD:refs/heads/gate-tmp
mule run --cwd ~/hacking/<gate-checkout> --wait \
  'git fetch -q origin gate-tmp && git checkout -q --detach FETCH_HEAD && npm run check'
```

`<gate-checkout>` is a scratch checkout or worktree used only for
gates, never one holding work. Push to a temporary ref, never `main`;
delete it afterwards (`git push origin :gate-tmp`). Push to `main` only
after required gates pass. Replace `npm run check` with the repo's canonical
merged-tree command(s), preserving full scope and recording host conditions.
Keep the gate checkout pinned while other remote workers continue in theirs;
use private artifacts ([build cache](orchestrator-loop.md#build-cache)).

`--wait` exits with the suite's code. A bare ssh would hold the capped
channel for minutes. Retain local platform-sensitive checks (macOS `ps`
returns argv, Linux `ps -e` appends the environment, and a real bug lived
there), and the repo-required final local gate before the push that matters.
A remote pass does not substitute for non-equivalent local conditions.

## Traps

### A non-pi spawn on an auth prompt looks healthy

With the channel busy, the attach ssh stopped at `Enter a passcode:`.
Spawn succeeded, the agent showed `needs_input`, and the prompt went
into the passcode field. This applies to non-pi CLIs on herdr, which are
sent to by prompt. Confirm such an agent got the
work (`mu agent read <name> -n 20`) before trusting it. Send nothing
sensitive to an unconfirmed pane.

A pi agent does not paste. Spawn reports `ctl: ok` only when pi
answers on the socket; otherwise it warns `ctl: missing` or
`ctl: refused`, and `mu agent send` fails instead of typing into the
pane.

### Use the host's real CLI command

If your local `$MU_PI_COMMAND` is a wrapper such as `pi-meta
--pi-meta-no-solo --approve`, plain `pi` on the host gives a live pane
with **no models configured**. Check with `ssh dev 'command -v pi-meta'`.

### A remote worker cannot close or claim

The host has no mu DB, so the remote pi skips the close nudge
(`MU_REMOTE=1`) and `mu task` there reads nothing. The brief says so;
you read the reported sha, collect, and `mu task close`.

### A dropped connection is a dead agent

The pane is the transport: when it dies the row is reaped, the task
reopens, and the commits stay in the remote worktree (mu keeps no record
yet). Fetch from its `cwd` (`mu agent show` before the reap, `mu state` while
it lives) before re-dispatching.

### Stopping and cleaning up

- `mu agent abort <name>` stops a pi turn through the forwarded socket.
- `mu agent close` kills the pane and the remote pi with it, frees the
  host slot, and removes the remote worktree under the rule above.

## murmur

pi agents need no murmur. [murmur](https://github.com/mu-crew/murmur)
reports state for non-pi agents on tmux, and adds status pills,
attachment hints, and `murmur peer list`. Without it, non-pi agents
report `unknown`; everything else works.

| Question | Ask |
| --- | --- |
| What happens next, who owns it, is it done | mu: the DAG, `claim`, `task wait` |
| What is a pi agent doing | mu: the control socket |
| What is a non-pi agent doing; is anything blocked on me | murmur |
| Which host can I reach | murmur: `peer list` |

**murmur sees the remote pane** and links it to your local pane by the
agent name in the local argv (`attached here %N`; focus instead of a
second connection).

### Picking a host

```bash
murmur peer list --json | jq -r '.[] | select(.error) | .name'
```

- `ssh` is last-known reachability. `error` is the current attempt.
- It exits 0 either way. Branch on `.error`, not on presence.
- `murmur collect` prints one line per unreachable host, now.

Attach with the peer's jump command instead of hardcoding ssh. It may
use a transport that takes no ssh session:

```bash
murmur peer set <name> --jump-command '<command with {pane}>'
JUMP=$(murmur peer list --json | jq -r '.[]|select(.name=="dev").jump_command')
mu agent spawn worker-1 -w big --command "${JUMP//\{pane\}/mu-worker-1}"
```

## When the host limits concurrent sessions

Most sshd allow 10 sessions per connection (`MaxSessions`). A hardened
host may set `MaxSessions 1`. Then the ssh holding your agent takes the
only channel, and every other ssh, including `git fetch`, fails with a
misleading `Permission denied (keyboard-interactive)`.

Diagnose in this order. The first check is local and instant:

```bash
ssh-add -l      # "Error connecting to agent" => dead ssh agent, NOT the cap
ssh <host> true # fails while `mu agent read` works => the cap
```

A dead `SSH_AUTH_SOCK` gives the same error via an invisible 2FA prompt;
one session lost an hour treating it as the cap. To find what holds the
channel:
`ps -o pid=,command= -ax | grep "[s]sh <host>"`.

`ControlMaster no` does not help (it governs master creation only).
There is no client fix.

### Run commands through mule

[mule](https://github.com/mu-crew/mule) dispatches detached jobs on its
own ssh ControlPath. On a `MaxSessions 1` host, eight bare `rev-parse`
polls returned one sha and seven empty results; mule ran all eight.

- Use mule for long work and for any command whose refusal could look
  like success. Keep `murmur collect` bare: it fails loudly.
- A mule job is entirely remote. It cannot fetch from, push to, or rsync
  with your laptop.
- For an interactive agent under mule's lifecycle, use `mule run --tui`
  (plain `mule run` has no live TUI). It prints the attach command.
  Closing that pane does not stop the job.

| mule exit | Meaning | Do |
| --- | --- | --- |
| 3 | No ssh master; opening one may need a hardware-key touch | Hand back: ask the operator to run the printed command. Never retry, run `ssh -MNf`, or fall back to `ssh <host> <cmd>` |
| 4, 6 | Not yet | Poll again |
| 5 | No result will ever arrive | Stop polling |

None of these means the work failed. Full table: `mule --help`.

### Use ET for your own shell

Eternal Terminal moves off ssh to `etserver`, so `MaxSessions` never
counts it, even with a nested `tmux attach`. It makes a good jump
command but cannot serve `git fetch`.

```bash
et dev        # or your site's wrapper, such as `x2ssh -et dev`
```

An aborted `et` or `x2ssh` leaves local processes behind. Find them
with `ps -o pid=,command= -ax | grep "[x]2ssh"` and kill only those of
the aborted invocation (match its host or tty), not every x2ssh, before
retrying.

On a capped host: ET for you, mule for tooling, `--max-sessions` for mu
agents (the profile's cap counts the pane's channel). None of them
competes for the slot.
