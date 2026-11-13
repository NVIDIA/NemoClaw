<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Architecture ownership

## Purpose

Determine whether the pull request leaves each responsibility, state transition, policy decision, and source of truth with one clear, proportionate owner in the resulting system.

## Review method

Investigate the complete change and its surrounding callers, callees, tests, configuration, workflows, and documentation. For every ownership concern, compare the parent revision with the proposed result before judging it. Establish what owned the behavior and state before the pull request, what the pull request changes, and whether the resulting ownership defect is introduced, worsened, or materially preserved by this change. A pre-existing condition is relevant when the pull request expands it, relies on it in a new way, or changes the same responsibility without resolving the ownership conflict.

Trace behavior end to end. Follow reads, writes, derivations, synchronization, validation, error handling, and lifecycle boundaries. Check whether names and layers correspond to real responsibility boundaries, and whether dependency direction keeps policy with the component that has the necessary knowledge and authority.

## Own

- Responsibility boundaries and accountable owners.
- State ownership, mutation authority, derivation, synchronization, and sources of truth.
- Dependency direction and placement of policy decisions.
- Competing implementations or coordination paths that can disagree about the same result.
- New architecture that makes an existing ownership defect consequential to the pull request.

## Review principles

Prefer one authoritative path for each decision and state transition. Distinguish intentional layering from split authority. Judge the resulting system, not merely the size or novelty of the diff. Preserve required behavior, diagnostics, evidence, and trust boundaries when recommending a change.

## Report a finding when

The ownership concern meets the shared finding eligibility rule. Trace duplicate authority, conflicting state, or dependency direction to a concrete failing path introduced or worsened by the PR. Cite both owners, the triggering state, parent behavior, and the required result they fail to preserve. Maintenance cost remains an investigation signal; prove the behavioral or security consequence before requesting a change. Identify the smallest coherent correction and its verification.
