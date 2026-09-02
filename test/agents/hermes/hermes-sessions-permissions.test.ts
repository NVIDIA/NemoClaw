// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractShellFunction } from "../../support/hermes-shell-harness";

const repoRoot = path.join(import.meta.dirname, "../../..");
const startScript = fs.readFileSync(path.join(repoRoot, "agents", "hermes", "start.sh"), "utf8");
const fixtures: string[] = [];

function runStartupLayoutRepair() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-sessions-repair-"));
  fixtures.push(fixture);
  const hermesHome = path.join(fixture, ".hermes");
  const sessionsDir = path.join(hermesHome, "sessions");
  const script = path.join(fixture, "repair.sh");

  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.chmodSync(sessionsDir, 0o750);
  fs.writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(startScript, "ensure_hermes_cross_uid_state_dir"),
      extractShellFunction(startScript, "repair_hermes_startup_layout"),
      "hermes_config_root_is_locked() { return 1; }",
      "ensure_hermes_config_root_mode() { :; }",
      "repair_hermes_log_permissions() { :; }",
      "ensure_hermes_state_dir() { :; }",
      "ensure_hermes_history_file() { :; }",
      `HERMES_DIR=${JSON.stringify(hermesHome)}`,
      "repair_hermes_startup_layout",
    ].join("\n"),
    { mode: 0o700 },
  );

  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: process.env,
    timeout: 5000,
  });
  return {
    result,
    sessionsMode: (fs.statSync(sessionsDir).mode & 0o7777).toString(8),
  };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes sessions permissions", () => {
  it("repairs a restored sessions directory before gateway launch (#6972)", () => {
    const run = runStartupLayoutRepair();

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.sessionsMode).toBe("2770");
  });
});
