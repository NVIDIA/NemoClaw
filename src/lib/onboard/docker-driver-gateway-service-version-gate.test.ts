// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkUpstreamGatewayVersion,
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellGatewayUserServicePaths,
  hasOpenShellGatewayUserService,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
  resetUpstreamGatewayVersionWarning,
} from "./docker-driver-gateway-service";

const PACKAGE_UNIT = "/usr/lib/systemd/user/openshell-gateway.service";
const PACKAGE_BINARY = "/usr/bin/openshell-gateway";
const BOUNDS = { min: "0.0.85", max: "0.0.85" };

/** Only the package-managed unit and binary exist on this host. */
function packageOnly(filePath: string): boolean {
  return filePath === PACKAGE_UNIT || filePath === PACKAGE_BINARY;
}

function resolveOptions(version: string, overrides: Record<string, unknown> = {}) {
  return {
    platform: "linux" as const,
    existsSync: packageOnly,
    getUpstreamGatewayVersion: () => version,
    getUpstreamGatewayVersionBounds: () => BOUNDS,
    warn: vi.fn(),
    ...overrides,
  };
}

describe("package-managed gateway version gate (#8094)", () => {
  beforeEach(() => resetUpstreamGatewayVersionWarning());

  it("declines a package gateway newer than the blueprint maximum", () => {
    expect(checkUpstreamGatewayVersion(resolveOptions("0.0.91"))).toMatchObject({
      supported: false,
      version: "0.0.91",
      binaryPath: PACKAGE_BINARY,
      message: expect.stringContaining("maximum 0.0.85"),
    });
  });

  it("declines a package gateway older than the blueprint minimum", () => {
    expect(checkUpstreamGatewayVersion(resolveOptions("0.0.71"))).toMatchObject({
      supported: false,
      message: expect.stringContaining("minimum 0.0.85"),
    });
  });

  it("adopts a package gateway inside the supported window", () => {
    expect(checkUpstreamGatewayVersion(resolveOptions("0.0.85")).supported).toBe(true);
  });

  it("adopts the package gateway when its version cannot be determined", () => {
    // Pre-#8094 behaviour: only decline on positive evidence of a bad version,
    // so an unreadable binary never turns a working host into a failing one.
    const verdict = checkUpstreamGatewayVersion(
      resolveOptions("ignored", { getUpstreamGatewayVersion: () => null }),
    );

    expect(verdict.supported).toBe(true);
  });

  it("adopts when no package gateway binary is installed", () => {
    const verdict = checkUpstreamGatewayVersion(
      resolveOptions("0.0.91", { existsSync: (p: string) => p === PACKAGE_UNIT }),
    );

    expect(verdict.supported).toBe(true);
  });

  it("stops reporting a package unit whose gateway is out of window", () => {
    const warn = vi.fn();

    // The unit file is present, so the pre-fix resolver adopted it outright.
    expect(hasOpenShellGatewayUserService(resolveOptions("0.0.91", { warn }))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("0.0.91"));
  });

  it("keeps reporting a package unit whose gateway is in window", () => {
    expect(hasOpenShellGatewayUserService(resolveOptions("0.0.85"))).toBe(true);
  });

  it("falls back to the NemoClaw-managed unit when the package gateway is rejected", () => {
    const home = "/home/tester";
    const nemoclawUnit = getNemoclawOpenShellGatewayUserServicePath(home, {});

    const resolved = hasOpenShellGatewayUserService(
      resolveOptions("0.0.91", {
        home,
        env: {},
        existsSync: (p: string) => packageOnly(p) || p === nemoclawUnit,
        lstatSync: (() => ({ isSymbolicLink: () => false })) as never,
        readFileSync: () => NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
      }),
    );

    expect(resolved).toBe(true);
  });

  it("warns once even when the resolver runs repeatedly", () => {
    const warn = vi.fn();
    const options = resolveOptions("0.0.91", { warn });

    hasOpenShellGatewayUserService(options);
    hasOpenShellGatewayUserService(options);
    hasOpenShellGatewayUserService(options);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("probes every documented package binary location", () => {
    // `/usr/local/bin` installs must be gated the same way as `/usr/bin` ones.
    expect(
      checkUpstreamGatewayVersion(
        resolveOptions("0.0.91", {
          existsSync: (p: string) => p === PACKAGE_UNIT || p === "/usr/local/bin/openshell-gateway",
        }),
      ),
    ).toMatchObject({ supported: false, binaryPath: "/usr/local/bin/openshell-gateway" });
  });

  it("keeps the package unit paths the gate scans in sync with the resolver", () => {
    expect(getOpenShellGatewayUserServicePaths()).toContain(PACKAGE_UNIT);
  });
});
