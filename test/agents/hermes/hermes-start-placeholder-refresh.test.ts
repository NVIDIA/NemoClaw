// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { extractShellFunction as extractShellFunctionFromSource } from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");

describe("agents/hermes/start.sh provider placeholder refresh", () => {
  it("fails when the provider placeholder guard fails instead of swallowing it (#12510)", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-placeholder-status-"));
    try {
      const hermesHome = path.join(tmpDir, ".hermes");
      fs.mkdirSync(hermesHome, { recursive: true });
      fs.writeFileSync(
        path.join(hermesHome, ".env"),
        "TEAMS_CLIENT_SECRET=openshell:resolve:env:v1_MSTEAMS_APP_PASSWORD\n",
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            "validate_hermes_env_secret_boundary() { echo boundary-ran; }",
            "fake_guard_python() { echo guard-failed >&2; return 1; }",
            extractShellFunctionFromSource(source, "refresh_hermes_provider_placeholders"),
            `HERMES_DIR=${shellQuote(hermesHome)}`,
            `HERMES_HASH_FILE=${shellQuote(path.join(tmpDir, "hash"))}`,
            "_HERMES_PYTHON=fake_guard_python",
            "_HERMES_RUNTIME_CONFIG_GUARD=guard.py",
            "_HERMES_BOUNDARY_VALIDATOR=validator.py",
            "refresh_hermes_provider_placeholders strict",
            "echo status=$?",
          ].join("\n"),
        ],
        { encoding: "utf-8" },
      );

      expect(result.stderr).toContain("guard-failed");
      expect(result.stdout).toContain("status=1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
