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

function uninstallOnMacOs(options: { brewAvailable: boolean; brewStatus: number | null }) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const removed: string[] = [];

  const result = runUninstallPlan({
    commandExists: (command) =>
      command === "openshell" || (command === "brew" && options.brewAvailable),
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
      return command === "openshell" && args[0] === "gateway" && args[1] === "list"
        ? ok(JSON.stringify([{ name: "nemoclaw" }]))
        : command === "brew" && args[0] === "list"
          ? { status: options.brewStatus, stdout: "", stderr: "" }
          : ok();
    }),
    runDocker: () => ok(),
  });

  return { calls, logs, removed, result };
}

function removedOpenShellExecutables(removed: readonly string[]): string[] {
  return removed.filter((target) => EXECUTABLE_NAMES.has(path.basename(target)));
}

it("retains a Homebrew-managed OpenShell and reports its removal command (#8882)", () => {
  const { calls, logs, removed, result } = uninstallOnMacOs({
    brewAvailable: true,
    brewStatus: 0,
  });

  expect(result.exitCode).toBe(0);
  expect(calls).toContainEqual(["brew", "list", "--formula", FORMULA]);
  expect(calls.some((call) => call[0] === "brew" && call[1] === "uninstall")).toBe(false);
  expect(removedOpenShellExecutables(removed)).toEqual([]);
  expect(logs).toContain(
    `Kept Homebrew-managed OpenShell. To remove it, run: brew uninstall ${FORMULA}`,
  );
});

it.each([
  {
    label: "Homebrew is unavailable",
    brewAvailable: false,
    brewStatus: 0,
    report: `Kept OpenShell executables because Homebrew is unavailable. If Homebrew manages OpenShell, make brew available through PATH, then run: brew uninstall ${FORMULA}`,
  },
  {
    label: "the formula query fails",
    brewAvailable: true,
    brewStatus: 1,
    report: `Kept OpenShell executables because Homebrew did not confirm ${FORMULA}. Check the formula before removing OpenShell.`,
  },
  {
    label: "the formula query does not start",
    brewAvailable: true,
    brewStatus: null,
    report: `Kept OpenShell executables because Homebrew did not confirm ${FORMULA}. Check the formula before removing OpenShell.`,
  },
])("retains OpenShell when $label (#8882)", ({ brewAvailable, brewStatus, report }) => {
  const { calls, logs, removed, result } = uninstallOnMacOs({ brewAvailable, brewStatus });

  expect(result.exitCode).toBe(0);
  expect(calls.filter((call) => call[0] === "brew")).toEqual(
    brewAvailable ? [["brew", "list", "--formula", FORMULA]] : [],
  );
  expect(removedOpenShellExecutables(removed)).toEqual([]);
  expect(logs).toContain(report);
});
