<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Discover the Current Implementation

Use the current checkout as the source of truth. A skill defines process and priorities. It must
not maintain an inventory of paths, identifiers, commands, registrations, versions, schemas, or
test mappings that the checkout already defines.

Apply the shared [Code Change Considerations](code-change-considerations.md) at the current
lifecycle stage.

## Before implementation

- Read the active `AGENTS.md` files for every area the task can change.
- Apply the product scope gate before adding a supported surface.
- Identify affected trust boundaries. Apply the [Security Rubric](security-rubric.md) to the plan:
  name applicable risks, intended controls, and the positive and negative evidence the change needs.
- During implementation and self-review, record the controls changed and negative evidence for each
  changed control that proves forbidden behavior remains denied.
- Verify behavior claims in current source and tests. Use history, issues, PRs, and documentation
  for rationale, not as behavior authority.

## Keep guidance current

- Derive implementation surfaces, validation, and tool interfaces from the checkout when the task
  runs. Do not copy their current details into a skill.
- Record discovered specifics in task or PR evidence, not in reusable guidance.

When a tool contributes security or provenance evidence, run the version from the trusted base
revision. Do not treat a helper modified by the proposed change as independent evidence for that
same change.
