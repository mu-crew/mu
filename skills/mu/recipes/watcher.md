# Watcher

Use when a helper polls something outside mu (a PR, CI, a log) and
acts on change. Run it in `scratch`, or in the workstream it serves.

1. **Keep last-seen state in a log ledger**, not in the helper's
   context. Write one line per observation:
   `mu log -w scratch --kind pr-state 'pr=1234 sha=abc ci=red'`.
2. **Read the last entry before acting:**
   `mu log -w scratch --kind pr-state -n 1 --json`.
   Act only when the new observation differs.
3. **Wait with mu, not `sleep`.** `mu agent wait <names...> --first`
   returns when an agent goes busy → idle.

The ledger survives a dead or fresh helper: a replacement reads the
last line and carries on. To act on new items (issues, alerts), see
[backlog-triage](backlog-triage.md).

Done when the watched thing reaches its end state (PR merged, CI green) and the last ledger line says so.
