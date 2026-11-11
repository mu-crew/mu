# Merge

Use when finished units are ready to land on `<base>`.

## Inline

Cherry-pick new commits as workers close. Gate one pinned batch ([test-health](test-health.md)), then push the verified tree. Accept evidence, not close notes: rerun the check. Chain units that edit the same files (`mu task block`) so their picks never conflict.

## Merge task

Past ~4 workers, or when gate logs crowd your context, hand each batch to a task:

```bash
mu task add merge_<n> -w <ws> -t "merge: <units>" --blocked-by <units> --note - <<'EOF'
Cherry-pick <sha>... onto <base>, in order.
Resolve only append-only conflicts (test tails, counts, import unions);
any other: close --as rejected --why "<files>".
Run the slow gate once on the tip; note the GATE record and the tip sha.
Never push. Never edit beyond a conflict.
EOF
mu agent spawn merge-<n> -w <ws> --worktree --task merge_<n>
```

- Check that the GATE record names the tip, then push that sha fast-forward only. You alone push `<base>`.
- Red CI is a [finding](findings.md) with review, never a fix in the merge task.
- Don't steer running workers to rebase; step 3 rebases each one before its next task.
