# History

Records kept for the reader who wants to know how mu got here. Nothing
here describes current behaviour; when a page here and the shipped docs
disagree, the shipped docs win.

- [CHANGELOG-pre-3.md](CHANGELOG-pre-3.md): releases before 3.0.
- [CHANGELOG-4.0-dev.md](CHANGELOG-4.0-dev.md): every change made
  between 3.13.3 and 4.0.0, as written while the work landed.
- [mu-next-design/](mu-next-design/README.md): the 4.0 rewrite's design
  of record (built under the name mu-next), where each dropped 3.x skill
  rule went ([rule-destinations](mu-next-design/rule-destinations.md)),
  the persistent-capture spike, the isolated side-by-side run, the
  pre-release review reports ([release-review/](mu-next-design/release-review/)),
  and the TUI dogfood kit with its plan
  ([tui-dogfood/](mu-next-design/tui-dogfood/README.md)).

## Raw eval runs

The eval reports keep their tables but not the raw JSONL rows behind
them. Those were removed from the tree after `b26d6c0afd9d` and stay in
git history:

```bash
git show b26d6c0afd9d:docs/mu-next/eval/matrix-release.jsonl
git ls-tree -r --name-only b26d6c0afd9d docs/mu-next/eval | grep jsonl
```
