// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunctionFromSource(src: string, name: string): string {
  const escapedName = escapeRegExp(name);
  const match = src.match(new RegExp(`${escapedName}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  expect(match, `Expected ${name} in agents/hermes/start.sh`).not.toBeNull();
  return `${name}() {${match?.[1] ?? ""}\n}`;
}

function runHermesConfigIntegrityVerifierAsRoot() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-integrity-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const hermesHome = path.join(tmpDir, ".hermes");
  const hashFile = path.join(tmpDir, "hermes.config-hash");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(hashFile, "hash\n");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "0\\n"; else command id "$@"; fi; }',
      'verify_config_integrity() { printf "verify:%s:%s:stepped=%s\\n" "$1" "$2" "${NEMOCLAW_TEST_STEPPED_DOWN:-0}"; }',
      extractShellFunctionFromSource(src, "verify_hermes_config_integrity"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES_HASH_FILE=${shellQuote(hashFile)}`,
      "STEP_DOWN_PREFIX_SANDBOX=(env NEMOCLAW_TEST_STEPPED_DOWN=1)",
      "HERMES_RESTART_FAILURE_CODE=internal",
      'if verify_hermes_config_integrity; then printf "result=success failure-code=%s\\n" "$HERMES_RESTART_FAILURE_CODE"; else printf "result=failure failure-code=%s\\n" "$HERMES_RESTART_FAILURE_CODE"; fi',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesDashboardLaunch() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-launch-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const hermesPath = path.join(tmpDir, "hermes");
  const capturePath = path.join(tmpDir, "launch.log");
  const hermesHome = path.join(tmpDir, ".hermes");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(
    hermesPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'home=%s\\n' "$HERMES_HOME" >${shellQuote(capturePath)}`,
      `printf 'api_env=%s\\n' "$NEMOCLAW_HERMES_DASHBOARD_API_SERVER_ENV" >>${shellQuote(capturePath)}`,
      `printf 'args=%s\\n' "$*" >>${shellQuote(capturePath)}`,
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "launch_hermes_dashboard_process"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES=${shellQuote(hermesPath)}`,
      "INTERNAL_PORT=18642",
      "HERMES_DASHBOARD_EXTERNAL_HOST=127.0.0.1",
      "HERMES_DASHBOARD_ARGS=(dashboard --isolated)",
      "STEP_DOWN_PREFIX_SANDBOX=()",
      "launch_hermes_dashboard_process current",
      'wait "$DASHBOARD_PID"',
      `cat ${shellQuote(capturePath)}`,
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return {
      hermesHome,
      result: spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: process.env,
      }),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runRootDashboardRecovery() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-recovery-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const hermesHome = path.join(tmpDir, ".hermes");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.mkdirSync(hermesHome, { recursive: true, mode: 0o770 });
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "0\\n"; else command id "$@"; fi; }',
      'hermes_socat_bridge_healthy() { [ "$1" = api-socat ]; }',
      "hermes_api_socat_bridge_healthy() { return 0; }",
      "hermes_dashboard_healthy() { return 1; }",
      "hermes_stop_tracked_role() { return 0; }",
      `start_hermes_dashboard_sandbox_user() { chmod 0700 ${shellQuote(hermesHome)}; DASHBOARD_PID=22; DASHBOARD_SOCAT_PID=23; }`,
      "start_hermes_dashboard_current_user() { return 99; }",
      `ensure_hermes_config_root_mode() { chmod 3770 ${shellQuote(hermesHome)}; }`,
      "sleep() { :; }",
      "ensure_dashboard_log_stream() { return 0; }",
      "ensure_gateway_log_stream() { return 0; }",
      extractShellFunctionFromSource(
        src,
        "restore_hermes_config_permissions_after_dashboard_start",
      ),
      extractShellFunctionFromSource(src, "ensure_hermes_supervised_auxiliaries"),
      "SOCAT_PID=11",
      "DASHBOARD_PID=12",
      "DASHBOARD_SOCAT_PID=13",
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "DASHBOARD_PUBLIC_PORT=5173",
      "DASHBOARD_INTERNAL_PORT=15173",
      "GATEWAY_PID=10",
      "ensure_hermes_supervised_auxiliaries",
      `test -n "$(find ${shellQuote(hermesHome)} -prune -perm 3770 -print)"`,
      "printf '3770\\n'",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runRootDashboardLaunchReadinessFailure() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-permissions-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const hermesHome = path.join(tmpDir, ".hermes");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.mkdirSync(hermesHome, { recursive: true, mode: 0o770 });
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "0\\n"; else command id "$@"; fi; }',
      "build_hermes_dashboard_args() { return 0; }",
      "prepare_restricted_log() { return 0; }",
      `launch_hermes_dashboard_process() { chmod 0700 ${shellQuote(hermesHome)}; DASHBOARD_PID=22; }`,
      "ensure_dashboard_log_stream() { return 1; }",
      `ensure_hermes_config_root_mode() { chmod 3770 ${shellQuote(hermesHome)}; }`,
      "sleep() { :; }",
      extractShellFunctionFromSource(
        src,
        "restore_hermes_config_permissions_after_dashboard_start",
      ),
      extractShellFunctionFromSource(src, "start_hermes_dashboard_sandbox_user"),
      "DASHBOARD_INTERNAL_PORT=15173",
      "status=0",
      "start_hermes_dashboard_sandbox_user || status=$?",
      'test "$status" -eq 1',
      `test -n "$(find ${shellQuote(hermesHome)} -prune -perm 3770 -print)"`,
      "printf 'status=%s mode=3770\\n' \"$status\"",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh config integrity", () => {
  it("verifies the strict Hermes hash through the sandbox identity in root mode", () => {
    const result = runHermesConfigIntegrityVerifierAsRoot();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/:stepped=1$/m);
    expect(result.stdout).toContain("result=success failure-code=internal");
  });

  it("launches the isolated dashboard against the native Hermes home", () => {
    const { hermesHome, result } = runHermesDashboardLaunch();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      `home=${hermesHome}`,
      `api_env=${hermesHome}/.env`,
      "args=dashboard --isolated",
    ]);
  });

  it("restores shared Hermes-home access after root-mode dashboard recovery", () => {
    const result = runRootDashboardRecovery();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("3770");
  });

  it("restores shared Hermes-home access before root-mode dashboard readiness", () => {
    const result = runRootDashboardLaunchReadinessFailure();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("status=1 mode=3770");
  });
});
