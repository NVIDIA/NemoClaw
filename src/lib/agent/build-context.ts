// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "path";

import { ROOT } from "../runner";

// Keep these generated workspace exclusions aligned with .dockerignore and .gitignore.
const AGENT_BUILD_CONTEXT_EXCLUDED_BASENAMES = new Set([
  ".claude",
  ".e2e",
  ".git",
  ".idea",
  ".mypy_cache",
  ".nemoclaw-maintainer",
  ".pytest_cache",
  ".ruff_cache",
  ".tmp",
  ".venv",
  ".vscode",
  "__pycache__",
  "coverage",
  "dist",
  "e2e-artifacts",
  "node_modules",
  "worktrees",
]);

export function shouldCopyAgentBuildContextPath(src: string): boolean {
  const relativePath = path.relative(ROOT, src);
  if (relativePath === "") return true;
  if (
    relativePath === "docs/_build" ||
    relativePath.startsWith(`docs${path.sep}_build${path.sep}`)
  ) {
    return false;
  }
  return !AGENT_BUILD_CONTEXT_EXCLUDED_BASENAMES.has(path.basename(src));
}
