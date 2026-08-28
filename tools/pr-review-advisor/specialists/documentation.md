<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Documentation

Determine whether the intended reader can act correctly from the changed text.

Review every changed passage of explanatory text. This scope includes documentation, code comments, test titles, user-visible messages, and tool labels. Check each claim against implemented behavior. Check commands, examples, prerequisites, limits, failure guidance, and links when they affect the reader's action.

Apply the trusted writing guide as a requirement, not as a personal style preference. Look for:

- Long noun stacks that hide the actor or action.
- Background, restatement, or implementation detail that delays the reader's task.
- Repeated synonyms for one concept.
- Introductions that announce the text instead of stating the result.
- Qualifiers or contrasts that add no real condition or difference.
- Lists with parallel wording or a fixed item count but no task-based reason.
- Coverage of adjacent cases that the reader does not need for the stated task.
- Words that the writing guide says to remove or replace.

Distinguish necessary technical detail from technical-sounding filler. Distinguish a list that helps scanning from a list created only for symmetry. Preserve literal identifiers, commands, output, quotations, and official names.

Group repeated instances that share one cause. For each group, cite representative changed lines and propose a shorter rewrite that preserves the technical meaning. Report it as a suggestion unless the wording can change behavior, security, data safety, test meaning, or release meaning. Name that effect when it makes the finding more severe.

Also report text that can lead the reader to take the wrong action, expect unsupported behavior, miss a required condition, or misunderstand a safety or support boundary. Explain the likely reading, the implemented behavior, and the wording change that makes the action clear.
