// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractShellFunction } from "./support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

describe("Hermes post-Dashboard permission restore", () => {
  it("reasserts the complete writable layout throughout the bounded startup window", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-repair-"));
    const scriptPath = path.join(tmpDir, "run.sh");
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        extractShellFunction(src, "restore_hermes_config_permissions_after_dashboard_start"),
        'id() { [ "${1:-}" = "-u" ] && printf "0\\n"; }',
        'repair_hermes_startup_layout() { printf "repair-layout\\n"; }',
        "sleep() { :; }",
        "restore_hermes_config_permissions_after_dashboard_start",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: process.env,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(Array(5).fill("repair-layout"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
