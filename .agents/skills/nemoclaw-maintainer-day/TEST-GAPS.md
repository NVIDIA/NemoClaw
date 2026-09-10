<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Repair a Test Gap

Select an uncovered behavior from a release item, PR, CI failure, or recent change.
Identify the risk and the smallest acceptance evidence before selecting a repair.

For an existing PR, complete [PR follow-up](../_shared/pr-follow-up.md) for one unchanged latest PR commit before editing.
Then use [Salvage a Pull Request](SALVAGE-PR.md) for scope, write authority, implementation, validation, and publication.
Carry the original objective, accepted scope, deferred scope, and complete root-cause group into that workflow.

For an accepted issue without a PR, use [Implement a GitHub Issue](../nemoclaw-contributor-implement-issue/SKILL.md) for local implementation and validation.
Derive test placement and commands from current source, tests, and owning repository guidance through that workflow.
Do not invent a PR candidate or require PR follow-up for issue-only work.
Opening a PR still requires user authorization and the contributor publication workflow.

If the gap requires a scope or design decision, stop and report it.
Use [Sequence Work](SEQUENCE-WORK.md) when an accepted outcome needs division into deliverable slices.
Report the selected behavior, validation evidence, and remaining risks to the maintainer pass.
