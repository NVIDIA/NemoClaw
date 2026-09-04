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

  it("probes the package gateway with the selected OpenShell env (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    vi.stubEnv("OPENSHELL_DISABLE_TLS", "1");
    vi.stubEnv("OPENSHELL_DISABLE_GATEWAY_AUTH", "1");
    const selectedEnv: NodeJS.ProcessEnv = {
      HOME: "/home/tester",
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "nemoclaw",
      OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
      OPENSHELL_WORKSPACE: "default",
    };
    let observedEnv: NodeJS.ProcessEnv | undefined;

    try {
      const verdict = checkUpstreamGatewayVersion(PACKAGE_BINARY, {
        env: selectedEnv,
        getUpstreamGatewayVersionBounds: () => BOUNDS,
        platform: "linux",
        spawnSyncImpl: (_command, _args, options) => {
          observedEnv = options?.env;
          return { status: 0, stdout: "openshell-gateway 0.0.85" };
        },
      });

      expect(verdict.supported).toBe(true);
      expect(observedEnv).toEqual(selectedEnv);
      expect(observedEnv?.OPENSHELL_GATEWAY).toBe("nemoclaw");
      expect(observedEnv?.OPENSHELL_WORKSPACE).toBe("default");
      expect(observedEnv?.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
      expect(observedEnv?.OPENSHELL_TOKEN).toBeUndefined();
      expect(observedEnv?.OPENSHELL_DISABLE_TLS).toBeUndefined();
      expect(observedEnv?.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("declines the package gateway when its version cannot be determined (#8926)", () => {
    const verdict = checkUpstreamGatewayVersion(
      PACKAGE_BINARY,
      resolveOptions("ignored", { getUpstreamGatewayVersion: () => null }),
    );

    expect(verdict).toMatchObject({
      binaryPath: PACKAGE_BINARY,
      supported: false,
      version: null,
    });
  });

  it("declines when the effective package gateway binary cannot be resolved (#8926)", () => {
    const verdict = checkUpstreamGatewayVersion(null, resolveOptions("0.0.91"));

    expect(verdict).toMatchObject({
      binaryPath: "<unresolved>",
      supported: false,
      version: null,
    });
  });

  it("blocks a package unit whose gateway is out of window (#8926)", () => {
    const warn = vi.fn();

    expect(() => hasOpenShellGatewayUserService(resolveOptions("0.0.91", { warn }))).toThrow(
      "outside the maximum 0.0.85",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("0.0.91"));
  });

  it("keeps reporting a package unit whose gateway is in window", () => {
    expect(hasOpenShellGatewayUserService(resolveOptions("0.0.85"))).toBe(true);
  });

  it("blocks the NemoClaw-managed fallback when the package gateway is rejected (#8926)", () => {
    const home = "/home/tester";
    const nemoclawUnit = getNemoclawOpenShellGatewayUserServicePath(home, {});

    expect(() =>
      hasOpenShellGatewayUserService(
        resolveOptions("0.0.91", {
          home,
          env: {},
          existsSync: (p: string) => packageOnly(p) || p === nemoclawUnit,
          lstatSync: (() => ({ isSymbolicLink: () => false })) as never,
          readFileSync: () => NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
        }),
      ),
    ).toThrow("outside the maximum 0.0.85");
  });

  it("blocks the NemoClaw-managed fallback when the package service identity is untrusted (#8926)", () => {
    const home = "/home/tester";
    const nemoclawUnit = getNemoclawOpenShellGatewayUserServicePath(home, {});
    const getUpstreamGatewayVersion = vi.fn(() => "0.0.85");

    expect(() =>
      hasOpenShellGatewayUserService(
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
      ),
    ).toThrow("trusted OpenShell gateway");
    expect(getUpstreamGatewayVersion).not.toHaveBeenCalled();
  });

  it("warns once even when the resolver runs repeatedly", () => {
    const warn = vi.fn();
    const options = resolveOptions("0.0.91", { warn });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => hasOpenShellGatewayUserService(options)).toThrow("outside the maximum 0.0.85");
    }

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("lets observation-only callers decline the package unit without consuming the warning", () => {
    const suppressedWarn = vi.fn();
    const laterWarn = vi.fn();

    expect(() =>
      hasOpenShellGatewayUserService(
        resolveOptions("0.0.91", {
          suppressUnsupportedVersionWarning: true,
          warn: suppressedWarn,
        }),
      ),
    ).toThrow();
    expect(suppressedWarn).not.toHaveBeenCalled();

    expect(() =>
      hasOpenShellGatewayUserService(resolveOptions("0.0.91", { warn: laterWarn })),
    ).toThrow();
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

    expect(() =>
      hasOpenShellGatewayUserService(
        resolveOptions("ignored", {
          existsSync: (p: string) =>
            getOpenShellGatewayUserServicePaths().includes(p) ||
            getOpenShellGatewayUserServiceBinaryPaths().includes(p),
          getUpstreamGatewayVersion,
          spawnSyncImpl: () => ({ status: 0, stdout: trustedShowOutput(PACKAGE_BINARY) }),
        }),
      ),
    ).toThrow("outside the maximum 0.0.85");
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
      attempted: true,
      reason: expect.stringContaining("0.0.91"),
      serviceName: "openshell-gateway",
      standaloneFallbackBlocked: true,
      started: false,
    });
    expect(getUpstreamGatewayVersion).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("0.0.91"));
    expect(events.some((event) => /^(stop|enable|restart)/.test(event))).toBe(false);
  });
});
