# Waves: several workers in one repo

Use when two or more workers edit the same repo at once. Every worker
runs in its own `--workspace`; this recipe decides what each one gets.

1. **Bucket by file cluster, not severity.** Two agents editing one
   file conflict, whatever the priority. Put tasks that share files on
   one track (`mu task block`) so only one agent holds them.
2. **Freeze only what conflicts.** Give idle workers tasks that avoid
   the shared files. A blanket freeze idled four of five workers for a
   day.
3. **Pipeline the merge.** Cherry-pick each task as it closes and
   verify the merged tree; never wait for the whole wave.
4. **Refresh between waves.** `mu workspace refresh <agent>` rebases
   onto main and keeps the agent's context. Dispatch the next wave only
   from refreshed workspaces.

Done when every task in the wave is `CLOSED/done`, merged, and the
merged tree passes the gate.
