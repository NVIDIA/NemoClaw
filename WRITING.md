<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Writing Guide

Write the shortest text that lets the reader act correctly.
Apply this guide to explanatory prose, including documentation, agent messages, commit bodies, review comments, and user-visible text.
Preserve literal code, commands, identifiers, output, product names, and quotations.

## Be Clear

- Lead with the result or the reader's next action.
- Use familiar words, active verbs, and consistent terms.
- Name the actor, action, and object; put conditions before dependent instructions.
- Keep sentences focused and remove repetition, filler, and unsupported judgments.
- Include technical detail when it changes a decision or explains a constraint.
- Use lists for steps or parallel facts, and tables for comparisons.
- Use `must` for requirements, `may` for permission, `can` for capability, and `should` for recommendations.
- Explain reasons and invariants in code comments; name observable behavior and its conditions in test titles.

## Be Precise

Verify commands and behavior against source, tests, or executable help.
Name the resource, host, revision, and environment when the distinction matters.
Explain what changes, what persists, and what happens on failure.
For credential-handling procedures, explain storage, access, lifetime, and removal without exposing secret values.

Distinguish an observed result from an inference or untested claim.
A reachable endpoint does not establish successful inference; one successful request does not establish general compatibility.
Passing tests do not establish product support or authorize actions on a user's resources.
The [design decision](docs/design/scope.md) defines the accepted scope.

## Review the Assigned Change

Review changed text unless the task requests a broader audit; preserve accurate historical evidence and upstream notices.
Complete the assigned review and inspect adjacent material when needed to understand a consequential ambiguity.
For each finding, cite the text, explain its effect, and suggest a concrete correction.
Group repeated findings and separate writing preferences from errors affecting behavior, security, data safety, tests, or release claims.
Only those consequential errors should block on writing grounds.
An audit alone does not authorize unrelated edits.

[Contribute documentation](docs/CONTRIBUTING.md) covers page ownership, procedures, and validation.
