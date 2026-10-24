// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { proveRealLegacyMigrationBridges } from "../../helpers/openclaw-real-legacy-migration-proof";

// The caller supplies separately installed, reviewed distributions. This proof
// does not fetch packages or stand in for the managed image's installation test.
const migrationRoot = process.env.NEMOCLAW_REAL_OPENCLAW_MIGRATION_ROOT;
const targetRuntime = process.env.NEMOCLAW_REAL_OPENCLAW_MIGRATION_TARGET;

it.skipIf(!migrationRoot || !targetRuntime)(
  "preserves a legacy backup through native migration Doctors and refuses a downgrade",
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-proof-"));
    try {
      proveRealLegacyMigrationBridges({
        home,
        nodeExecutable: process.env.NEMOCLAW_REAL_OPENCLAW_NODE ?? process.execPath,
        runtime95: path.join(migrationRoot!, "2026.9.5", "node_modules", "openclaw"),
        runtime97: path.join(migrationRoot!, "2026.9.7", "node_modules", "openclaw"),
        targetRuntime: targetRuntime!,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
  1_500_000,
);
