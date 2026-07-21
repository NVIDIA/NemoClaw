// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
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

  it("applies the 0.0.85 floor during final validation when the blueprint omits a minimum", () => {
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
    expect(deps.error).toHaveBeenCalledWith("    blueprint.yaml min_openshell_version: 0.0.85");
  });
});
