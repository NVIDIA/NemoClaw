<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisor shared utilities

Shared implementation helpers for the unified NemoClaw PR Review Advisor.

`tools/pr-review-advisor/` owns the only model-backed PR advisor entrypoint.
This directory owns reusable trusted infrastructure, including:

- repo-confined read-only Pi SDK session execution. The shared `read`, `grep`, `find`, and `ls` overrides mirror Pi's `@`, `~`, and Unicode-space normalization before lexical and realpath checks, reject unstable or outside paths, and delegate only canonical in-workspace paths;
- deterministic turn-scoped context tools supplied through the `AdvisorContextToolResult` and `contextToolResults` contract after each user prompt, plus reusable validation for visible analysis turns and atomic commit turns that expose only their mutation tool and allow one bounded tool-only retry;
- Git diff and metadata helpers;
- JSON extraction and sanitization helpers;
- artifact path and file I/O helpers;
- GitHub API and sticky-comment helpers;
- the session-free E2E recommendation normalizer, which restores the
  deterministic risk-plan floor, rejects unsupported target and job IDs, and
  emits selector-only guidance for the PR advisor.

The E2E normalizer does not open an agent session or dispatch tests. The PR E2E
controller independently rebuilds the deterministic plan and remains the only
merge-authoritative E2E gate. Its trusted inventory reader uses only Node.js
built-ins and checked-in TypeScript modules, so the production advisor does not
need repository development dependencies such as TypeScript or Vitest.

GitHub workflows must execute the advisor entrypoint from the trusted
`ADVISOR_DIR` checkout. PR workspaces remain inert analysis data only.
