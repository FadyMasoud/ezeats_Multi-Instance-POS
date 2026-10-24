---
description: Review the current diff against the POS-sync correctness rules (runs the sync-reviewer subagent)
---

Use the `sync-reviewer` subagent to review the current working-tree diff (`git diff HEAD` plus
untracked files). $ARGUMENTS

When it returns:
1. Show its findings to the user exactly as reported (do not soften BLOCKERs).
2. For each BLOCKER or SHOULD FIX, propose the smallest fix, and apply it only if the user agrees.
3. If you apply fixes, run `npm run check` and the affected integration tests before saying done.
