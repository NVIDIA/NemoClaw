<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Follow Up on PR CI and Reviews

Treat each latest PR commit as one candidate. Finish its automated evaluation before you replace it.
Collect complete feedback, repair valid findings together, validate once, and push once. Do not request
reviews from maintainers.

## Stabilize the candidate

1. Record the latest PR commit SHA, base SHA, and local candidate SHA.
2. Wait for required CI and each scheduled CodeRabbit review to reach a terminal state for that commit.
3. Wait for every scheduled Advisor specialist and the complete Advisor writeup for that commit.
4. Do not push or integrate the base branch while this evidence is pending.
5. Rerun unchanged work only when evidence matches a checked-in transient retry policy.
6. Read the latest PR commit SHA again. Restart if it changed.

A partial Advisor result or one CodeRabbit finding does not complete collection. If a bounded wait
expires, report the pending evidence and resume monitoring later. Do not replace the candidate to
create another review event.

## Collect

1. Collect every required check, Advisor result, and paginated comment, review, and thread source.
2. Apply reviewer or bot filters only after collection.
3. Deduplicate findings that report the same cause through different bots or checks.
4. Classify each finding as candidate-owned or inherited, in-scope or new scope, and blocking or advisory.
5. Reproduce a suspected inherited finding on the recorded base when the evidence is not conclusive.
6. Read the latest PR commit SHA again. Restart if it changed.
7. Group valid candidate-owned findings by cause and acceptance evidence.

Keep monitoring bounded. Return states, identifiers, and short excerpts; read full evidence only when needed.

## Decide

| Result | Action |
|---|---|
| Valid finding or failed check | Group by cause and repair the complete group. |
| Duplicate, inherited finding, style suggestion, or false positive | Leave unchanged and preserve the evidence for its disposition. |
| New scope or ambiguous, risky, broad, or design-changing feedback | Ask the user. Do not add the new surface as a repair. |
| Required review or check is still pending | Report it. Do not classify the collection as complete. |
| No actionable finding after collection completes | Report the remaining checks. |

Apply [Root-Cause and Sensitive-Workflow State Checks](root-cause-and-state-checks.md) to valid code or CI findings, and record the operation and failure class.

## Integrate the base branch

Fetching the canonical base into a local comparison ref does not change the candidate. Continue to
fetch it when trusted validation requires current base evidence.

Merge or rebase the base branch into the candidate only for one of these reasons:

- resolve a current merge conflict;
- consume a required dependency that has merged;
- satisfy the final merge gate after every other candidate-owned finding has settled.

Do not integrate the base branch only because it moved during candidate evaluation. Integrate it at
most once in one evaluation cycle. A base integration creates a new candidate, invalidates approval
evidence for the prior commit, and restarts this workflow.

## Repair and publish

1. Set the repair scope from the complete collection for the same latest PR commit.
2. Route new scope to a follow-up or user decision. Do not silently expand the PR.
3. Repair all accepted groups and run targeted validation once. Continue only after it passes.
4. Follow [Documentation Writing and Review](documentation-writing-review.md) for explanatory text, then reflect on the change.
5. Confirm that the latest PR commit still matches the SHA recorded before the repair.
6. Stop if another workflow published a revision. Do not publish a competing revision.
7. Confirm that no finding still requires a change. Commit, push once, and resume this cycle.

For Git or GitHub access errors, follow [Git and GitHub Access Hard Stop](git-github-hard-stop.md). Resolve mechanical conflicts here; ask only when resolution can change the required outcome.
