<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Continuity Handoff

Use this handoff only when responsibility moves to another active agent or the operator cancels the loop. Unless the operator cancels the loop, assign monitoring to a named agent. Capture a read-only snapshot and report:

```markdown
## Transfer
- Time: <absolute timestamp and timezone>
- Outgoing agent: <account or agent>
- Receiving agent: <account or agent, or operator-cancelled>
- Ownership acknowledgement: <message or coordination link>
- Monitoring state: active | operator-cancelled
- Next scan: <trigger, scheduled check, or none when operator-cancelled>
- Observed origin/main commit: <full commit SHA>
- Newest relevant E2E: <run URL, attempt, status, conclusion>
- Overall state: passing | failing | pending | inconclusive

## Verified fixes
| Root cause | PR | Merge commit | Automatic E2E evidence after merge |

## Merged, awaiting verification
| Root cause | PR | Merge commit | Expected next evidence |

## Post-merge containment
| Failed merge | Failure evidence | Containment owner | Rollback PR authorization | Related merge writes | Authorized revert/corrective PR | Resume condition | Next actor |

## Open fixes
| Root cause | PR/latest PR commit | Owner | Branch/worktree | Local commit SHA | Last pushed commit SHA | Local state/changed paths | State | CI | Approval/reviewer | Next actor/action |

## Remaining failures
| Root cause | Run/jobs | Ownership | Blocker or next action |

## Obsolete or superseded work
| PR | Superseding PR/commit | Verification |

## Operational blockers
- <workflow approval, branch conflict, permissions, runner availability, or none>

## Restrictions
- Manual duplicate E2E runs: none
- Coverage weakened or skipped: none
- Unrelated merges blocked: none
- Release, tag, or release artifact state touched: no
```

Count a root cause as **verified fixed** only when a later automatic `main` run meets all these conditions:

- The tested commit descends from the merge commit.
- The run reaches the original failure phase for every affected target.
- The affected jobs pass without the original causal signature.

If a target is absent, replaced, skipped, or still running, keep the PR under **Merged, awaiting verification**.

Do not count these as fixes:

- a manual rerun that happens to pass;
- a cancelled, skipped, neutral, queued, or in-progress job;
- a PR that only adds qualification or diagnostics without correcting the cause;
- a CI-only cleanup unrelated to the product E2E cause;
- an obsolete PR closed after another merge.

Before handoff, record each active worktree's absolute path, branch, local commit SHA, last pushed commit SHA, and `git status --short` changed paths. Do not reset, stash, delete, or otherwise discard source edits. Name the owner and next actor for every local or remote item. Put a failed evidence-cleanup path only in this private continuity handoff, never on GitHub.

Use only URLs present in GitHub evidence or the shared queue. Never construct or guess a URL. If a URL is unavailable, report its stable identifier followed by `URL unavailable`. State `inconclusive` instead of passing when the newest evidence for the observed `origin/main` commit has not completed.

For a transfer, the outgoing agent continues monitoring until the receiving agent acknowledges ownership. A passing snapshot does not complete the loop. If no receiving agent accepts ownership, keep the loop active unless the operator explicitly cancels it.
