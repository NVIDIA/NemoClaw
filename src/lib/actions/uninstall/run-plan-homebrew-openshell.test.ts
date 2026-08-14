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

const FORMULA = "nvidia/openshell/openshell";
const OPENSHELL_EXECUTABLES = new Set([
  "openshell",
  "openshell-gateway",
  "openshell-sandbox",
  "openshell-driver-vm",
]);

/** Executables only: the OpenShell config directory shares the `openshell` name. */
function isOpenShellExecutablePath(target: string): boolean {
  return (
    OPENSHELL_EXECUTABLES.has(path.basename(target)) &&
    path.basename(path.dirname(target)) === "bin"
  );
}

function removedOpenShellExecutables(removed: string[]): string[] {
  return removed.filter(isOpenShellExecutablePath);
}

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

/**
 * Run a full uninstall and record every host command.
 *
 * `brewListStatus` decides whether Homebrew reports the NemoClaw formula as
 * installed, which is the guard that keeps an unrelated OpenShell installed.
 */
function uninstallWithHomebrew(options: {
  brewInstalled: boolean;
  brewListStatus?: number;
  brewUninstallStatus?: number;
  platform: NodeJS.Platform;
}): { calls: string[][]; logs: string[]; removed: string[]; warnings: string[] } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-brew-"));
  // removeFileWithOptionalSudo probes the real parent directory for write
  // access, so the XDG bin directory must exist for a deletion to be reachable.
  fs.mkdirSync(path.join(tmpHome, ".local", "bin"), { recursive: true });
  const calls: string[][] = [];
  const logs: string[] = [];
  const removed: string[] = [];
  const warnings: string[] = [];
  // Report every managed OpenShell executable as present so a deletion is
  // observable; asserting only the brew argv cannot see a path unlink.
  const isOpenShellExecutable = (target: string): boolean =>
    isOpenShellExecutablePath(String(target));
  try {
    runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: false },
      {
        commandExists: (command) =>
          command === "brew" ? options.brewInstalled : command === "openshell",
        env: { HOME: tmpHome } as NodeJS.ProcessEnv,
        existsSync: (target) => isOpenShellExecutable(target),
        isTty: false,
        log: (line) => logs.push(line),
        platform: options.platform,
        rmSync: vi.fn((target: Parameters<typeof fs.rmSync>[0]) => {
          removed.push(String(target));
        }),
        run: (command, args) => {
          calls.push([command, ...args]);
          if (command === "brew" && args[0] === "list") {
            return { status: options.brewListStatus ?? 0, stdout: "", stderr: "" };
          }
          if (command === "brew" && args[0] === "uninstall") {
            return { status: options.brewUninstallStatus ?? 0, stdout: "", stderr: "" };
          }
          if (command === "openshell" && args[0] === "gateway" && args[1] === "list") {
            return ok(JSON.stringify([{ name: "nemoclaw" }]));
          }
          return ok();
        },
        // buildRuntime wires runtime.warn from deps.error.
        error: (line) => warnings.push(line),
        runDocker: () => ok(""),
      },
    );
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  return { calls, logs, removed, warnings };
}

function brewArgs(calls: string[][]): string[][] {
  return calls.filter((call) => call[0] === "brew");
}

describe("uninstall Homebrew-managed OpenShell", () => {
  it("removes the managed formula so no executable stays linked in the Homebrew prefix (#8882)", () => {
    const { calls, logs, removed } = uninstallWithHomebrew({
      brewInstalled: true,
      platform: "darwin",
    });

    expect(brewArgs(calls)).toEqual([
      ["brew", "list", "--formula", FORMULA],
      ["brew", "uninstall", "--formula", FORMULA],
    ]);
    expect(logs).toContain(`Removed Homebrew formula ${FORMULA}`);
    expect(removedOpenShellExecutables(removed)).not.toEqual([]);
  });

  it("keeps an OpenShell that Homebrew did not install from the NemoClaw tap (#8882)", () => {
    // A non-zero `brew list` means the fully qualified formula is absent, so an
    // OpenShell from another tap or a manual build must survive the uninstall.
    const { calls, logs, removed } = uninstallWithHomebrew({
      brewInstalled: true,
      brewListStatus: 1,
      platform: "darwin",
    });

    expect(brewArgs(calls)).toEqual([["brew", "list", "--formula", FORMULA]]);
    expect(logs).not.toContain(`Removed Homebrew formula ${FORMULA}`);
    // The ownership decision must also stop the path deletion, or an executable
    // owned by another tap is unlinked from /usr/local/bin anyway.
    expect(removedOpenShellExecutables(removed)).toEqual([]);
  });

  it("names the manual command when the formula removal fails (#8882)", () => {
    const { removed, warnings } = uninstallWithHomebrew({
      brewInstalled: true,
      brewUninstallStatus: 1,
      platform: "darwin",
    });

    expect(warnings.join("\n")).toContain(`brew uninstall ${FORMULA}`);
    // A stranded formula must keep its executables, not lose them to the loop.
    expect(removedOpenShellExecutables(removed)).toEqual([]);
  });

  it("does not call Homebrew on a platform that installs OpenShell directly (#8882)", () => {
    const { calls, removed } = uninstallWithHomebrew({ brewInstalled: true, platform: "linux" });

    expect(brewArgs(calls)).toEqual([]);
    expect(removedOpenShellExecutables(removed)).not.toEqual([]);
  });

  it("does not call Homebrew when it is absent from the host (#8882)", () => {
    const { calls, removed } = uninstallWithHomebrew({ brewInstalled: false, platform: "darwin" });

    expect(brewArgs(calls)).toEqual([]);
    expect(removedOpenShellExecutables(removed)).not.toEqual([]);
  });
});
