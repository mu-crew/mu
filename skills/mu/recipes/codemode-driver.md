# Codemode driver

Use when a pi orchestrator with the `codemode` tool has one step that
dispatches many workers, or many [delegate calls](tasks-or-calls.md#delegate-call)
whose verdicts you want back as one table. A script issues those calls
in parallel. It stays a driver: the script is the agent's, not mu's,
and the plan, the state, and the results live in the DB.

## The rule

**Delete the script mid-run and nothing is lost.** That holds when:

- The script calls only `mu` verbs, through `tools.bash` (or
  `tools.mu_delegate`, below). It reads state with `mu state --json` /
  `mu task notes`, never from its own variables across calls.
- Every task it dispatches exists in the DAG before the script starts.
  The script adds no tasks the orchestrator has not planned, except the
  ones a recipe step names (the next round, a finding).
- `store()` / `load()` hold nothing a re-run needs. The DAG is the
  cursor.
- Before it runs, log a one-line summary and the task ids it touches:
  `mu log -w <ws> --kind driver 'dispatch wave 2: sweep_a sweep_b'`.

## Workers

```js
// @options: {"timeout_ms": 1800000}
const ws = "audit";
const workers = ["worker-1", "worker-2", "worker-3", "worker-4"]; // within the ceiling
const sh = async (c) => {
  const r = await tools.bash({ command: c });
  if (r.exit_code !== 0) throw new Error(`${c}: ${r.output}`);
  return r.output;
};
const ready = JSON.parse(await sh(`mu task next -w ${ws} -n 0 --json`)).items.slice(0, workers.length);
await Promise.allSettled(ready.map(async (t, i) => {
  await sh(`mu task claim ${t.name} -w ${ws} --for ${workers[i]} --evidence 'driver dispatch'`);
  await sh(`mu workspace refresh ${workers[i]} -w ${ws}`);
  await sh(`mu agent send ${workers[i]} -w ${ws} --fresh 'Work on ${t.name}. Read: mu task notes ${t.name} -w ${ws}'`);
}));
const wait = await tools.bash({ command: `mu task wait -w ${ws} ${ready.map((t) => t.name).join(" ")} --first --on-stall exit --json` });
return wait.output;
```

Size the worker list from the ceiling on the umbrella
([orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency)),
one per ready task. Merge and verify outside the script
([orchestrator-loop § Merging](orchestrator-loop.md#merging)). Check
field names against `--json` output; the script is a shape, not an API.

## Delegate calls

`tools.mu_delegate` works from a script, but it returns at once and the
answers arrive after the script, as follow-up messages: the script
gains nothing over issuing the calls in one turn. Use it from a script
only when `codemode.mode` is `only` and the tool is not offered
directly. Check `Promise.allSettled` results for rejections; the cap is in
[orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency).

To get the verdicts back as one table instead of one message each, use
the `scratch` form through `tools.bash`:

```js
// @options: {"timeout_ms": 1800000}
const ws = "audit";
const findings = ["f_auth_put", "f_sql_order"]; // finding task ids, within the cap
const sh = async (c) => (await tools.bash({ command: c })).output;
const dir = `${(await sh("echo $HOME")).trim()}/.local/state/mu`;
const json = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const el = (ms) => { const t = Math.round(ms / 1000); return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`; };
const rows = await Promise.all(findings.map(async (id, i) => {
  const a = `refuter-${i + 1}`, t0 = Date.now();
  await sh(`mu agent spawn ${a} -w scratch`);
  const { runs } = json(await sh(`mu agent send ${a} -w scratch --fresh --json - <<'MU_EOF'\n<brief for ${id}, ending with the VERDICT block>\nMU_EOF`));
  const w = json(await sh(`mu agent wait ${a} -w scratch --after-runs ${runs} --json --timeout 1200`)).agents?.[0] ?? {};
  const lines = (w.lastText ?? "").trimEnd().split("\n");
  const at = lines.findLastIndex((l) => /^[\s>*_`-]*VERDICT:/.test(l));
  const note = w.outcome !== "done" ? `REFUTER ${i + 1}: no verdict (${w.outcome ?? "no result"})`
    : `REFUTER ${i + 1} (${a}, ${el(Date.now() - t0)}):\n` + (at < 0 ? `NO VERDICT LINE: ${(w.lastText ?? "").slice(-1500)}`
    : [lines[at], ...lines.slice(at + 1).filter((l) => /^[\s>*_`-]*EVIDENCE:/.test(l))].join("\n"));
  await tools.write({ path: `${dir}/note-${a}.txt`, content: note }); // answer text never touches a shell
  await sh(`mu task note ${id} -w ${ws} - < ${dir}/note-${a}.txt && rm ${dir}/note-${a}.txt`);
  if (w.outcome === "done") await sh(`mu agent close ${a} -w scratch`);
  return `${id}\t${note.split("\n")[1] ?? note}`;
}));
return rows.join("\n");
```

What the tool did for you, the script now owns:

- **The cap.** `MU_DELEGATE_MAX` does not apply to bash spawns: keep
  each script's list within
  [orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency).
- **Cleanup.** Close each scratch pane; a timed-out one stays, readable
  with `mu agent read <a> -w scratch`.
- **Recording.** The script writes each `REFUTER` note in `record`'s
  shape, and `no verdict (<outcome>)` for a failed wait; it does not
  cap long answers or special-case empty ones as `record` does. Decide
  each finding after it returns ([findings § Triage](findings.md#triage)
  step 3).

## Traps

- **One wave per script.** A script that loops forever hides progress
  from you and from the human. Dispatch, wait for the first close,
  return; merge and verify outside the script, then run it again. A
  tournament runs one round per script.
- **A script timeout cancels the waits, not the workers.** Workers keep
  running and their tasks stay claimed. Re-read `mu state` and carry on.
- **Briefs are not template literals.** A backtick in a brief ends the
  string and the whole script fails before any call starts. Build
  briefs with `tools.read` from a file, or as plain strings.
- **Exit codes are data.** `mu task wait` exit 7 means a worker needs
  you; return it to the model instead of retrying.

Done when the script returned, `mu state` shows the dispatched tasks
claimed (workers) or every verdict is recorded on its finding (delegate
calls), and no scratch pane the script opened is left running.
