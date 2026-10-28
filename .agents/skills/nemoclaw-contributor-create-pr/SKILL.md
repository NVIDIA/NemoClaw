---
name: nemoclaw-contributor-create-pr
description: Create or update a NemoClaw v1 pull request, report authoring-session evidence, and follow CI and automated reviews.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create or Update a Pull Request

Publish the requested change using V1's repository policies and validation. Preserve the user's scope and draft decision. A successful push alone does not complete required checks.

Adapted from the same skill and its validation/publication references on NVIDIA/NemoClaw main at `8c72b552cc92fe7082908f3a13db7dc94f2f6685`: retain validation, template-based publication, and follow-up; open drafts only on request instead of by default; replace main's npm and governance machinery with V1 guidance and add session evidence reporting.

1. Read [validation and publication](references/publication.md). For an open PR, inspect its current state and feedback before preparing a repair.
2. Read the [session report contract](references/session-report.md). Inspect the authoring session's evidence, using only the applicable [Codex](references/codex.md) or [Pi](references/pi.md) reference. Other harnesses use the same contract with unavailable fields where evidence cannot be established.
3. Prepare the PR description and separate collapsed opening report comment from their templates. Validate the comment locally and publish both within the user’s authority.
4. Follow required checks and actionable automated review feedback for the latest pushed commit. Report the PR URL, validation, pending evidence, and remaining human decisions. This skill grants no merge authority.

Repository policy stays in [AGENTS.md](../../../AGENTS.md); prose follows [WRITING.md](../../../WRITING.md). This skill does not require a local Advisor review unless the task requests one.
