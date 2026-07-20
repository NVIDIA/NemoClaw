// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

const startScriptSource = fs.readFileSync(START_SCRIPT, "utf-8");

const LAUNCH_ENV = {
  OPENCLAW_GATEWAY_PORT: "18790",
  OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
  OPENCLAW_GATEWAY_URL: "ws://10.200.0.2:18790",
  OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
};

function extractFunction(name: string): string {
  const start = startScriptSource.indexOf(`${name}() {`);
  const end = startScriptSource.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return startScriptSource.slice(start, end + 3);
}

function respawnLaunchFragment(): string {
  const start = startScriptSource.indexOf("prepare_openclaw_automatic_respawn || exit 1");
  const endMarker = 'echo "[gateway] respawned (pid $GATEWAY_PID)" >&2';
  const end = startScriptSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return startScriptSource.slice(start, end + endMarker.length);
}

function writeFakeOpenclaw(tmpDir: string): { openclawPath: string; envDumpPath: string } {
  const openclawPath = path.join(tmpDir, "openclaw");
  const envDumpPath = path.join(tmpDir, "gateway-env-dump.txt");
  fs.writeFileSync(openclawPath, `#!/bin/sh\nprintenv > "$NEMOCLAW_TEST_ENV_DUMP"\n`, {
    mode: 0o755,
  });
  return { openclawPath, envDumpPath };
}

function runLaunchFunction(name: string, extraSetup: string[] = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-launch-"));
  const { openclawPath, envDumpPath } = writeFakeOpenclaw(tmpDir);
  const gatewayLog = path.join(tmpDir, "gateway.log");
  const fn = extractFunction(name).replaceAll("/tmp/gateway.log", gatewayLog);
  const script = [
    "set -euo pipefail",
    `OPENCLAW=${JSON.stringify(openclawPath)}`,
    '_DASHBOARD_PORT="18790"',
    // Supervisor collaborators are covered by their own suites; this harness
    // exercises only the launch line's process environment.
    "arm_openclaw_gateway_supervisor_cleanup() { :; }",
    "mark_in_container_gateway() { :; }",
    'capture_openclaw_pid_start_identity() { eval "$2=test-start-identity"; }',
    "record_gateway_pid() { :; }",
    "clear_gateway_pid_record() { :; }",
    ...extraSetup,
    fn,
    name,
    "wait",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    timeout: 10000,
    env: {
      ...process.env,
      ...LAUNCH_ENV,
      NEMOCLAW_TEST_ENV_DUMP: envDumpPath,
    },
  });
  expect(result.status).toBe(0);
  const dumped = fs.readFileSync(envDumpPath, "utf-8");
  return { result, dumped };
}

describe("nemoclaw-start gateway launch environment", () => {
  it("launches the non-root gateway without OPENCLAW_GATEWAY_URL so embedded dial-backs resolve the loopback gateway (#6413)", () => {
    const { result, dumped } = runLaunchFunction("launch_openclaw_gateway_non_root");
    expect(result.stderr).toContain("openclaw gateway launched");
    expect(dumped).not.toMatch(/^OPENCLAW_GATEWAY_URL=/m);
    expect(dumped).toMatch(/^OPENCLAW_GATEWAY_TOKEN=test-gateway-token$/m);
    // Deliberately retained: other private-ws consumers inside the daemon may
    // still rely on it; only the gateway URL selects the dial-back target.
    expect(dumped).toMatch(/^OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1$/m);
  });

  it("launches the root-mode gateway without OPENCLAW_GATEWAY_URL through the step-down wrapper (#6413)", () => {
    const { result, dumped } = runLaunchFunction("launch_openclaw_gateway", [
      "STEP_DOWN_PREFIX_GATEWAY=()",
    ]);
    expect(result.stderr).toContain("openclaw gateway launched");
    expect(dumped).not.toMatch(/^OPENCLAW_GATEWAY_URL=/m);
    expect(dumped).toMatch(/^OPENCLAW_GATEWAY_TOKEN=test-gateway-token$/m);
    expect(dumped).toMatch(/^OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1$/m);
  });

  it("respawns the gateway without OPENCLAW_GATEWAY_URL after a crash exit (#4616)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-respawn-"));
    const { openclawPath, envDumpPath } = writeFakeOpenclaw(tmpDir);
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const fragment = respawnLaunchFragment().replaceAll("/tmp/gateway.log", gatewayLog);
    const script = [
      "set -euo pipefail",
      `OPENCLAW=${JSON.stringify(openclawPath)}`,
      '_DASHBOARD_PORT="18790"',
      "prepare_openclaw_automatic_respawn() { :; }",
      'capture_openclaw_pid_start_identity() { eval "$2=test-start-identity"; }',
      "record_gateway_pid() { :; }",
      "refresh_openclaw_supervised_child_pids() { :; }",
      fragment,
      "wait",
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      timeout: 10000,
      env: {
        ...process.env,
        ...LAUNCH_ENV,
        NEMOCLAW_TEST_ENV_DUMP: envDumpPath,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[gateway] respawned");
    const dumped = fs.readFileSync(envDumpPath, "utf-8");
    expect(dumped).not.toMatch(/^OPENCLAW_GATEWAY_URL=/m);
    expect(dumped).toMatch(/^OPENCLAW_GATEWAY_TOKEN=test-gateway-token$/m);
    // Only the gateway URL is scrubbed; the respawn path retains the same
    // private-ws contract as the initial launch functions.
    expect(dumped).toMatch(/^OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1$/m);
  });
});
