// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { shellQuote } from "../../../src/lib/core/shell-quote";

const markerFile = "/sandbox/.hermes/memories/rebuild-marker.txt";
const markerContent = `REBUILD_HM_E2E_${Date.now()}`;
const legacyDashboardMemoryFile = "/sandbox/.hermes/dashboard-home/MEMORY.md";
const dashboardProfileMemoryFile = "/sandbox/.hermes/profiles/dashboard-home/MEMORY.md";
const dashboardMemoryContent = `REBUILD_HM_DASHBOARD_${Date.now()}`;

export const REBUILD_HERMES_STATE = {
  markerFile,
  markerContent,
  apiServerKey: createHash("sha256").update(markerContent).digest("hex"),
  seedScript: [
    `mkdir -p /sandbox/.hermes/memories ${shellQuote(path.dirname(legacyDashboardMemoryFile))}`,
    `printf '%s' ${shellQuote(markerContent)} > ${shellQuote(markerFile)}`,
    `printf '%s' ${shellQuote(dashboardMemoryContent)} > ${shellQuote(legacyDashboardMemoryFile)}`,
  ].join(" && "),
  expectedOutput: `${markerContent}\n${dashboardMemoryContent}`,
  assertBackup(backupPath: string): void {
    const memoryFile = path.join(backupPath, "dashboard-home", "MEMORY.md");
    assert.equal(
      fs.existsSync(memoryFile),
      true,
      "Hermes rebuild backup must capture legacy dashboard profile state",
    );
    assert.equal(fs.readFileSync(memoryFile, "utf8"), dashboardMemoryContent);
  },
  restoredProbeArgs(sandboxName: string): string[] {
    return [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      [
        `test -f ${shellQuote(dashboardProfileMemoryFile)}`,
        `test ! -e ${shellQuote(path.dirname(legacyDashboardMemoryFile))}`,
        `cat ${shellQuote(markerFile)}`,
        "printf '\\n'",
        `cat ${shellQuote(dashboardProfileMemoryFile)}`,
      ].join(" && "),
    ];
  },
};
