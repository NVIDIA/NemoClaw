<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisor shared utilities

Shared implementation helpers for NemoClaw advisor workflows.

The advisor entrypoints stay domain-specific under `tools/e2e-advisor/` and
`tools/pr-review-advisor/`, while this directory owns common infrastructure:

- repo-confined read-only Pi SDK session execution. The shared `read`, `grep`, `find`, and `ls` overrides mirror Pi's `@`, `~`, and Unicode-space normalization before lexical and realpath checks, reject unstable or outside paths, and delegate only canonical in-workspace paths;
- deterministic turn-scoped context tools supplied through the `AdvisorContextToolResult` and `contextToolResults` contract after each user prompt, plus reusable validation for visible analysis turns and atomic commit turns that expose only their mutation tool and allow one bounded tool-only retry;
- Git diff and metadata helpers;
- JSON extraction and sanitization helpers;
- artifact path and file I/O helpers;
- GitHub API and sticky-comment helpers.

GitHub workflows must continue to execute advisor entrypoints from the trusted
`ADVISOR_DIR` checkout. PR workspaces remain inert analysis data only.
