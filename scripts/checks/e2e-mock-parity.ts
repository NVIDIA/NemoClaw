// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Compatibility shim: the trusted, base-pinned CI action
// (.github/actions/ci-cli-coverage-shard) still invokes this script under
// its pre-migration filename until that action lands on `main`. Remove once
// no trusted action references the `.ts` path anymore.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    path.join(REPO_ROOT, "scripts/checks/e2e-mock-parity.mts"),
    ...process.argv.slice(2),
  ],
  { cwd: REPO_ROOT, stdio: "inherit" },
);

process.exit(result.status ?? 1);
