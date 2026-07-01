// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../src/lib/core/shell-quote";

export type BrevVitestProject = "cli" | "e2e-live";

export function buildBrevRemoteVitestCommand(project: BrevVitestProject, target: string): string {
  const vitestCommand = [
    "./node_modules/.bin/vitest",
    "run",
    "--project",
    project,
    target,
    "--silent=false",
    "--reporter=default",
  ]
    .map(shellQuote)
    .join(" ");

  return [
    // A nested live installer test may run npm link and prune the repository's
    // dev dependencies. Restore the reviewed lockfile graph before the next
    // remote suite, with lifecycle scripts disabled, instead of letting npx
    // download an unpinned replacement.
    "if [ ! -x ./node_modules/.bin/vitest ]; then npm ci --ignore-scripts --no-audit --no-fund; fi",
    "test -x ./node_modules/.bin/vitest",
    `NEMOCLAW_RUN_LIVE_E2E=1 ${vitestCommand}`,
  ].join(" && ");
}
