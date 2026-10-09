# Waves: several workers in one repo

Use when two or more workers edit the same repo at once. Every worker
runs in its own `--workspace`; this recipe decides what each one gets.

1. **Bucket by file cluster, not severity.** Two agents editing one
   file conflict, whatever the priority. Chain tasks that share files
   (`mu task block B --by A`) so only one is ready at a time.
2. **Freeze only what conflicts.** Give idle workers tasks that avoid
   the shared files. A blanket freeze idled four of five workers for a
   day.
3. **Pipeline the merge.** Cherry-pick each task as it closes and
   verify the merged tree ([orchestrator-loop § Merging](orchestrator-loop.md#merging));
   never wait for the whole wave.
4. **Refresh before each dispatch.** `mu workspace refresh <agent>`
   rebases onto the tracked main (git: `origin/HEAD`, so unpushed local
   merges are missed; pass `--from <local-branch>` to include them) and
   keeps the agent's context; run it before every `--fresh` send.

Done when every task in the wave is `CLOSED/done`, merged, and the
merged tree passes the gate command.
