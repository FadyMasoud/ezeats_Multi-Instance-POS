# AI_NOTES

Claude Code wrote most of this code. These are real moments from the build, taken from the session
log, where Claude was wrong or was stopped, and how it was noticed.

## 1. Claude wrote the duplicate-order bug it was supposed to prevent

**What happened.** The POS client classified every 4xx except 429 as "definitely not created",
which clears `create_sent_at`.

**How it was noticed.** Running `/review-sync`, the `sync-reviewer` subagent, over the whole diff
reported it as a BLOCKER, with a concrete scenario. A gateway answers 408 after the POS has
already created the order. An operator retry, or a cancel, then trusts that nothing exists. The
retry creates a second order; the cancel leaves the first one open.

**Why the tests missed it.** The unit tests injected `definitelyNotApplied` directly, so they
could not see the bug.

**Fix.** Only 422, 429 and 500 count as "nothing created". A new table-driven test was shown to
fail on the old code. The same review also found that the settle window was measured from the
wrong point in time, and that the chaos test tolerated duplicate creates as long as they were
later cancelled.

## 2. A guard that always said "OK"

**What happened.** Claude added a migration-drift check, because `drizzle-kit check` does not
notice a forgotten migration. Its first version passed even with an unmigrated table in
`schema.ts`. drizzle-kit prefixed `./` to the absolute Windows temp path, failed, and still
exited 0.

**How it was noticed.** Claude added a fake table on purpose to see the check fail. It didn't.

**The same pattern in the hooks.** Testing the hooks the same way turned up three more silent
problems:
- The guards treated unreadable hook input as "allow".
- The edit checker broke on a repo path containing a space, so it reported failures on clean
  files.
- The Stop hook could not find `npm` on Windows, so it would have blocked every stop.

**What changed.**
- New rule in `CLAUDE.md`: *a guard is not done until you have seen it fail on bad input.*
- `tests/hooks` now runs every guard against blocked and allowed inputs. On its first run it caught
  that `git commit -nm` slipped past the "don't skip the pre-commit hook" rule.

## 3. Wrong assumptions about tests and load

- **Integration tests ran in parallel.** Claude set Vitest's `fileParallelism: false` on the
  integration project, assuming it would run test files one after another. In a workspace project
  it doesn't. The two files truncated the same database under each other: 404s and Postgres
  deadlocks. It was noticed from the interleaved test output and fixed by running integration
  tests in a single fork.
- **`pay` was slow under load.** The first design shared one connection pool between request
  handlers and the worker. Only the chaos run's latency measurement exposed it: p95 738 ms. It was
  fixed with a separate worker pool and a single-statement `pay`. The tail is still above 300 ms
  under that load; this is stated in `DECISIONS.md`, not hidden.

## The rule added because something went wrong

**What happened.** The local Postgres password wasn't known. Claude tried to *guess* it by
looping `psql` over common passwords. The Claude Code permission classifier blocked it, and the
user was asked instead.

**What was added because of it.**
- `.claude/hooks/guard-commands.mjs` blocks any command that sets `PGPASSWORD` or contains a
  literal `postgres://user:password@` URL.
- `settings.json` denies reading `.env`.
- `CLAUDE.md` says: credentials come from `.env`; never guess them; ask.

**Side effect.** The guard matches command *text*. Twice, a command that only *mentioned* a
blocked pattern was blocked: a note being appended, and a commit message. Commit messages now go
through `git commit -F`. This trade-off was kept on purpose: a false block is cheap, a missed one
is not.
