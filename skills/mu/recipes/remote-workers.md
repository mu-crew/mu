# Remote workers

Use when an agent's process runs on another machine (a devserver, a
bigger box) while its pane stays local. mu has no remote backend, ssh
code, or host registry. This is a recipe plus the traps that cost time.

**If you read one thing:** on a session-capped host, an open attach pane
holds the only ssh channel and silently breaks `git fetch`,
`murmur collect`, and every other ssh. Attach to look, then
`mu agent close`.

## The model

- **The pane is local, the process is remote.** The pane's foreground
  process is ssh. `send`, `read`, and the reaper work unchanged. The pi
  control socket rides the same ssh as a `-L` forward, so pi state,
  `wait`, and `abort` are exact.
- **One orchestrator DB.** Never run a second mu on the host.
  `tasks.owner_id` is an FK into the machine-local `agents` table, so a
  remote mu cannot claim tasks in your DAG.
- **mu does not know the remote workspace**: no `mu workspace` verbs,
  staleness warning, or auto-free. You own it.
- **Everything is orchestrator-pull.** The host usually has no route
  back to your laptop. Push setup out, fetch commits back.

## The recipe

```bash
# 1. WORKSPACE: you create it; --workspace is local-only
ssh dev 'git -C ~/repo worktree add ~/ws/worker-1'

# 2. RECORD: location and per-worker baseline, in one note
mu task note t1 -w big "REMOTE: dev:~/ws/worker-1
REMOTE_BASE: worker-1:$(ssh dev 'cd ~/ws/worker-1 && git rev-parse HEAD')"

# 3. SPAWN: env goes INSIDE the command (tmux -e stops at the hop).
#    remote-env prints the socket forward and the identity env; it runs nothing.
#    $SHELL -ilc: ssh's non-interactive shell skips ~/.zshrc (PATH, provider env).
eval "$(mu agent remote-env worker-1 -w big --shell)"  # MU_SSH_ARGS, MU_REMOTE_ENV
mu agent spawn worker-1 -w big --command \
  "ssh $MU_SSH_ARGS dev -t 'cd ~/ws/worker-1 && $MU_REMOTE_ENV \$SHELL -ilc \"pi --approve\"'"

# 4. CLAIM + SEND: as for a local agent
mu task claim t1 -w big --for worker-1 --evidence 'remote on dev'
mu agent send worker-1 -w big --fresh '...'

# 5. WAIT: pi: mu agent wait worker-1 -w big --after-runs <send's runs> --json,
#    then the claim's Next: once, after the worker reports done.
#    non-pi: the same, once per reported-done turn

# 6. COLLECT: fetch straight from the remote worktree
git fetch "ssh://dev/~/ws/worker-1" HEAD && git cherry-pick FETCH_HEAD
```

Done when the worker's commits are cherry-picked locally, the merged
tree passes the gate command (on the host, below), and the pane is
closed.

### Step 2: the note is load-bearing

Keep the exact forms `REMOTE: <host>:<path>` and
`REMOTE_BASE: <agent>:<sha>`. `mu task claim --for` builds the
poll-and-close command from them, and `mu state` lists `REMOTE:` lines.
For a crew, poll every path in one bounded mule job:

```bash
mule run --max-secs 30 'for d in ~/ws/*/; do printf "%s %s\\n" \
  "$(basename $d)" "$(cd $d && git rev-parse HEAD 2>/dev/null || echo unreadable)"; done'
mule wait <job>; mule tail <job>
```

Accept only 40 hex characters. `unreadable` or an empty field means
retry next turn, not progress.

### Step 3: the control-socket forward

Spawn reports `ctl: ok` when all of these hold (`mu doctor` has a ctl
row per agent):

- The host has the mu extension: run `mu link pi` there.
- The ssh is direct. `$MU_SSH_ARGS` sets `ControlMaster=no
  ControlPath=none`; a multiplexed ssh never binds the forward and spawn
  reports `ctl: missing`.
- sshd allows the forward. A refused forward kills the pane at spawn
  (`ExitOnForwardFailure=yes`). Check `AllowStreamLocalForwarding`.

A dead ssh leaves the socket file, which probes `refused`, never a
stale `ok`. Non-pi agents get state from murmur, lagging 30 s ± 10 s
plus a 10 s cache.

### Step 5: poll once per turn

The claim's `Next:` mule poll closes the task as done on any change of
the remote HEAD. Run it once, only after the worker reports done (its
close or final answer). For a pi worker, first block on
`mu agent wait <name> --after-runs <runs> --json`, with `runs` from
`mu agent send --json`. It settles exactly over the forwarded socket,
and it returns at once for a run that settled before the wait started.
Pass `<runs>` unchanged. On exit 5 (timeout), or on a wait that returns
while the worker asks a question, do not poll: read the pane
(`mu agent read <name> -n 20`) and answer.

