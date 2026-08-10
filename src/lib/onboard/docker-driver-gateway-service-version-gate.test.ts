// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkUpstreamGatewayVersion,
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellGatewayUserServiceBinaryPaths,
  getOpenShellGatewayUserServicePaths,
  hasOpenShellGatewayUserService,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
  resetUpstreamGatewayVersionWarning,
  startOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";

const PACKAGE_UNIT = "/usr/lib/systemd/user/openshell-gateway.service";
const PACKAGE_BINARY = "/usr/bin/openshell-gateway";
const BOUNDS = { min: "0.0.85", max: "0.0.85" };

function trustedShowOutput(execPath = PACKAGE_BINARY): string {
  return [
    `FragmentPath=${PACKAGE_UNIT}`,
    `ExecStart={ path=${execPath} ; argv[]=${execPath} ; }`,
  ].join("\n");
}

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
    spawnSyncImpl: () => ({ status: 0, stdout: trustedShowOutput() }),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("package-managed gateway version gate (#8094)", () => {
  beforeEach(() => resetUpstreamGatewayVersionWarning());

  it("declines a package gateway newer than the blueprint maximum", () => {
    expect(checkUpstreamGatewayVersion(PACKAGE_BINARY, resolveOptions("0.0.91"))).toMatchObject({
      supported: false,
      version: "0.0.91",
      binaryPath: PACKAGE_BINARY,
      message: expect.stringContaining("maximum 0.0.85"),
    });
  });

  it("declines a package gateway older than the blueprint minimum", () => {
    expect(checkUpstreamGatewayVersion(PACKAGE_BINARY, resolveOptions("0.0.71"))).toMatchObject({
      supported: false,
      message: expect.stringContaining("minimum 0.0.85"),
    });
  });

  it("adopts a package gateway inside the supported window", () => {
    expect(checkUpstreamGatewayVersion(PACKAGE_BINARY, resolveOptions("0.0.85")).supported).toBe(
      true,
    );
  });

  it("adopts the package gateway when its version cannot be determined", () => {
    // Pre-#8094 behaviour: only decline on positive evidence of a bad version,
    // so an unreadable binary never turns a working host into a failing one.
    const verdict = checkUpstreamGatewayVersion(
      PACKAGE_BINARY,
      resolveOptions("ignored", { getUpstreamGatewayVersion: () => null }),
    );

    expect(verdict.supported).toBe(true);
  });

  it("adopts when the effective package gateway binary cannot be resolved", () => {
    const verdict = checkUpstreamGatewayVersion(null, resolveOptions("0.0.91"));

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

  it("falls back to the NemoClaw-managed unit when the package service identity is untrusted", () => {
    const home = "/home/tester";
    const nemoclawUnit = getNemoclawOpenShellGatewayUserServicePath(home, {});
    const getUpstreamGatewayVersion = vi.fn(() => "0.0.85");

    const resolved = hasOpenShellGatewayUserService(
      resolveOptions("ignored", {
        home,
        env: {},
        existsSync: (p: string) => packageOnly(p) || p === nemoclawUnit,
        getUpstreamGatewayVersion,
        lstatSync: (() => ({ isSymbolicLink: () => false })) as never,
        readFileSync: () => NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
        spawnSyncImpl: () => ({
          status: 0,
          stdout: trustedShowOutput("/opt/foreign/openshell-gateway"),
        }),
      }),
    );

    expect(resolved).toBe(true);
    expect(getUpstreamGatewayVersion).not.toHaveBeenCalled();
  });

  it("warns once even when the resolver runs repeatedly", () => {
    const warn = vi.fn();
    const options = resolveOptions("0.0.91", { warn });

    hasOpenShellGatewayUserService(options);
    hasOpenShellGatewayUserService(options);
    hasOpenShellGatewayUserService(options);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("lets observation-only callers decline the package unit without consuming the warning", () => {
    const suppressedWarn = vi.fn();
    const laterWarn = vi.fn();

    expect(
      hasOpenShellGatewayUserService(
        resolveOptions("0.0.91", {
          suppressUnsupportedVersionWarning: true,
          warn: suppressedWarn,
        }),
      ),
    ).toBe(false);
    expect(suppressedWarn).not.toHaveBeenCalled();

    hasOpenShellGatewayUserService(resolveOptions("0.0.91", { warn: laterWarn }));
    expect(laterWarn).toHaveBeenCalledOnce();
  });

  it("probes every documented package binary location", () => {
    const localBinary = "/usr/local/bin/openshell-gateway";
    expect(checkUpstreamGatewayVersion(localBinary, resolveOptions("0.0.91"))).toMatchObject({
      supported: false,
      binaryPath: localBinary,
    });
  });

  it("checks the effective ExecStart when both package binaries exist", () => {
    const getUpstreamGatewayVersion = vi.fn(() => "0.0.91");

    expect(
      hasOpenShellGatewayUserService(
        resolveOptions("ignored", {
          existsSync: (p: string) =>
            getOpenShellGatewayUserServicePaths().includes(p) ||
            getOpenShellGatewayUserServiceBinaryPaths().includes(p),
          getUpstreamGatewayVersion,
          spawnSyncImpl: () => ({ status: 0, stdout: trustedShowOutput(PACKAGE_BINARY) }),
        }),
      ),
    ).toBe(false);
    expect(getUpstreamGatewayVersion).toHaveBeenCalledWith(PACKAGE_BINARY);
  });

  it("preserves above-maximum development gateways on the development channel", () => {
    expect(
      checkUpstreamGatewayVersion(
        PACKAGE_BINARY,
        resolveOptions("openshell-gateway 0.0.91-dev.1", {
          env: { NEMOCLAW_OPENSHELL_CHANNEL: "dev" },
        }),
      ).supported,
    ).toBe(true);
  });

  it("keeps the package unit paths the gate scans in sync with the resolver", () => {
    expect(getOpenShellGatewayUserServicePaths()).toContain(PACKAGE_UNIT);
  });

  it("declines a package gateway that changes version before startup", () => {
    const events: string[] = [];
    const getUpstreamGatewayVersion = vi
      .fn()
      .mockReturnValueOnce("0.0.85")
      .mockReturnValue("0.0.91");
    const warn = vi.fn();

    const result = startOpenShellGatewayUserService(
      resolveOptions("ignored", {
        commandExists: () => true,
        getUpstreamGatewayVersion,
        spawnSyncImpl: (_command: string, args: string[]) => {
          events.push(args.slice(1).join(" "));
          return args.includes("show") ? { status: 0, stdout: trustedShowOutput() } : { status: 0 };
        },
        warn,
      }),
    );

    expect(result).toMatchObject({
      attempted: false,
      reason: expect.stringContaining("0.0.91"),
      serviceName: "openshell-gateway",
      started: false,
    });
    expect(getUpstreamGatewayVersion).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("0.0.91"));
    expect(events.some((event) => /^(stop|enable|restart)/.test(event))).toBe(false);
  });
});
