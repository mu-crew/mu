# Writing a brief

Use when you write anything a worker reads: a task note, a `--fresh` prompt, a reviewer brief. The worker starts with no context.

```text
Task <id> in <ws>. Read: mu task notes <id> -w <ws>
GOAL: <one sentence>
FILES: <paths it may change>
DONE WHEN: <checkable, exhaustive criterion>
VERIFY: <exact targeted command>
FINAL ACTION: git commit, then
mu task close <id> -w <ws> --evidence "$v"   # command + result
```

- **End on a criterion** both checkable and exhaustive: "every file in UNITS compiles under `npm run typecheck`", not "update the call sites".
- **Share once.** Common context goes on the umbrella; each brief says `Read:` and holds only what differs.
- **State the target, not the ban**: "edit only `src/auth/`".
- **Ask for evidence**: commands run and exit codes.
- **Refutation.** A brief naming a cause, fix, threshold or code fact needs the recorded refutation ([SKILL](../SKILL.md)); any other carries `REFUTE-EXEMPT: <why>`.
- Never tell a worker to `cd`: its cwd is its worktree.

## Quoting

An apostrophe ends `'...'`. Pass prose through `-` and a quoted heredoc, stored verbatim:

```bash
mu task note <id> -w <ws> - <<'EOF'
it's fine: $HOME stays literal
EOF
```

`task add --note -` and `agent send <a> -` read stdin too. `--why` and `--evidence` do not; capture the text first:

```bash
v=$(cat <<'EOF'
it's fine: $HOME stays literal
EOF
)
mu task close <id> -w <ws> --evidence "$v"
```
