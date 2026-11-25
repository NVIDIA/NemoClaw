<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Continue Long-Running Work

Use this contract when work spans external waits, context compaction, or a handoff.
Reuse the existing task record. Do not create a second record for each skill or monitor.
Keep private operational evidence outside tracked repository files. Never store credentials in the record.

## Establish the record

The invoking lifecycle workflow owns creation, discovery, handoff, and final cleanup of the record.
Before the first external wait or write, reuse the task's supplied record reference. If none exists,
create a task directory with mode `0700` under `${XDG_STATE_HOME:-$HOME/.local/state}/nemoclaw/tasks/<task-id>/`
and initialize `state.json` there using the helper below. Use the harness task ID when available or
create a unique ID once. Resolve and retain the absolute path; do not recompute it after handoff.

Save that absolute path in durable task metadata or the invoking workflow's saved handoff before
proceeding. Pass the same path and current revision to every delegated skill and watcher.
A successor reads this reference first. If the reference is missing, inspect the invoking workflow's
saved handoff and private task directory; do not create a replacement while external state is uncertain.
Reconcile any active runs or writes before reconstructing missing state, and mark unavailable evidence unknown.
A service-owned journal remains authoritative and supplies its own stable reference and initialization procedure.

After completion, the lifecycle owner records the final outcome and resolves pending operations and
cleanup obligations. Retain the record through the final handoff; remove it only under the task's
existing retention policy; retain it when none is defined. Never delete it merely because a chat compacted or a watcher ended.

## Save the next transition

Retain the information needed to continue without replaying the conversation:

- Requested outcome, accepted scope, deferred work, target identities, and authorization with any limits or revocation.
- Repository, branch, candidate, base, trusted workflow, and artifact identities as separate values.
- Completed decisions and evidence locations, including the inputs that make each result applicable.
- Active operations, run IDs and attempts, watcher identity, and the actor responsible for the next write.
- Retry usage by candidate, workflow, and failure class; record comparison trials separately.
- Local unpublished changes, pending external writes, observed publication results, and cleanup uncertainty.
- Next action, its prerequisites, and any blocker with the action or evidence needed to remove it.

Update the record before an external write and reconcile the result afterward.
After an interrupted write, inspect its external result before repeating it.
Missing acknowledgement does not establish that the write failed.
Keep successful preparation and validation evidence when the publication procedure permits reuse.

Derive handoff and monitor instructions from this record. Point them to its location and revision.
Do not maintain separate copies of retry counts, targets, or next actions in recurring prompts.
Transfer responsibility for writes explicitly when another worker takes over.

## Resume from evidence

Read the task record and the applicable current workflow instructions first.
Recheck mutable state: branch ownership, PR commit, active runs, permissions, and cleanup obligations relevant to the next action.
Resolve conflicting observations before writing. Preserve unknown state as unknown.
The record summarizes authorization; it cannot grant authority missing from the user's request or override a later restriction.

Reuse immutable evidence only when its identities, inputs, and required validation environment still match.
Invalidate affected results when those inputs change. Preserve unaffected source analysis with its evidence links.
An old runtime pass remains historical unless the owning qualification contract explicitly permits reuse.
Do not restart completed collection or source audits solely because the conversation was compacted.

## Wait once

Reuse one watcher for each external operation. Before starting another, check the recorded watcher and live run state.
Use bounded observation with backoff or event-driven notification when available.
Report changed results, actionable failures, or required user action. Avoid repeated unchanged status messages.
Continue independent authorized work while an external prerequisite is pending.
End the watcher when the operation completes, is cancelled, or only an external blocker remains.

Report implementation, publication, CI, qualification, review, and merge as separate outcomes.
State the next unmet requirement instead of treating a successful intermediate step as task completion.

## Validate a local checkpoint

Use `node tools/task-continuation/checkpoint.mts` when this workflow owns the private task record.
An existing service-owned journal remains authoritative; do not create a parallel checkpoint for it.
The helper performs no GitHub writes, dispatches, or authorization checks.
It validates local state and generates the continuation view from that same state.

Keep the record in a private directory outside tracked files. Initialize revision `0` with expected revision `-1`:

