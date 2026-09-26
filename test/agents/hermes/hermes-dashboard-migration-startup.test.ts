// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { extractShellFunction } from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");
const DASHBOARD_STATE_MIGRATOR = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "migrate-dashboard-state.py",
);

function runLegacyDashboardMigrationDeadline() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-migration-deadline-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.mkdirSync(path.join(hermesHome, "profiles", "dashboard-home"), { recursive: true });
  try {
    return spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          extractShellFunction(source, "migrate_legacy_hermes_dashboard_state"),
          'id() { [ "${1:-}" = "-u" ] && printf "1000\\n" || command id "$@"; }',
          `_HERMES_DASHBOARD_STATE_MIGRATION_TIMEOUT=(bash -c 'exit 124' bash)`,
          "_HERMES_PYTHON=python3",
          `_HERMES_DASHBOARD_STATE_MIGRATOR=${shellQuote(DASHBOARD_STATE_MIGRATOR)}`,
          `HERMES_DIR=${shellQuote(hermesHome)}`,
          "STEP_DOWN_PREFIX_SANDBOX=(env)",
          "migrate_legacy_hermes_dashboard_state",
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Hermes legacy dashboard migration startup", () => {
  it("fails with retained-state reconciliation guidance when migration times out", () => {
    const result = runLegacyDashboardMigrationDeadline();

    expect(result.status).toBe(124);
    expect(result.stderr).toContain("exceeded its 30-minute deadline");
    expect(result.stderr).toContain("profiles/dashboard-home");
    expect(result.stderr).toContain("may contain a partial migration");
    expect(result.stderr).toContain("Inspect and reconcile both locations before retrying");
  });
});
