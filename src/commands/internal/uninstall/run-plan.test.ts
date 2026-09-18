// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { Config } from "@oclif/core";

const mocks = vi.hoisted(() => ({
  preflightForceFreshUserLocalOpenShellOwnership: vi.fn(),
  runUninstallPlan: vi.fn(),
  runUninstallPlanProduction: vi.fn(),
}));

vi.mock("../../../lib/actions/uninstall/run-plan", () => mocks);
vi.mock("../../../lib/actions/maintenance", () => ({ backupAllUnderPortableHostFence: vi.fn() }));
vi.mock("../../../lib/actions/uninstall/all-gateway-ports", () => ({
  allGatewayPortsRequested: () => false,
  runUninstallAllGatewayPorts: vi.fn(),
}));

import InternalUninstallRunPlanCommand from "./run-plan";

describe("internal uninstall command", () => {
  it("runs the hidden force-fresh ownership preflight without starting uninstall", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    mocks.preflightForceFreshUserLocalOpenShellOwnership.mockReturnValue(false);
    const instance = new InternalUninstallRunPlanCommand([], {} as Config);
    Object.defineProperty(instance, "parse", {
      value: vi.fn().mockResolvedValue({
        flags: { "force-fresh-ownership-preflight": true },
      }),
    });

    try {
      await instance.run();
      expect(mocks.preflightForceFreshUserLocalOpenShellOwnership).toHaveBeenCalledOnce();
      expect(mocks.runUninstallPlanProduction).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("awaits the production uninstall transaction before applying its exit result", async () => {
    const previousExitCode = process.exitCode;
    let complete!: (value: { exitCode: number }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<{ exitCode: number }>((resolve) => {
      complete = resolve;
    });
    mocks.runUninstallPlanProduction.mockImplementation(() => {
      entered();
      return pending;
    });
    let finished = false;
    process.exitCode = undefined;
    const instance = new InternalUninstallRunPlanCommand([], {} as Config);
    Object.defineProperty(instance, "parse", {
      value: vi.fn().mockResolvedValue({
        flags: { yes: true, "force-fresh-reset": true, "keep-openshell": true },
      }),
    });
    const command = instance.run().then(() => {
      finished = true;
    });
    try {
      await Promise.race([started, command]);
      expect(mocks.runUninstallPlanProduction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ assumeYes: true, forceFreshReset: true, keepOpenShell: true }),
        expect.objectContaining({
          backupAllBeforeUninstall: expect.any(Function),
          withSandboxMutationLock: expect.any(Function),
        }),
      );
      expect(mocks.runUninstallPlan).not.toHaveBeenCalled();
      expect(finished).toBe(false);
      expect(process.exitCode).toBeUndefined();
      complete({ exitCode: 1 });
      await command;
      expect(process.exitCode).toBe(1);
    } finally {
      complete({ exitCode: 0 });
      await command.finally(() => {
        process.exitCode = previousExitCode;
      });
    }
  });
});
