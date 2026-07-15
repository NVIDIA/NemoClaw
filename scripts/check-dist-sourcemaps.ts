// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    path.join(REPO_ROOT, "scripts/check-dist-sourcemaps.mts"),
    ...process.argv.slice(2),
  ],
  { cwd: REPO_ROOT, stdio: "inherit" },
);

process.exit(result.status ?? 1);