```sh
node tools/task-continuation/checkpoint.mts save /private/task/state.json -1 upgrade-owner < /private/task/proposed.json
node tools/task-continuation/checkpoint.mts resume /private/task/state.json
```

The input is a version `1` JSON object with these fields:

- `revision`: increment by one for each save; supply the previous revision on the command line.
- `objective`, `scope`, `authorization`, `owner`, `nextAction`: nonempty descriptions from the accepted task.
- `identities`: named source, candidate, base, PR, artifact, active-run, and watcher identities relevant to the next action.
- `evidence`: `{ "path": "/absolute/evidence/file", "sha256": "<64 lowercase hex characters>" }` entries.
- `limits`: operation-budget keys and their authorized integer limits.
- `budgetIdentities`: one `{ candidate, workflow, failureClass }` object per budget key.
  Use the tested candidate identity, stable workflow identity, and diagnosed failure class. Do not use
  a run ID or retry label as the workflow identity. Use `initial` for
  an operation that does not respond to a failure. Distinguish a base-comparison workflow from its
  candidate workflow and identify each external-write workflow by its operation, such as Git
  publication or PR-description update. These are structured values, not labels
  derived from the budget key. The helper rejects duplicate tuples and changes to existing tuples.
- `operations`: initially empty; append `{ "id", "action", "budget", "state": "pending", "observation": "" }` before each external write.

Follow the [bounded retry policy](pr-follow-up.md#bounded-retry-policy): one automatic transient retry
within existing authorization requires no routine confirmation. A retry limit of `1` means one retry
after the initial attempt; record the initial attempt under its own budget key.
Use candidate/workflow/failure-class keys for retries and different keys for baseline comparisons.
Keep those keys and spent counts across compaction and handoff. Repair deterministic defects before rerunning;
do not spend a transient retry on unchanged broken code or reset its allowance by renaming the key.
A new budget key requires additional authorization evidence appended to `authorization` on a new line.
Preserve the prior authorization text on every save.
Cite the existing task authority or a later user decision that covers the distinct allowance.

Manual dispatch grants in
`identities["manualE2E.authorization." + budgetKey]` are append-only. Adding a grant requires appended
authorization evidence; changing or deleting a saved grant is rejected. Legacy phase-keyed grants
receive the same protection. New candidate grants use distinct budget keys in the same task record.

A new key must not rename a spent allowance. A new candidate, workflow, or failure class may need a distinct authorized key;
record why its allowance is separate. This does not require renewed user approval when existing task authority covers that work.
Assign the new key its structured identity. A renamed key with the same identity is rejected even
when authorization text is appended. The lifecycle owner must verify those identities against the
actual task; the helper cannot authenticate a claimed candidate, workflow, or failure class.
The helper requires this explicit record transition; it does not authenticate the evidence or authorize the action.
Persist one new intent per save before executing it. A pending intent already consumes its budget, including after interruption.
After reading external state, change the entry to `observed` and record the evidence location in `observation`.
An observed failure is not a successful result; the owning publication or execution contract decides what follows.
The helper rejects lost history, budget resets, stale revisions, and new writes while an earlier write remains unresolved.

Older version `1` records without `budgetIdentities` remain readable. Before their next save, inspect
the existing allowances and bind every key to its identity without changing limits or operation history.
Append authorization evidence that records this migration. The helper rejects saving an unbound legacy
record or silently assigning its identities. Retain the same record and revision sequence.

For handoff, save with the outgoing owner and a new `owner` value.
Include fresh `handoff` evidence identifying the receiving owner's acknowledgement.
The old owner then fails subsequent saves. These names prevent accidental stale writes; they do not authenticate actors.

Use `resume` output directly for continuation and monitor instructions.
Reconcile pending operations first, refresh changed or missing evidence, then check mutable external state.
File hashes establish byte equality only; recheck runtime assumptions and identities before reusing a result.
Resume marks non-regular evidence paths, including final symlinks, stale without reading their contents.
A leftover `.lock` means a writer might still own the record.
Confirm that it stopped and inspect the saved revision before removing that lock; never remove it on a timer.
A successful save uses a private temporary file, file and directory synchronization, and atomic replacement on a local POSIX filesystem.
Do not use a network filesystem or treat the journal as an exactly-once remote execution guarantee.
