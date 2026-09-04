<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisor shared utilities

Shared implementation helpers for NemoClaw model-backed advisors.

`tools/pr-review-advisor/` owns the PR Review Advisor specialist entrypoint. This directory provides:

- repository-confined, read-only Pi SDK session tools;
- deterministic turn-scoped context tools and turn validation;
- Git diff and metadata helpers;
- JSON extraction and sanitization helpers;
- artifact and file I/O helpers;
- GitHub API and sticky-comment helpers;
- the trusted E2E inventory supplied to PR Review Advisor specialists.

The PR E2E controller independently rebuilds the deterministic plan and remains the only
merge-authoritative E2E gate. Its trusted inventory reader uses only Node.js built-ins and checked-in
TypeScript modules, so the production advisor does not need repository development dependencies such
as TypeScript or Vitest.

GitHub workflows must execute the advisor entrypoint from the trusted `ADVISOR_DIR` checkout. PR
workspaces remain inert analysis data only.
