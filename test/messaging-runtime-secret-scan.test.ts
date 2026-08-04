// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractShellFunction } from "./support/hermes-shell-harness";

const SANDBOX_INIT = fs.readFileSync(
  path.join(import.meta.dirname, "..", "scripts", "lib", "sandbox-init.sh"),
  "utf-8",
);

function writeConfig(content: string): (configPath: string) => void {
  return (configPath) => fs.writeFileSync(configPath, content);
}

function runSecretScan(prepareConfig: (configPath: string) => void) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-secret-scan-"));
  const configPath = path.join(tmpDir, "openclaw.json");
  const planPath = path.join(tmpDir, "runtime-plan.json");
  const scriptPath = path.join(tmpDir, "run.sh");
  try {
    prepareConfig(configPath);
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        secretScans: [
          {
            path: configPath,
            pattern: "(?:xoxb|xapp)-(?!OPENSHELL-RESOLVE-ENV-)",
            message: "[SECURITY] Slack token leaked into {path} - refusing to serve",
            exitCode: 78,
          },
        ],
      }),
    );
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `_MESSAGING_RUNTIME_SETUP_PLAN=${JSON.stringify(planPath)}`,
        extractShellFunction(SANDBOX_INIT, "verify_messaging_runtime_secret_scans"),
        "verify_messaging_runtime_secret_scans",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    return { configPath, result };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("messaging runtime secret scans", () => {
  it.each([
    "xoxb-real-token",
    "xapp-real-token",
  ])("rejects %s without exposing the secret (#2085)", (secret) => {
    const { configPath, result } = runSecretScan(writeConfig(JSON.stringify({ token: secret })));

    expect(result.status).toBe(78);
    expect(result.stderr).toContain(configPath);
    expect(result.stderr).not.toContain(secret);
  });

  it.each([
    [
      "approved placeholder",
      writeConfig('{"botToken":"xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"}\n'),
    ],
    ["OpenShell reference", writeConfig('{"token":"openshell:resolve:env:SLACK_BOT_TOKEN"}\n')],
    ["missing file", () => undefined],
  ])("skips the %s without failure (#2085)", (_case, prepareConfig) => {
    expect(runSecretScan(prepareConfig).result.status).toBe(0);
  });
});
