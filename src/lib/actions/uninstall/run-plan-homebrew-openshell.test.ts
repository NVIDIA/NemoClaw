// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
} from "./run-plan";

const FORMULA = "nvidia/openshell/openshell";
const EXECUTABLE_NAMES = [
  "openshell",
  "openshell-driver-vm",
  "openshell-gateway",
  "openshell-sandbox",
] as const;

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

function uninstallOpenShell(options: {
  brewAvailable: boolean;
  brewStatus: number | null;
  platform?: NodeJS.Platform;
}) {
  const home = "/tmp/nemoclaw-uninstall-test";
  const executablePaths = EXECUTABLE_NAMES.map((name) => `${home}/.local/bin/${name}`);
  const calls: string[][] = [];
  const logs: string[] = [];
  const removed: string[] = [];
  const existing = new Set(executablePaths);
  const remove = (target: string) => {
    existing.delete(target);
    removed.push(target);
    return ok();
  };
  const result = runUninstallPlan({
    commandExists: (command) =>
      command === "openshell" || (command === "brew" && options.brewAvailable),
    env: { HOME: home } as NodeJS.ProcessEnv,
    existsSync: (target) => existing.has(String(target)),
    hasPortableRuntimeCleanup: () => false,
    isTty: true,
    log: (line) => logs.push(line),
    platform: options.platform ?? "darwin",
    rmSync: vi.fn((target) => remove(String(target))),
    run: vi.fn((command, args) => {
      calls.push([command, ...args]);
      return command === "sudo" && args[0] === "rm" && args[1] === "-f"
        ? remove(args[2])
        : command === "openshell" && args[0] === "gateway" && args[1] === "list"
          ? ok(JSON.stringify([{ name: "nemoclaw" }]))
          : command === "brew" && args[0] === "list"
            ? { status: options.brewStatus, stdout: "", stderr: "" }
            : ok();
    }),
    runDocker: () => ok(),
  });

  return { calls, executablePaths, logs, remaining: [...existing], removed, result };
}

it("retains a Homebrew-managed OpenShell and reports its removal command (#8882)", () => {
  const { calls, executablePaths, logs, remaining, removed, result } = uninstallOpenShell({
    brewAvailable: true,
    brewStatus: 0,
  });

  expect(result.exitCode).toBe(0);
  expect(calls).toContainEqual(["brew", "list", "--formula", FORMULA]);
  expect(calls.some((call) => call[0] === "brew" && call[1] === "uninstall")).toBe(false);
  expect(removed).toEqual([]);
  expect(remaining).toEqual(executablePaths);
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
  const { calls, executablePaths, logs, remaining, removed, result } = uninstallOpenShell({
    brewAvailable,
    brewStatus,
  });

  expect(result.exitCode).toBe(0);
  expect(calls.filter((call) => call[0] === "brew")).toEqual(
    brewAvailable ? [["brew", "list", "--formula", FORMULA]] : [],
  );
  expect(removed).toEqual([]);
  expect(remaining).toEqual(executablePaths);
  expect(logs).toContain(report);
});

it("removes managed OpenShell executables on Linux (#8882)", () => {
  const { executablePaths, remaining, removed, result } = uninstallOpenShell({
    brewAvailable: false,
    brewStatus: 0,
    platform: "linux",
  });

  expect(result.exitCode).toBe(0);
  expect(new Set(removed)).toEqual(new Set(executablePaths));
  expect(removed).toHaveLength(executablePaths.length);
  expect(remaining).toEqual([]);
});