- Never `sleep` in a tool call. Aborting the loop can leave remote work
  and a capped channel running.
- Set a deadline before dispatch. At expiry, read the pane, then release
  or re-dispatch.
- On a capped host, run `Next:` through mule. A refused bare ssh returns
  an empty sha that looks like progress.

### Step 6: fetch from the worktree

- No shared remote or bare repo is needed. It exits 128 on failure, so
  `&&` chaining is safe.
- Quote the URL. Unquoted, your local shell expands `~` to your laptop's
  home.
- Bucket work by file cluster, not by machine.

### Run the merged gate on the host

Do not re-run what the worker ran. Only the merge is unverified.
Cherry-pick locally, push the merged head to the host, and run the gate
there with its warm dependencies:

```bash
git cherry-pick <sha>
git push -q "ssh://dev/~/hacking/<repo>.git" HEAD:refs/heads/gate-tmp
mule run --cwd ~/hacking/<gate-checkout> --wait \
  'git fetch -q origin gate-tmp && git checkout -q --detach FETCH_HEAD && npm run check'
```

`<gate-checkout>` is a scratch checkout or worktree used only for
gates, never one holding work. Push to a temporary ref, never `main`;
delete it afterwards (`git push origin :gate-tmp`). Push to `main` only
after the gate passes.

`--wait` exits with the suite's code. A bare ssh would hold the capped
channel for minutes. Keep two gates local: platform-sensitive tests (macOS `ps` returns argv,
Linux `ps -e` appends the environment, and a real bug lived there), and
the final gate before the push that matters.

## Traps

### A non-pi spawn on an auth prompt looks healthy

With the channel busy, the attach ssh stopped at `Enter a passcode:`.
Spawn succeeded, the agent showed `needs_input`, and the prompt went
into the passcode field. This applies to non-pi CLIs and to
`--via mux`, which paste into the pane. Confirm such an agent got the
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

### Tell the worker that mu is absent

mu is usually not on the host, so the in-pane loop cannot run. Say so
in the prompt and have the worker print its sha. You claim, note, and
close. Otherwise `mu task wait` hangs.

### A dropped connection reaps the task, not the commit

The reaper reverts the task to OPEN, but the commit is still on the
host. Fetch from the `REMOTE:` path before re-dispatching.

### A dead non-pi remote agent vanishes

murmur records `crashed` only when a pane outlives its process. Remotely
tmux reaps the session with the agent, so SIGKILL gives zero rows, not
`crashed`. (A dead pi agent probes `refused`.) Trust the `[reaper]`
note and `ssh <host> 'tmux ls'`.

### Stopping and cleaning up

- `mu agent abort <name>` stops a pi turn through the forwarded socket.
- `mu agent kick` signals the local ssh client, not the remote agent.
  For an unresponsive agent, `mu agent close` and respawn.
- mu does not remove remote worktrees:
  `ssh dev 'git -C ~/repo worktree remove ~/ws/worker-1'`.

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

**`$MU_REMOTE_ENV` goes inside the ssh command.** Without it the agent
reports `driver=human` and shows in your own status bar.

**murmur sees the remote pane** and links it to your local pane by the
agent name in the local argv (`attached here %N`; focus instead of a
second connection). The detached shape carries the name only in the
session name, so name it `mu-<agent>`. An env prefix does not help:
macOS `ps` reports argv, not env.

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
  like success. Keep worktree setup and `murmur collect` bare: they fail
  loudly.
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

### Run the agent in detached remote tmux

Decouple the agent from the connection to release the channel:

```bash
eval "$(mu agent remote-env worker-1 -w big --shell)"
# Agent runs detached on the host; this ssh returns at once
ssh dev "tmux new-session -d -s mu-worker-1 -c ~/ws/worker-1 \
  '$MU_REMOTE_ENV \$SHELL -ilc \"pi --approve\"'"

# Attach a local pane (with the socket forward); claim and send as usual
mu agent spawn worker-1 -w big --command "ssh $MU_SSH_ARGS dev -t 'tmux attach -t mu-worker-1'"

# COLLECT: detach first to free the channel, then fetch
mu agent close worker-1 -w big
git fetch "ssh://dev/~/ws/worker-1" HEAD && git cherry-pick FETCH_HEAD

# Reattach later with the same spawn command; LLM context is intact
```

- An attached pane blocks other ssh exactly like a direct one. Close it
  before fetching, or use mule.
- `mu agent close` detaches. It does not stop the agent. To stop it:
  `ssh dev 'tmux kill-session -t mu-worker-1'`. `ssh dev 'tmux ls'` is
  the only inventory of these sessions.
- A dropped connection no longer reaps the agent. Each attach
  re-creates the socket forward.
- Keep the session name `mu-<agent>`: mu records neither, so it is the
  only link. On an uncapped host this shape buys nothing.

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

On a capped host: ET for you, mule for tooling, detached tmux for mu
agents. None of them competes for the slot.
