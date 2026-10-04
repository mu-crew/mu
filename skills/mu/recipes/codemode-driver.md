# Codemode driver

Use when a pi orchestrator with the `codemode` tool runs a recipe with
many parallel units, and one tool call per spawn, send, and wait is
slow. A script can issue those calls in parallel. It stays a driver:
the plan, the state, and the results live in the DB.

## The rule

**Delete the script mid-run and nothing is lost.** That holds when:

- The script calls only `mu` verbs, through `tools.bash`. It reads
  state with `mu state --json` / `mu task notes`, never from its own
  variables across calls.
- Every task it dispatches exists in the DAG before the script starts.
  The script adds no tasks the orchestrator has not planned, except the
  ones a recipe step names (the next round, a finding).
- `store()` / `load()` hold nothing a re-run needs. The DAG is the
  cursor.
- The script's source goes into the log before it runs:
  `mu log -w <ws> --kind driver '<what it does, which tasks>'`.

## Shape

```js
// @options: {"timeout_ms": 1800000}
const ws = "audit";
const sh = async (c) => {
  const r = await tools.bash({ command: c });
  if (r.exit_code !== 0) throw new Error(`${c}: ${r.output}`);
  return r.output;
};
const ready = JSON.parse(await sh(`mu task next -w ${ws} -n 0 --json`)).items;
await Promise.allSettled(ready.slice(0, 4).map(async (t, i) => {
  const w = `worker-${i + 1}`;
  await sh(`mu task claim ${t.name} -w ${ws} --for ${w} --evidence 'driver dispatch'`);
  await sh(`mu agent send ${w} -w ${ws} --fresh 'Work on ${t.name}. Read: mu task notes ${t.name} -w ${ws}'`);
}));
const wait = await tools.bash({ command: `mu task wait -w ${ws} ${ready.slice(0, 4).map((t) => t.name).join(" ")} --first --on-stall exit --json` });
return wait.output;
```

Check field names against `--json` output before relying on them; the
script above is a shape, not an API.

## Traps

- **One wave per script.** A script that loops forever hides progress
  from you and from the human. Dispatch, wait for the first close,
  return; merge and verify outside the script, then run it again.
- **A script timeout cancels the waits, not the workers.** Workers keep
  running and their tasks stay claimed. Re-read `mu state` and carry on.
- **Exit codes are data.** `mu task wait` exit 7 means a worker needs
  you; return it to the model instead of retrying.
