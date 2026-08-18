// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createOnboardOpenShellInstallBindings,
  ensureOpenshellForOnboard,
  type OpenShellInstallDeps,
  type OpenShellInstallResult,
} from "./openshell-install";

function makeDeps(overrides: Partial<OpenShellInstallDeps> = {}) {
  const installResult: OpenShellInstallResult = {
    installed: true,
    localBin: "/tmp/openshell",
    futureShellPathHint: null,
  };
  const deps: OpenShellInstallDeps = {
    isLinuxDockerDriverGatewayEnabled: () => false,
    resolveOpenShellGatewayBinary: () => "/tmp/openshell-gateway",
    resolveOpenShellSandboxBinary: () => "/tmp/openshell-sandbox",
    isOpenshellInstalled: () => true,
    installOpenshell: vi.fn(() => installResult),
    getInstalledOpenshellVersion: () => "0.0.72",
    getBlueprintMinOpenshellVersion: () => "0.0.72",
    getBlueprintMaxOpenshellVersion: () => "0.0.72",
    runCaptureOpenshell: () => "openshell 0.0.72",
    shouldUseOpenshellDevChannel: () => false,
    isOpenshellDevVersion: () => false,
    versionGte: (a, b) =>
      a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "base",
      }) >= 0,
    hasRequiredOpenshellMessagingFeatures: () => true,
    shouldAllowOpenshellAboveBlueprintMax: () => false,
    cliDisplayName: () => "nemoclaw",
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
    platform: "linux",
    arch: "x64",
    ...overrides,
  };
  return deps;
}

describe("ensureOpenshellForOnboard", () => {
  it("binds lazy install dependencies and forwards trusted-owner persistence", () => {
    const installResult: OpenShellInstallResult = {
      installed: true,
      localBin: "/tmp/openshell",
      futureShellPathHint: null,
    };
    const getInstallDeps = vi.fn((exit?: (code: number) => never) =>
      makeDeps({
        isOpenshellInstalled: () => false,
        installOpenshell: () => installResult,
        exit: exit ?? makeDeps().exit,
      }),
    );
    const afterSuccessfulInstall = vi.fn();
    const bindings = createOnboardOpenShellInstallBindings({
      getInstallDeps,
      afterSuccessfulInstall,
    });
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const persistTrustedGatewayOwner = vi.fn();

    expect(
      bindings.areRequiredDockerDriverBinariesPresent("linux", {
        gatewayBin: "/tmp/gateway",
        sandboxBin: "/tmp/sandbox",
      }),
    ).toBe(true);
    expect(bindings.ensureOpenshellForOnboard(exitProcess, persistTrustedGatewayOwner)).toEqual(
      installResult,
    );

    expect(getInstallDeps).toHaveBeenNthCalledWith(1);
    expect(getInstallDeps).toHaveBeenNthCalledWith(2, exitProcess);
    expect(afterSuccessfulInstall).toHaveBeenCalledWith(persistTrustedGatewayOwner);
  });

  it("runs trusted post-install reconciliation only after a successful install", () => {
    const afterSuccessfulInstall = vi.fn();
    const deps = makeDeps({
      isOpenshellInstalled: () => false,
      installOpenshell: () => ({
        installed: true,
        localBin: "/tmp/openshell",
        futureShellPathHint: null,
      }),
    });

    ensureOpenshellForOnboard(deps, { afterSuccessfulInstall });

    expect(afterSuccessfulInstall).toHaveBeenCalledOnce();
  });

  it("does not run post-install reconciliation when no install was needed", () => {
    const afterSuccessfulInstall = vi.fn();

    ensureOpenshellForOnboard(makeDeps(), { afterSuccessfulInstall });

    expect(afterSuccessfulInstall).not.toHaveBeenCalled();
  });

  it("reinstalls when the installed OpenShell lacks messaging rewrite or MCP L7 support", () => {
    const hasFeatures = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const deps = makeDeps({
      hasRequiredOpenshellMessagingFeatures: hasFeatures,
    });

    ensureOpenshellForOnboard(deps);

    expect(deps.installOpenshell).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      "  OpenShell is missing provider credential rewrite or MCP L7 policy support. Reinstalling...",
    );
  });

  it("fails closed after reinstall if OpenShell still lacks messaging rewrite or MCP L7 support", () => {
    const deps = makeDeps({
      hasRequiredOpenshellMessagingFeatures: () => false,
    });

    expect(() => ensureOpenshellForOnboard(deps)).toThrow("exit 1");
    expect(deps.installOpenshell).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith(
      "  \u2717 openshell is missing provider credential rewrite or MCP L7 policy support.",
    );
  });

  it("applies the 0.0.101 floor during final validation when the blueprint omits a minimum", () => {
    const deps = makeDeps({
      isOpenshellInstalled: () => false,
      getInstalledOpenshellVersion: () => "0.0.81",
      getBlueprintMinOpenshellVersion: () => null,
      getBlueprintMaxOpenshellVersion: () => null,
      runCaptureOpenshell: () => "openshell 0.0.81",
    });

    expect(() => ensureOpenshellForOnboard(deps)).toThrow("exit 1");
    expect(deps.installOpenshell).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith(
      "  \u2717 openshell 0.0.81 is below the minimum required by this NemoClaw release.",
    );
    expect(deps.error).toHaveBeenCalledWith("    blueprint.yaml min_openshell_version: 0.0.101");
  });
});
