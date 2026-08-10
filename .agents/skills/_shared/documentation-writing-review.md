<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation Writing and Review Routing

Use this routing contract in any skill that writes or reviews agent responses, progress updates,
tool-call labels or descriptions, GitHub text, comments, test titles, documentation, changelog
entries, Announcements, or maintainer guidance.

## Load the Guidance for the Surface

- Follow the [NemoClaw Writing Guide](../../../WRITING.md) for any changed explanatory text.
  It owns claim accuracy, writing rules, review scope, and terminology routing.
- Also follow the [documentation contributor guide](../../../docs/CONTRIBUTING.md) when changing
  public-facing documentation.
  It owns documentation procedures, patterns, and validation.

Follow the [Agent-Written Text](../../../WRITING.md#agent-written-text) requirements at every boundary that section defines.
Do not copy either guide's rules into a skill.

## Complete the Assigned Review

Review the complete assigned diff and PR text.
Complete every applicable review category.
Do not stop after the first blocking finding.
Report all evidence-backed findings in one review result.

If a finding identifies a behavior, security, data safety, test, or release ambiguity, inspect adjacent paths.
Include unchanged sibling paths that implement the same operation or failure class.
Group repeated findings by root cause and give representative locations.
Do not request unrelated cleanup in unchanged text.

For a sensitive operational procedure, review each applicable boundary:

- Input trust and command construction.
- Credential location, access, lifetime, transfer, and removal.
- Command and transport status propagation.
- Result classification for success, inconclusive verification, and infrastructure failure.
- Action classification for rollback, retry, and stop.
- Resource ownership, cleanup, and absence confirmation.
- Partial external writes and authorization boundaries.

Return blockers and suggestions only after completing the full assigned review. A blocker does not end the review pass.
