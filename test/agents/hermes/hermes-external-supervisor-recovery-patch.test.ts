// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCHER = path.join(ROOT, "agents", "hermes", "patch-external-supervisor-recovery.py");

const UPSTREAM_FIXTURE = `import json
import logging
import os
import sys
import types

gateway = types.ModuleType("gateway")
restart = types.ModuleType("gateway.restart")
restart.DEFAULT_GATEWAY_CRON_DRAIN_TIMEOUT = 30.0
restart.EXTERNAL_GATEWAY_SUPERVISOR_ENV = "HERMES_GATEWAY_EXTERNAL_SUPERVISOR"
restart.GATEWAY_SERVICE_RESTART_EXIT_CODE = 75
restart.resolve_cron_drain_budget = lambda *args, **kwargs: 0.0
gateway.restart = restart
sys.modules["gateway"] = gateway
sys.modules["gateway.restart"] = restart

from gateway.restart import (
    DEFAULT_GATEWAY_CRON_DRAIN_TIMEOUT, GATEWAY_SERVICE_RESTART_EXIT_CODE, resolve_cron_drain_budget
)

logger = logging.getLogger("gateway.run")


def _exit_with_failure_verdict(runner) -> bool:
    if not runner.should_exit_with_failure:
        return False
    return True


def _resolve_gateway_exit_verdict(runner, signal_initiated_shutdown: bool) -> bool:
    if _exit_with_failure_verdict(runner):
        return False
    if runner.exit_code is not None:
        raise SystemExit(runner.exit_code)
    if signal_initiated_shutdown and not runner._restart_requested:
        logger.info(
            "Exiting with code 1 (signal-initiated shutdown without restart "
            "request) so the service manager can revive the gateway."
        )
        return False
    if runner._restart_via_service:
        raise SystemExit(GATEWAY_SERVICE_RESTART_EXIT_CODE)
    return True


class Runner:
    should_exit_with_failure = False
    exit_code = None
    _restart_requested = False
    _restart_via_service = False


scenario = sys.argv[1]
runner = Runner()
signal_shutdown = scenario in {"external-signal", "ordinary-signal", "failure", "fatal"}
if scenario in {"external-signal", "failure", "fatal"}:
    os.environ[restart.EXTERNAL_GATEWAY_SUPERVISOR_ENV] = "1"
if scenario == "failure":
    runner.should_exit_with_failure = True
if scenario == "fatal":
    runner.exit_code = 78

try:
    result = _resolve_gateway_exit_verdict(runner, signal_shutdown)
except SystemExit as error:
    print(json.dumps({"exit": error.code, "result": None}))
else:
    print(json.dumps({"exit": 0, "result": result}))
`;

function writeFixture(): { shutdownPath: string; temporaryRoot: string } {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-recovery-"));
  const shutdownPath = path.join(temporaryRoot, "run_shutdown.py");
  fs.writeFileSync(shutdownPath, UPSTREAM_FIXTURE);
  return { shutdownPath, temporaryRoot };
}

function patch(shutdownPath: string) {
  return spawnSync("python3", ["-I", PATCHER, shutdownPath], {
    encoding: "utf8",
    timeout: 5000,
  });
}

function run(shutdownPath: string, scenario: string) {
  const result = spawnSync("python3", ["-I", shutdownPath, scenario], {
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    process: result,
    output: JSON.parse(result.stdout.trim()) as { exit: number; result: boolean | null },
  };
}

describe("Hermes external-supervisor recovery patch", () => {
  it("maps an externally supervised signal shutdown to private status 79", () => {
    const { shutdownPath, temporaryRoot } = writeFixture();
    try {
      expect(patch(shutdownPath).status).toBe(0);
      expect(patch(shutdownPath).status).toBe(0);

      const result = run(shutdownPath, "external-signal");
      expect(result.process.status, result.process.stderr).toBe(0);
      expect(result.output).toEqual({ exit: 79, result: null });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("preserves upstream signal status outside external supervision", () => {
    const { shutdownPath, temporaryRoot } = writeFixture();
    try {
      expect(patch(shutdownPath).status).toBe(0);

      const result = run(shutdownPath, "ordinary-signal");
      expect(result.process.status, result.process.stderr).toBe(0);
      expect(result.output).toEqual({ exit: 0, result: false });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["failure", 0, false],
    ["fatal", 78, null],
  ])("preserves the upstream %s verdict", (scenario, exit, verdict) => {
    const { shutdownPath, temporaryRoot } = writeFixture();
    try {
      expect(patch(shutdownPath).status).toBe(0);

      const result = run(shutdownPath, scenario);
      expect(result.process.status, result.process.stderr).toBe(0);
      expect(result.output).toEqual({ exit, result: verdict });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the pinned shutdown shape changes", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-recovery-drift-"));
    try {
      const shutdownPath = path.join(temporaryRoot, "run_shutdown.py");
      fs.writeFileSync(shutdownPath, "def _resolve_gateway_exit_verdict_changed():\n    pass\n");
      const result = patch(shutdownPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("external-supervisor recovery source shape changed");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
