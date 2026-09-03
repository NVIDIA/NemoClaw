<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Follow Up on PR CI and Reviews

After each push, wait for automated reviews, collect feedback for the latest PR commit, repair valid findings together, validate once, and push once. Do not request reviews from maintainers.

## Collect

1. Record the latest PR commit SHA and the local candidate commit SHA.
2. Wait for required automated reviews to settle. If the bounded wait expires, report each pending review or check and stop until it settles or the user decides otherwise.
3. Collect every required check, Advisor result, and paginated comment, review, and thread source. Apply reviewer or bot filters only after collection, then keep actionable unresolved threads.
4. Read the latest PR commit SHA again. Restart if it changed.
5. Re-evaluate earlier findings and group valid findings by cause and acceptance evidence.

Keep monitoring bounded. Return states, identifiers, and short excerpts; read full evidence only when needed.

## Decide

| Result | Action |
|---|---|
| Valid finding or failed check | Group by cause and repair the complete group. |
| Style suggestion or false positive | Leave unchanged unless an explanation is needed. |
| Ambiguous, risky, broad, or design-changing feedback | Ask the user. |
| Required review or check is still pending | Report it. Do not classify the collection as complete. |
| No actionable finding after collection completes | Report the remaining checks. |

Apply [Root-Cause and Sensitive-Workflow State Checks](root-cause-and-state-checks.md) to valid code or CI findings, and record the operation and failure class.

## Repair and publish

1. Set the repair scope from the complete collection for the same latest PR commit.
2. Repair all accepted groups and run targeted validation once. Continue only after it passes.
3. Follow [Documentation Writing and Review](documentation-writing-review.md) for explanatory text, then reflect on the change.
4. Confirm that the latest PR commit has not changed and no finding still requires a change.
5. Commit, push once, and resume this cycle.

For Git or GitHub access errors, follow [Git and GitHub Access Hard Stop](git-github-hard-stop.md). Resolve mechanical conflicts here; ask only when resolution can change the required outcome.
