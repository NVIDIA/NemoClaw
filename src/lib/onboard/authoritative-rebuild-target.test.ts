// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AuthoritativeRebuildTargetDeps,
  preflightAuthoritativeRebuildTarget,
  resolveAuthoritativeOnboardGatewayBinding,
} from "./authoritative-rebuild-target";

const target = {
  sandboxName: "alpha",
  provider: "nvidia-prod",
  model: "nvidia/nemotron",
  targetGatewayName: "nemoclaw-12345",
  controlUiPort: 18789,
  authoritativeResourceProfile: { cpu: "4", memory: "8Gi" },
};
const originalGateway = process.env.OPENSHELL_GATEWAY;

function deps(overrides: Partial<AuthoritativeRebuildTargetDeps> = {}) {
  return {
    runFatalRuntimePreflight: vi.fn(),
    ensureOpenshell: vi.fn(),
    preflightResourceProfile: vi.fn(),
    prepareGatewayTransport: vi.fn(),
    inferenceRouteReady: vi.fn(() => true),
    captureForwardList: vi.fn(() => "alpha 127.0.0.1 18789 42 active"),
    checkPort: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } satisfies AuthoritativeRebuildTargetDeps;
}

function restoreEnv(name: string, value: string | undefined): void {
  Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, value === undefined ? {} : { [name]: value });
}

afterEach(() => {
  restoreEnv("OPENSHELL_GATEWAY", originalGateway);
  vi.restoreAllMocks();
});

describe("authoritative rebuild gateway binding", () => {
  const resolve = resolveAuthoritativeOnboardGatewayBinding;

  it("accepts only a paired canonical gateway name and port", () => {
    expect(
      resolve({
        authoritativeResumeConfig: true,
        targetGatewayName: " nemoclaw-8081 ",
        targetGatewayPort: 8081,
      }),
    ).toEqual({ name: "nemoclaw-8081", port: 8081 });
    expect(resolve({})).toBeNull();
  });

  it.each([
    { authoritativeResumeConfig: true, targetGatewayName: "nemoclaw-8081" },
    { authoritativeResumeConfig: true, targetGatewayPort: 8081 },
    { targetGatewayName: "nemoclaw-8081", targetGatewayPort: 8081 },
  ])("rejects partial or non-authoritative target options", (options) => {
    expect(() => resolve(options)).toThrow(/only together for an authoritative rebuild resume/);
  });

  it("rejects a non-canonical name or invalid target port", () => {
    expect(() =>
      resolve({
        authoritativeResumeConfig: true,
        targetGatewayName: "nemoclaw-9090",
        targetGatewayPort: 8081,
      }),
    ).toThrow(/does not match port 8081/);
    for (const port of [0, 65536, 8081.5]) {
      expect(() =>
        resolve({
          authoritativeResumeConfig: true,
          targetGatewayName: "nemoclaw-8081",
          targetGatewayPort: port,
        }),
      ).toThrow(/Invalid authoritative rebuild gateway port/);
    }
  });

  it("requires a complete authoritative target when the outer lifecycle owns the lock", () => {
    expect(() => resolve({ onboardLockAlreadyHeld: true })).toThrow(
      /lock handoff requires an authoritative rebuild resume/,
    );
  });
});

describe("authoritative rebuild target preflight", () => {
  it("pins the requested gateway for the exact provider/model route, then restores it", async () => {
    process.env.OPENSHELL_GATEWAY = "before";
    const routeReady = vi.fn((_provider: string, _model: string) => {
      expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-12345");
      return true;
    });
    const dependencies = deps({ inferenceRouteReady: routeReady });
    await preflightAuthoritativeRebuildTarget(target, dependencies);

    expect(routeReady).toHaveBeenCalledWith("nvidia-prod", "nvidia/nemotron");
    expect(dependencies.preflightResourceProfile).toHaveBeenCalledWith({
      cpu: "4",
      memory: "8Gi",
    });
    expect(process.env.OPENSHELL_GATEWAY).toBe("before");
  });

  it("keeps legacy no-profile rebuilds on OpenShell defaults", async () => {
    const dependencies = deps();

    await preflightAuthoritativeRebuildTarget(
      { ...target, authoritativeResourceProfile: null },
      dependencies,
    );

    expect(dependencies.preflightResourceProfile).toHaveBeenCalledWith(null);
  });

  it("rejects an unusable persisted resource profile before gateway and route checks", async () => {
    const prepareGatewayTransport = vi.fn();
    const inferenceRouteReady = vi.fn(() => true);

    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({
          preflightResourceProfile: vi.fn(() => {
            throw new Error("OpenShell lacks required resource flags");
          }),
          prepareGatewayTransport,
          inferenceRouteReady,
        }),
      ),
    ).rejects.toThrow("OpenShell lacks required resource flags");

    expect(prepareGatewayTransport).not.toHaveBeenCalled();
    expect(inferenceRouteReady).not.toHaveBeenCalled();
  });

  it("never probes the gateway listener as a dashboard for dcode (#6195)", async () => {
    const captureForwardList = vi.fn(() => "");
    const checkPort = vi.fn(async () => ({
      ok: false,
      process: "openshell",
      pid: 8080,
      reason: "EADDRINUSE",
    }));

    await preflightAuthoritativeRebuildTarget(
      { ...target, controlUiPort: null },
      deps({ captureForwardList, checkPort }),
    );

    expect(captureForwardList).not.toHaveBeenCalled();
    expect(checkPort).not.toHaveBeenCalled();
  });

  it("rejects an exact provider/model route mismatch", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ inferenceRouteReady: vi.fn(() => false) }),
      ),
    ).rejects.toThrow("inference route does not match");
  });

  it("rejects a target gateway transport or mTLS preflight failure before route checks", async () => {
    const inferenceRouteReady = vi.fn(() => true);
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({
          prepareGatewayTransport: vi.fn(async () => {
            throw new Error("target mTLS bundle is invalid");
          }),
          inferenceRouteReady,
        }),
      ),
    ).rejects.toThrow("target mTLS bundle is invalid");
    expect(inferenceRouteReady).not.toHaveBeenCalled();
  });

  it("rejects a dashboard forward owned by another sandbox", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ captureForwardList: vi.fn(() => "beta 127.0.0.1 18789 42 active") }),
      ),
    ).rejects.toThrow("belongs to sandbox 'beta'");
  });

  it("preflights the separately forwarded Hermes dashboard port", async () => {
    const captureForwardList = vi.fn(() => "beta 127.0.0.1 9119 42 active");

    await expect(
      preflightAuthoritativeRebuildTarget(
        { ...target, authoritativeHermesDashboardConfig: { port: 9119 } },
        deps({ captureForwardList }),
      ),
    ).rejects.toThrow("Hermes dashboard port 9119 belongs to sandbox 'beta'");
  });

  it("rejects an occupied dashboard port with no OpenShell owner", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({
          captureForwardList: vi.fn(() => ""),
          checkPort: vi.fn(async () => ({ ok: false, process: "node", pid: 99, reason: "" })),
        }),
      ),
    ).rejects.toThrow("occupied by node (PID 99)");
  });

  it("restores gateway scope when a fatal runtime check throws", async () => {
    process.env.OPENSHELL_GATEWAY = "before";
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({
          runFatalRuntimePreflight: vi.fn(() => {
            throw new Error("fatal runtime gate");
          }),
        }),
      ),
    ).rejects.toThrow("fatal runtime gate");
    expect(process.env.OPENSHELL_GATEWAY).toBe("before");
  });
});
