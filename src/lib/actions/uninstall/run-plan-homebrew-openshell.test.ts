// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
} from "./run-plan";

const FORMULA = "nvidia/openshell/openshell";
const EXECUTABLE_NAMES = new Set([
  "openshell",
  "openshell-driver-vm",
  "openshell-gateway",
  "openshell-sandbox",
]);

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function runUninstallPlan(deps: UninstallRunDeps) {
  return runUninstallPlanBase(
    { assumeYes: true, deleteModels: false, keepOpenShell: false },
    {
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: "packaged-service",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      ...deps,
    },
  );
}

it("retains a Homebrew-managed OpenShell and reports its removal command (#8882)", () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const removed: string[] = [];

  const result = runUninstallPlan({
    commandExists: (command) => command === "brew" || command === "openshell",
    env: { HOME: "/tmp/nemoclaw-uninstall-homebrew" } as NodeJS.ProcessEnv,
    existsSync: (target) =>
      EXECUTABLE_NAMES.has(path.basename(String(target))) &&
      path.basename(path.dirname(String(target))) === "bin",
    hasPortableRuntimeCleanup: () => false,
    isTty: false,
    log: (line) => logs.push(line),
    platform: "darwin",
    rmSync: vi.fn((target) => removed.push(String(target))),
    run: vi.fn((command, args) => {
      calls.push([command, ...args]);
      if (command === "openshell" && args[0] === "gateway" && args[1] === "list") {
        return ok(JSON.stringify([{ name: "nemoclaw" }]));
      }
      return ok();
    }),
    runDocker: () => ok(),
  });

  expect(result.exitCode).toBe(0);
  expect(calls).toContainEqual(["brew", "list", "--formula", FORMULA]);
  expect(calls.some((call) => call[0] === "brew" && call[1] === "uninstall")).toBe(false);
  expect(removed.filter((target) => EXECUTABLE_NAMES.has(path.basename(target)))).toEqual([]);
  expect(logs).toContain(
    `Kept Homebrew-managed OpenShell. To remove it, run: brew uninstall ${FORMULA}`,
  );
});
