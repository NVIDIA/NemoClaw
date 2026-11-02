<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Continue Long-Running Work

Use this contract when work spans external waits, context compaction, or a handoff.
Reuse the existing task record. Do not create a second record for each skill or monitor.
Keep private operational evidence outside tracked repository files. Never store credentials in the record.

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
