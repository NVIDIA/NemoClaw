<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Follow Up on PR CI and Reviews

After each PR push, let required reviews settle, collect one complete snapshot, and repair all valid findings as one change set. Keep monitoring bounded; pending clean checks can remain pending in the handoff.

## Preserve repository-owned review routing

Do not request reviews from maintainers.

## Monitor and collect once

Use bounded monitoring while useful work remains. Do not repeatedly print unchanged check lists or full review bodies. Return states, identifiers, and clipped evidence; read full evidence only for an actionable item.

Before editing, collect one complete snapshot for `NVIDIA/NemoClaw` and the PR number:

1. Record the latest PR commit SHA and the local candidate commit SHA.
2. Wait for required automated reviews to settle.
3. Read every required check and paginated comment, review, and thread source. Filter to actionable unresolved threads only after collection.
4. Read the latest PR commit SHA again. Restart if it changed.
5. Re-evaluate earlier findings against the latest commit. Classify and group valid findings by cause and acceptance evidence.

Apply reviewer or bot filters only after collection is complete.

## Handle results

Follow [Documentation Writing and Review](documentation-writing-review.md) for explanatory text. Apply [Root-Cause and Sensitive-Workflow State Checks](root-cause-and-state-checks.md) to valid code or CI findings, and record the operation and failure class.

- **Valid finding or CI failure:** Add it to the relevant root-cause group and repair the complete group once.
- **Style comment or false positive:** Avoid unnecessary changes; explain only when a reviewer needs the decision.
- **Ambiguous, risky, broad, or design-changing feedback:** Ask the user before changing behavior.

## Repair and push once

1. Set the repair scope from the complete collection for the same latest PR commit.
2. Repair all scoped groups as one coherent change set, run targeted validation once, and commit after it passes.
3. Reflect on your work before pushing. If the latest PR commit changes or a finding still requires a change, restart without pushing.
4. Push and resume monitoring.

For Git or GitHub access errors, follow [Git and GitHub Access Hard Stop](git-github-hard-stop.md). Resolve mechanical conflicts in this workflow; ask only when resolution can change behavior or contributor intent.
