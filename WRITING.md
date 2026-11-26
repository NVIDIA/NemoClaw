<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Writing Guide

Write the shortest text that lets the reader act correctly.
Apply this guide to explanatory prose, including documentation, agent messages, commit bodies, review comments, and user-visible text.
Load the [NVIDIA style guidelines](.agents/skills/nvidia-style-guide/SKILL.md) for voice, tone, and house style; this guide adds the rules specific to this repository.
Preserve literal code, commands, identifiers, output, product names, and quotations.

## Be Clear

- Lead with the result or the reader's next action.
- Put conditions before dependent instructions.
- Remove unsupported judgments.
- Keep a modifier only when it distinguishes something relevant to the passage; if every Y in context is X, write Y.
- Give each qualifier one meaning and name the distinction directly instead of writing ordinary, real, or deterministic; never imply a mode, option, or command that does not exist.
- Include technical detail when it changes a decision or explains a constraint.
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
The [design decision](internal-docs/design/scope.md) defines the accepted scope.

## Write and Review for the Target Release

Write versioned product documentation for readers using the target release after publication.
Use the final tag, download URLs, and versioned examples that readers will use.
During review, treat planned release assets that are still unpublished as expected in a preview.
Flag links, assets, and instructions that would fail for readers of the released version.
Track publication and artifact verification in the [release process](internal-docs/contributing/releases.md).

## Review the Assigned Change

Review changed text unless the task requests a broader audit; preserve accurate historical records and upstream notices.
Complete the assigned review and inspect adjacent material when needed to understand a consequential ambiguity.
For each finding, cite the text, explain its effect, and suggest a concrete correction.
Group repeated findings and separate writing preferences from errors affecting behavior, security, data safety, tests, or release claims.
Only those consequential errors should block on writing grounds.
An audit alone does not authorize unrelated edits.

[Contribute documentation](internal-docs/contributing/documentation.md) covers page ownership, procedures, and validation.
