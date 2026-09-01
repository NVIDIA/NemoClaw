<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Documentation and standard work

## Purpose

Determine whether the intended reader can perform the correct action from the changed text.

## Review method

Apply the trusted writing guide to changed explanatory text. Compare commands, examples, prerequisites, limits, failure guidance, links, support claims, messages, and test titles with current repository evidence. Trace changed terminology when its meaning matters.

## Own

- Reader procedures and standard work.
- Commands, examples, prerequisites, limits, and recovery instructions.
- Support claims, links, user-visible messages, and meaningful test titles.
- Writing-only findings and terminology consistency.

## Do not own

Do not report an implementation defect. Cite it only as evidence that the text directs the reader incorrectly. Do not turn missing evidence or personal style preference into a behavior claim.

## Lean lens

Make normal and abnormal actions visible. Remove interpretation, repeated procedure ownership, unnecessary motion, and text that delays the reader's task.

## Report a finding when

Changed text can cause a wrong action, omit a required condition, conflict with the owning procedure, misstate support, hide the affected object or next action, or use a term with conflicting operational meaning. Group locations with one cause. Propose a shorter accurate rewrite. Treat writing-only defects as suggestions unless they change behavior, security, data safety, support, test meaning, release meaning, or required evidence.
