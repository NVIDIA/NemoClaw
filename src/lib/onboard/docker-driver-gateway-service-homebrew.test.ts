// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  hasOpenShellGatewayUserService,
  OPENSHELL_GATEWAY_HOMEBREW_FORMULA_SHA256,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
  startPackageManagedDockerDriverGateway,
} from "./docker-driver-gateway-service";

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function officialFormulaInfo(): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify({ formulae: [{ name: "openshell", tap: "nvidia/openshell" }] }),
  );
}

describe("OpenShell Homebrew service boundary", () => {
  it("rejects a Homebrew formula outside the official tap (#6903)", () => {
    const operation = vi.fn((args: string[]) =>
      args[0] === "info"
        ? spawnResult(
            0,
            "",
            JSON.stringify({ formulae: [{ name: "openshell", tap: "other/tap" }] }),
          )
        : spawnResult(),
    );

    expect(() =>
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: operation,
        platform: "darwin",
      }),
    ).toThrow("must come from nvidia/openshell");
  });

  it("uses the temporary formula trust boundary for inspection (#7707)", () => {
    const operation = vi.fn((args: string[]) =>
      args[0] === "info" ? officialFormulaInfo() : spawnResult(),
    );

    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: operation,
        platform: "darwin",
      }),
    ).toBe(true);
    expect(operation.mock.calls.map(([args]) => args)).toEqual([
      ["list", "--formula", "openshell"],
      ["info", "--json=v2", "openshell"],
    ]);
  });

  it.each([
    [66, "Run curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"],
    [67, "could not grant temporary trust"],
    [68, "could not remove temporary trust"],
    [69, "Run curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"],
  ])("fails closed on Homebrew boundary status %i (#7707)", (status, expected) => {
    const preparePortForServiceStart = vi.fn();
    const prepareServiceEnv = vi.fn();
    const validatePortOwnerForServiceStart = vi.fn();

    expect(() =>
      startOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: () => spawnResult(status, "opaque Homebrew diagnostic"),
        platform: "darwin",
        preparePortForServiceStart,
        prepareServiceEnv,
        validatePortOwnerForServiceStart,
      }),
    ).toThrow(expected);
    expect(preparePortForServiceStart).not.toHaveBeenCalled();
    expect(prepareServiceEnv).not.toHaveBeenCalled();
    expect(validatePortOwnerForServiceStart).not.toHaveBeenCalled();
  });

  it("invokes the shipped operation boundary instead of parsing Homebrew stderr (#7707)", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      const brewIndex = args.indexOf("brew");
      return args[brewIndex + 1] === "info" ? officialFormulaInfo() : spawnResult();
    });

    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        platform: "darwin",
        spawnSyncImpl,
      }),
    ).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        "--homebrew-formula-operation",
        OPENSHELL_GATEWAY_HOMEBREW_FORMULA_SHA256,
        "--",
        "brew",
        "list",
        "--formula",
        "openshell",
      ]),
      expect.any(Object),
    );
  });

  it("skips the managed start when no trusted Homebrew service is selected (#7707)", async () => {
    const startService = vi.fn(() => {
      throw new Error("managed start must not run");
    });
    const started = await startPackageManagedDockerDriverGateway({
      clearDockerDriverGatewayRuntimeFiles: () => {},
      exitOnFailure: false,
      gatewayName: "nemoclaw",
      hasOpenShellGatewayUserService: () => false,
      registerDockerDriverGatewayEndpoint: () => true,
      runCaptureOpenshell: () => "",
      skipSandboxBridgeReachability: true,
      startOpenShellGatewayUserService: startService,
      verifySandboxBridgeGatewayReachableOrExit: async () => {},
    });

    expect(started).toBe(false);
    expect(startService).not.toHaveBeenCalled();
  });

  it("reports no managed service only when the formula is genuinely absent (#8104)", () => {
    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: () => spawnResult(65),
        platform: "darwin",
      }),
    ).toBe(false);
  });
});
