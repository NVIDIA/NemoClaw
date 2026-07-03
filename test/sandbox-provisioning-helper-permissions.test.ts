// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  expect(start, `Expected Dockerfile start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `Expected Dockerfile end marker: ${endMarker}`).toBeGreaterThan(start);
  const runIndex = dockerfile.indexOf("RUN ", start);
  expect(runIndex, `Expected RUN instruction after ${startMarker}`).toBeGreaterThanOrEqual(start);
  expect(runIndex, `Expected RUN instruction before ${endMarker}`).toBeLessThan(end);
  const runBlock = dockerfile.slice(runIndex, end).split("\n");
  const completeLineIndex = runBlock.findIndex((line) => !line.trimEnd().endsWith("\\"));
  expect(
    completeLineIndex,
    `Expected complete RUN instruction before ${endMarker}`,
  ).toBeGreaterThanOrEqual(0);
  const runLines = runBlock.slice(0, completeLineIndex + 1);
  return runLines
    .join("\n")
    .trim()
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

function runLoggedDockerShell(command: string, tmp: string, functionDefs: string[] = []) {
  const logPath = path.join(tmp, "calls.log");
  const scriptPath = path.join(tmp, "run-docker-block.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `call_log=${JSON.stringify(logPath)}`,
      ...functionDefs,
      command,
    ].join("\n"),
    { mode: 0o700 },
  );
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  return { result };
}

describe("sandbox provisioning: copied OpenClaw helper permissions (#2861)", () => {
  it("normalizes copied blueprint permissions before non-root config generation", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-mode-"));
    const blueprintRoot = path.join(tmp, "opt", "nemoclaw-blueprint");
    const nemoclawRoot = path.join(tmp, "opt", "nemoclaw");
    const manifestDir = path.join(blueprintRoot, "model-specific-setup", "openclaw");
    const manifestPath = path.join(manifestDir, "kimi-k2.6-managed-inference.json");
    const pluginPackageJson = path.join(nemoclawRoot, "package.json");

    try {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(manifestPath, "{}\n", { mode: 0o600 });
      fs.chmodSync(path.join(blueprintRoot, "model-specific-setup"), 0o700);
      fs.chmodSync(manifestDir, 0o700);
      fs.chmodSync(manifestPath, 0o600);
      fs.mkdirSync(nemoclawRoot, { recursive: true });
      fs.writeFileSync(pluginPackageJson, "{}\n", { mode: 0o400 });
      fs.chmodSync(nemoclawRoot, 0o700);
      fs.chmodSync(pluginPackageJson, 0o400);

      const command = dockerRunCommandBetween(
        dockerfile,
        "# Copy built plugin and blueprint",
        "# Install runtime dependencies only",
      )
        .replaceAll("/opt/nemoclaw-blueprint", "__BLUEPRINT__")
        .replaceAll("/opt/nemoclaw", nemoclawRoot)
        .replaceAll("__BLUEPRINT__", blueprintRoot);
      const { result } = runLoggedDockerShell(command, tmp);

      expect(result.status, result.stderr).toBe(0);
      expect((fs.statSync(manifestDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(manifestPath).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(nemoclawRoot).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(pluginPackageJson).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes the config generator mode after Docker COPY preserves a restrictive source mode", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-helper-mode-"));
    const localBin = path.join(tmp, "usr", "local", "bin");
    const localLib = path.join(tmp, "usr", "local", "lib", "nemoclaw");
    const localShare = path.join(tmp, "usr", "local", "share", "nemoclaw");
    const localSrc = path.join(tmp, "src");
    const localScripts = path.join(tmp, "scripts");
    const generatorPath = path.join(localScripts, "generate-openclaw-config.mts");
    const applierPath = path.join(
      localSrc,
      "lib",
      "messaging",
      "applier",
      "build",
      "messaging-build-applier.mts",
    );
    const messagingHookPath = path.join(
      localSrc,
      "lib",
      "messaging",
      "channels",
      "fixture",
      "hooks",
      "example.ts",
    );
    const pluginDir = path.join(localShare, "openclaw-plugins", "kimi-inference-compat");
    const pluginFile = path.join(pluginDir, "index.js");
    const nestedPluginDir = path.join(pluginDir, "lib");
    const nestedPluginFile = path.join(nestedPluginDir, "helper.js");
    const gatewayControlPath = path.join(localBin, "nemoclaw-gateway-control");
    const gatewaySupervisorPath = path.join(localLib, "gateway-supervisor.sh");
    const stateDirGuardPath = path.join(localLib, "state-dir-guard.py");
    const configGuardPath = path.join(localLib, "openclaw-config-guard.py");
    const managedGatewayControlPath = path.join(localLib, "managed-gateway-control.py");
    const files = [
      path.join(localBin, "nemoclaw-start"),
      path.join(localBin, "nemoclaw-codex-acp"),
      gatewayControlPath,
      path.join(localLib, "sandbox-init.sh"),
      path.join(localLib, "sandbox-rlimits.sh"),
      gatewaySupervisorPath,
      stateDirGuardPath,
      configGuardPath,
      managedGatewayControlPath,
      path.join(localLib, "openclaw_device_approval_policy.py"),
      path.join(localLib, "clean_runtime_shell_env_shim.py"),
      path.join(localLib, "normalize_mutable_config_perms.py"),
      generatorPath,
      applierPath,
      messagingHookPath,
      path.join(localLib, "ws-proxy-fix.js"),
      pluginFile,
      nestedPluginFile,
    ];

    try {
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(localLib, { recursive: true });
      fs.mkdirSync(localScripts, { recursive: true });
      fs.mkdirSync(nestedPluginDir, { recursive: true });
      fs.mkdirSync(path.dirname(applierPath), { recursive: true });
      fs.mkdirSync(path.dirname(messagingHookPath), { recursive: true });
      for (const file of files) {
        fs.writeFileSync(file, "# fixture\n", { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      }

      const command = dockerRunCommandBetween(
        dockerfile,
        "# Copy startup script and shared sandbox initialisation library",
        "# Build args for config that varies per deployment.",
      )
        .replaceAll("/usr/local/bin", localBin)
        .replaceAll("/usr/local/lib/nemoclaw", localLib)
        .replaceAll("/usr/local/share/nemoclaw", localShare)
        .replaceAll("/src", localSrc)
        .replaceAll("/scripts", localScripts);
      const { result } = runLoggedDockerShell(command, tmp, ["chown() { :; }"]);

      expect(result.status, result.stderr).toBe(0);
      expect((fs.statSync(generatorPath).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(applierPath).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(messagingHookPath).mode & 0o777).toString(8)).toBe("644");
      expect(
        (
          fs.statSync(path.join(localLib, "openclaw_device_approval_policy.py")).mode & 0o777
        ).toString(8),
      ).toBe("644");
      expect(
        (
          fs.statSync(path.join(localLib, "normalize_mutable_config_perms.py")).mode & 0o777
        ).toString(8),
      ).toBe("555");
      expect((fs.statSync(pluginDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(pluginFile).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(nestedPluginDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(nestedPluginFile).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(gatewayControlPath).mode & 0o777).toString(8)).toBe("700");
      expect((fs.statSync(gatewaySupervisorPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(stateDirGuardPath).mode & 0o777).toString(8)).toBe("500");
      expect((fs.statSync(configGuardPath).mode & 0o777).toString(8)).toBe("500");
      expect((fs.statSync(managedGatewayControlPath).mode & 0o777).toString(8)).toBe("500");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
