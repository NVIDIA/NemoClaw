// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import {
  preflightForceFreshUserLocalOpenShellOwnership,
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

it("rejects an unverified user-local OpenShell binary before cleanup", () => {
  const home = "/tmp/nemoclaw-force-fresh-ownership-preflight";
  const target = `${home}/.local/bin/openshell`;
  const errors: string[] = [];

  expect(
    preflightForceFreshUserLocalOpenShellOwnership({
      env: { HOME: home } as NodeJS.ProcessEnv,
      error: (message) => errors.push(message),
      existsSync: (candidate) => candidate === target,
      isManagedOpenShellBinary: () => false,
    }),
  ).toBe(false);
  expect(errors).toEqual([
    `Force-fresh ownership preflight rejected ${target}: its managed OpenShell install manifest is absent or does not match. No cleanup started.`,
  ]);
});

it("rejects a malformed managed-install manifest through the canonical parser", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ownership-preflight-"));
  onTestFinished(() => fs.rmSync(home, { force: true, recursive: true }));
  const userBin = path.join(home, "bin");
  fs.mkdirSync(userBin);
  fs.writeFileSync(path.join(userBin, "openshell"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(userBin, ".nemoclaw-openshell-managed-v1"), "malformed\n", {
    mode: 0o600,
  });

  expect(
    preflightForceFreshUserLocalOpenShellOwnership({
      env: { HOME: home, XDG_BIN_HOME: userBin } as NodeJS.ProcessEnv,
      error: () => undefined,
    }),
  ).toBe(false);
});

async function runUninstallPlan(deps: UninstallRunDeps, forceFreshReset = false) {
  return await runUninstallPlanBase(
    { assumeYes: true, deleteModels: false, forceFreshReset, keepOpenShell: false },
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

async function uninstallOpenShell(options: {
  brewAvailable: boolean;
  brewStatus: number | null;
  forceFreshReset?: boolean;
  managedUserLocal?: boolean;
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
  const result = await runUninstallPlan(
    {
      commandExists: (command) =>
        command === "openshell" || (command === "brew" && options.brewAvailable),
      env: { HOME: home } as NodeJS.ProcessEnv,
      existsSync: (target) => existing.has(String(target)),
      hasPortableRuntimeCleanup: () => false,
      isManagedOpenShellBinary: () => options.managedUserLocal ?? false,
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
    },
    options.forceFreshReset,
  );

  return { calls, executablePaths, logs, remaining: [...existing], removed, result };
}

it("retains a Homebrew-managed OpenShell and reports its removal command (#8882)", async () => {
  const { calls, executablePaths, logs, remaining, removed, result } = await uninstallOpenShell({
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

it("lets force-fresh remove only managed user-local OpenShell binaries", async () => {
  const { executablePaths, remaining, removed, result } = await uninstallOpenShell({
    brewAvailable: true,
    brewStatus: 0,
    forceFreshReset: true,
    managedUserLocal: true,
  });
  const userLocal = executablePaths.filter((target) => target.includes("/.local/bin/"));
  const system = executablePaths.filter((target) => target.startsWith("/usr/local/bin/"));

  expect(result.exitCode).toBe(0);
  expect(new Set(removed)).toEqual(new Set(userLocal));
  expect(new Set(remaining)).toEqual(new Set(system));
});

it("retains unverified user-local OpenShell binaries during force-fresh cleanup", async () => {
  const { executablePaths, remaining, removed, result } = await uninstallOpenShell({
    brewAvailable: true,
    brewStatus: 0,
    forceFreshReset: true,
    managedUserLocal: false,
  });

  expect(result.exitCode).toBe(0);
  expect(removed).toEqual([]);
  expect(new Set(remaining)).toEqual(new Set(executablePaths));
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
])("retains OpenShell when $label (#8882)", async ({ brewAvailable, brewStatus, report }) => {
  const { calls, executablePaths, logs, remaining, removed, result } = await uninstallOpenShell({
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

it("removes managed OpenShell executables on Linux (#8882)", async () => {
  const { executablePaths, remaining, removed, result } = await uninstallOpenShell({
    brewAvailable: false,
    brewStatus: 0,
    platform: "linux",
  });

  expect(result.exitCode).toBe(0);
  expect(new Set(removed)).toEqual(new Set(executablePaths));
  expect(removed).toHaveLength(executablePaths.length);
  expect(remaining).toEqual([]);
});
