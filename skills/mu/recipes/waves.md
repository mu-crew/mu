# Waves: several workers in one repo

Use when two or more workers edit the same repo at once. Every worker
runs in its own `--worktree`; this recipe decides what each one gets.

1. **Bucket by file cluster, not severity.** Two agents editing one
   file conflict, whatever the priority. Chain tasks that share files
   (`mu task block B --by A`) so only one is ready at a time.
2. **Freeze only what conflicts.** Give idle workers tasks that avoid
   the shared files. A blanket freeze idled four of five workers for a
   day.
3. **Pipeline the merge.** Cherry-pick each task as it closes and
   verify pinned merge batches ([orchestrator-loop § Merging](orchestrator-loop.md#merging));
   batching gates does not mean waiting for the whole wave.
4. **Refresh before each dispatch.** Before a `--fresh` send,
   `git -C <cwd> fetch && git -C <cwd> rebase <base>` (base: `origin/HEAD`,
   or local main when merged locally); on conflict
   `git -C <cwd> rebase --abort` and tell the human. The rebase keeps the
   agent's context.

Done when every task in the wave is `CLOSED/done`, merged, and the
merged tree passes the slow gate and fast if needed, per the repo contract.
