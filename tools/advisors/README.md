<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisor shared utilities

Shared implementation helpers for NemoClaw advisor workflows.

The advisor entrypoints stay domain-specific under `tools/e2e-advisor/` and
`tools/pr-review-advisor/`, while this directory owns common infrastructure:

- read-only Pi SDK session execution, including deterministic synthetic tool-result preloading for known advisor context;
- Git diff and metadata helpers;
- JSON extraction and sanitization helpers;
- artifact path and file I/O helpers;
- GitHub API and sticky-comment helpers.

GitHub workflows must continue to execute advisor entrypoints from the trusted
`ADVISOR_DIR` checkout. PR workspaces remain inert analysis data only.
