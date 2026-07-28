// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(options, {
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: gatewayPort === 8080 ? "packaged-service" : "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    ...deps,
  });
}

function okWithKnownGatewayList(command: string, args: readonly string[]): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }]))
    : ok();
}

describe("dual-Station runtime uninstall", () => {
  it("removes a managed pair before the remaining full-uninstall steps", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dual-pair-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-runtime.json"), "{}\n", {
      mode: 0o600,
    });
    const runDualStationRuntimeCleanup = vi.fn(() => ok());
    const rmSync = vi.fn();
    const runDocker = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync,
          run: okWithKnownGatewayList,
          runDocker,
          runDualStationRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runDualStationRuntimeCleanup).toHaveBeenCalledOnce();
      expect(runDocker).toHaveBeenCalled();
      expect(runDualStationRuntimeCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        runDocker.mock.invocationCallOrder[0],
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not start the remaining uninstall steps when managed pair cleanup fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dual-fail-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-runtime.json"), "{}\n", {
      mode: 0o600,
    });
    const errors: string[] = [];
    const rmSync = vi.fn();
    const runDocker = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync,
          run: okWithKnownGatewayList,
          runDocker,
          runDualStationRuntimeCleanup: () => ({
            status: 1,
            stdout: "",
            stderr: "peer unavailable",
          }),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(rmSync).not.toHaveBeenCalled();
      expect(runDocker).not.toHaveBeenCalled();
      expect(errors).toContain(
        "Managed dual-Station cleanup did not complete. NemoClaw did not start the remaining uninstall steps. Resolve the reported cleanup error and retry uninstall.",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
