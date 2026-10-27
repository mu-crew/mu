# History

Records kept for the reader who wants to know how mu got here. Nothing
here describes current behaviour; when a page here and the shipped docs
disagree, the shipped docs win.

- [CHANGELOG-pre-3.md](CHANGELOG-pre-3.md): releases before 3.0.
- [CHANGELOG-4.0-dev.md](CHANGELOG-4.0-dev.md): every change made
  between 3.13.3 and 4.0.0, as written while the work landed.

## Raw eval runs

The eval reports keep their tables but not the raw JSONL rows behind
them. Those were removed from the tree after `b26d6c0afd9d` and stay in
git history:

```bash
git show b26d6c0afd9d:docs/mu-next/eval/matrix-release.jsonl
git ls-tree -r --name-only b26d6c0afd9d docs/mu-next/eval | grep jsonl
```
