// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "scripts", "nemoclaw-start.sh");

describe("legacy migration with Shields active", () => {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  const migrationFunctions = [
    "path_has_immutable_bit",
    "ensure_mutable_for_migration",
    "chown_tree_no_symlink_follow",
    "legacy_symlinks_exist",
    "assert_no_legacy_layout",
    "migrate_legacy_layout",
  ]
    .map((name) => extractShellFunctionFromSource(source, name))
    .join("\n");

  function runLockedMigration(
    configDir: string,
    dataDir: string,
    relockLog: string,
    options: { configGuardStatus?: number; stateGuardStatus?: number } = {},
  ) {
    const script = path.join(path.dirname(configDir), "locked-migration.sh");
    fs.writeFileSync(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
id() { if [ "\${1:-}" = "-u" ]; then echo 0; else command id "$@"; fi; }
stat() {
  if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = "%U" ] && [ "\${3:-}" = ${JSON.stringify(configDir)} ]; then
    echo root
    return 0
  fi
  command stat "$@"
}
_OPENCLAW_STATE_DIR_GUARD=/usr/local/lib/nemoclaw/state-dir-guard.py
run_openclaw_config_guard() {
  printf 'config:%s\\n' "$*" >>${JSON.stringify(relockLog)}
  return ${options.configGuardStatus ?? 0}
}
timeout() {
  printf 'state:%s\\n' "$*" >>${JSON.stringify(relockLog)}
  return ${options.stateGuardStatus ?? 0}
}
${migrationFunctions}
migrate_legacy_layout ${JSON.stringify(configDir)} ${JSON.stringify(dataDir)} openclaw
`,
      { mode: 0o700 },
    );
    try {
      return spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
    } finally {
      fs.rmSync(script, { force: true });
    }
  }

  it("reapplies the canonical config and state-dir guards after a locked migration (#8006)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migrate-locked-"));
    const configDir = path.join(tempDir, ".openclaw");
    const dataDir = path.join(tempDir, ".openclaw-data");
    const relockLog = path.join(tempDir, "relock.log");
    fs.mkdirSync(configDir);
    fs.mkdirSync(path.join(dataDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "skills", "skill.txt"), "legacy skill");

    try {
      const result = runLockedMigration(configDir, dataDir, relockLog);

      expect(result.status).toBe(0);
      expect(fs.readFileSync(relockLog, "utf-8").trim().split("\n")).toEqual([
        "config:recover --startup-owner",
        `state:--signal=TERM --kill-after=5s 12m python3 -I /usr/local/lib/nemoclaw/state-dir-guard.py lock --config-dir ${configDir} --plan-file /usr/local/share/nemoclaw/state-lock-plan.json`,
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      guard: "config",
      options: { configGuardStatus: 1 },
      error: "canonical config guard refused",
      expectedCalls: 1,
    },
    {
      guard: "state-dir",
      options: { stateGuardStatus: 1 },
      error: "canonical state-dir guard refused",
      expectedCalls: 2,
    },
  ])("keeps the legacy data retryable when the canonical $guard guard refuses relock (#8006)", (testCase) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migrate-relock-fail-"));
    const configDir = path.join(tempDir, ".openclaw");
    const dataDir = path.join(tempDir, ".openclaw-data");
    const relockLog = path.join(tempDir, "relock.log");
    fs.mkdirSync(configDir);
    fs.mkdirSync(path.join(dataDir, "skills"), { recursive: true });

    try {
      const result = runLockedMigration(configDir, dataDir, relockLog, testCase.options);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.error);
      expect(fs.readFileSync(relockLog, "utf-8").trim().split("\n")).toHaveLength(
        testCase.expectedCalls,
      );
      expect(fs.existsSync(dataDir)).toBe(true);
      expect(fs.existsSync(path.join(configDir, ".migration-complete"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
