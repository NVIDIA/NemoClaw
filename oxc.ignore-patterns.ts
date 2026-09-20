// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Paths excluded from repository Oxlint and Oxfmt checks. */
export const oxcIgnorePatterns = [
  "**/node_modules",
  "**/dist",
  "**/coverage",
  "**/package-lock.json",
  "nemoclaw/runner-dist",
  "docs/_build",
  ".claude",
  ".pi",
];
