// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

module.exports = {
  extends: ["@commitlint/config-conventional"],
  // Skip GitHub auto-generated commits (web-UI suggestion accepts, merge commits)
  ignores: [(message) => /^Apply suggestion/.test(message)],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "chore",
        "refactor",
        "test",
        "ci",
        "perf",
        "merge",
      ],
    ],
  },
};
