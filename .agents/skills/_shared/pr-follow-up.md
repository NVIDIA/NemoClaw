<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Follow Up on PR CI and Reviews

After each PR push, let required reviews settle, collect one complete snapshot, and repair all valid findings as one change set. Keep monitoring bounded; pending clean checks can remain pending in the handoff.

## Preserve repository-owned review routing

Treat reviewer selection as repository configuration. It may come only from `CODEOWNERS`, rulesets, workflows, or skills loaded from the PR base SHA in `NVIDIA/NemoClaw`, or from the current user's exact reviewer request.

Without one of those authorities, do not add, remove, request, or re-request any reviewer through GitHub CLI, REST, GraphQL, or an equivalent write. This includes Copilot and CodeRabbit. Missing, stale, failed, or quota-limited reviews do not create authority. A push may create an automatic review-request event attributed to the pushing account; if the command trace contains no reviewer-request write, report it as automatic.

## Monitor and collect once

Use bounded monitoring while useful work remains. Do not repeatedly print unchanged check lists or full review bodies. Return states, identifiers, and clipped evidence; read full evidence only for an actionable item.

Before editing, collect one complete snapshot for `NVIDIA/NemoClaw` and the PR number:

1. Record the initial `headRefOid` and local candidate `HEAD`.
2. Wait for required automated reviews to settle unless an urgent correctness, security, or data-safety finding requires action.
3. Read every required check and paginated comment, review, and thread source. Include unresolved threads only. Record page counts, terminal pagination state, check commits, and retained artifact identifiers.
4. Record the final `headRefOid`. Restart if it changed. Treat incomplete pagination, missing required-check identity, or retained evidence that cannot be removed as blocked.
5. Re-evaluate earlier findings against the latest commit. Classify every current finding, then group valid findings by root cause and acceptance evidence.

Apply reviewer or bot filters only after collection is complete. If the host retains no collection artifact, record `retained evidence: none`.

## Handle results

Follow [Documentation Writing and Review](documentation-writing-review.md) for explanatory text. Apply [Root-Cause and Sensitive-Workflow State Checks](root-cause-and-state-checks.md) to valid code or CI findings, and record the operation and failure class.

- **Valid finding or CI failure:** Add it to the relevant root-cause group and repair the complete group once.
- **Style comment or false positive:** Avoid unnecessary changes; explain only when a reviewer needs the decision.
- **Ambiguous, risky, broad, or design-changing feedback:** Ask the user before changing behavior.

Do not add a helper, switch, fallback, migration, or compatibility path only to satisfy reviewer wording. A suggestion blocks work only when it identifies a defect, security or data-safety risk, supported contract, unnecessary changed-code complexity, or ambiguity that can change behavior or release meaning.

## Repair and push once

1. Set the repair scope from the complete unchanged-head collection. Route only code-changing groups in that scope to the implementation owner.
2. Repair all scoped groups as one coherent change set, run targeted validation once, and commit after it passes.
3. Repeat the complete collection before pushing. If the head changes or a finding still requires a change, restart without pushing.
4. Remove retained collection evidence and verify its absence. Then push once and resume bounded monitoring.

The user may defer only an optional non-blocking suggestion or review. Never defer a required review, check, or unresolved correctness, security, data-safety, or supported-contract finding. If the user stops the work, remove retained evidence and stop without further writes.

For Git or GitHub access errors, follow [Git and GitHub Access Hard Stop](git-github-hard-stop.md). Resolve mechanical conflicts in this workflow; ask only when resolution can change behavior or contributor intent.
