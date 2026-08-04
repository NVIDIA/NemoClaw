// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../adapters/docker", () => ({
  dockerInspect: vi.fn(),
}));

vi.mock("../state/registry", () => ({
  listSandboxes: vi.fn(),
}));

import * as docker from "../adapters/docker";
import type { GatewayReuseState } from "../state/gateway";
import * as registry from "../state/registry";
import {
  canRestartCpuOnlyGatewayForGpuIntent,
  decideGatewayGpuReuseForGpuIntent,
  inspectLegacyGatewayGpuPassthroughResult,
  reconcileGatewayGpuReuseForGpuIntent,
  shouldInspectLegacyGatewayGpuPassthrough,
} from "./gateway-gpu-passthrough";

describe("gateway GPU passthrough inspection", () => {
  const healthy: GatewayReuseState = "healthy";
  const missing: GatewayReuseState = "missing";

  // `restoreMocks` restores vi.spyOn descriptors but leaves implementations set
  // on module mocks, so drop them here to keep this file order-independent.
  afterEach(() => {
    vi.mocked(docker.dockerInspect).mockReset();
    vi.mocked(registry.listSandboxes).mockReset();
  });

  it("only inspects reusable legacy gateway containers", () => {
    expect(shouldInspectLegacyGatewayGpuPassthrough(healthy, true, false)).toBe(true);
    expect(shouldInspectLegacyGatewayGpuPassthrough(healthy, true, true)).toBe(false);
    expect(shouldInspectLegacyGatewayGpuPassthrough(missing, true, false)).toBe(false);
    expect(shouldInspectLegacyGatewayGpuPassthrough(healthy, false, false)).toBe(false);
  });

  it("parses legacy Docker DeviceRequests inspection conservatively", () => {
    expect(inspectLegacyGatewayGpuPassthroughResult(0, "null\n")).toBe("cpu-only");
    expect(inspectLegacyGatewayGpuPassthroughResult(0, "[]")).toBe("cpu-only");
    expect(inspectLegacyGatewayGpuPassthroughResult(0, '[{"Driver":"nvidia"}]')).toBe(
      "gpu-enabled",
    );
    expect(inspectLegacyGatewayGpuPassthroughResult(1, "", "No such object: x")).toBe("not-found");
    expect(inspectLegacyGatewayGpuPassthroughResult(1, "")).toBe("unknown");
    expect(inspectLegacyGatewayGpuPassthroughResult(0, "")).toBe("unknown");
  });

  it("reuses when GPU is not requested or the gateway is already Docker-driver/current", () => {
    expect(
      decideGatewayGpuReuseForGpuIntent({
        gatewayReuseState: healthy,
        gpuPassthrough: false,
        confirmedDockerDriverGateway: false,
        legacyGatewayGpuInspection: "cpu-only",
        cpuOnlyGatewayRestartSafe: true,
      }),
    ).toBe("reuse");

    expect(
      decideGatewayGpuReuseForGpuIntent({
        gatewayReuseState: healthy,
        gpuPassthrough: true,
        confirmedDockerDriverGateway: true,
        legacyGatewayGpuInspection: "cpu-only",
        cpuOnlyGatewayRestartSafe: true,
      }),
    ).toBe("reuse");
  });

  it("reuses legacy gateways that already expose GPU passthrough", () => {
    expect(
      decideGatewayGpuReuseForGpuIntent({
        gatewayReuseState: healthy,
        gpuPassthrough: true,
        confirmedDockerDriverGateway: false,
        legacyGatewayGpuInspection: "gpu-enabled",
        cpuOnlyGatewayRestartSafe: false,
      }),
    ).toBe("reuse");

    expect(
      decideGatewayGpuReuseForGpuIntent({
        gatewayReuseState: healthy,
        gpuPassthrough: true,
        confirmedDockerDriverGateway: false,
        legacyGatewayGpuInspection: "not-found",
        cpuOnlyGatewayRestartSafe: true,
      }),
    ).toBe("reuse");
  });

  it("restarts CPU-only legacy gateways only when the caller has proved it is safe", () => {
    expect(
      decideGatewayGpuReuseForGpuIntent({
        gatewayReuseState: healthy,
        gpuPassthrough: true,
        confirmedDockerDriverGateway: false,
        legacyGatewayGpuInspection: "cpu-only",
        cpuOnlyGatewayRestartSafe: true,
      }),
    ).toBe("restart-gateway");

    expect(
      decideGatewayGpuReuseForGpuIntent({
        gatewayReuseState: healthy,
        gpuPassthrough: true,
        confirmedDockerDriverGateway: false,
        legacyGatewayGpuInspection: "cpu-only",
        cpuOnlyGatewayRestartSafe: false,
      }),
    ).toBe("abort-with-recovery");
  });

  it("keeps unknown legacy gateway GPU state non-destructive", () => {
    expect(
      decideGatewayGpuReuseForGpuIntent({
        gatewayReuseState: healthy,
        gpuPassthrough: true,
        confirmedDockerDriverGateway: false,
        legacyGatewayGpuInspection: "unknown",
        cpuOnlyGatewayRestartSafe: true,
      }),
    ).toBe("abort-with-recovery");

    expect(
      decideGatewayGpuReuseForGpuIntent({
        gatewayReuseState: healthy,
        gpuPassthrough: true,
        confirmedDockerDriverGateway: false,
        legacyGatewayGpuInspection: "cpu-only",
        cpuOnlyGatewayRestartSafe: false,
      }),
    ).toBe("abort-with-recovery");
  });

  it("allows CPU-only gateway restart for empty registry or the one sandbox being recreated", () => {
    expect(canRestartCpuOnlyGatewayForGpuIntent([], null, false)).toBe(true);
    expect(canRestartCpuOnlyGatewayForGpuIntent(["my-assistant"], "my-assistant", true)).toBe(true);
    expect(canRestartCpuOnlyGatewayForGpuIntent(["my-assistant"], "my-assistant", false)).toBe(
      false,
    );
    expect(canRestartCpuOnlyGatewayForGpuIntent(["alpha"], "beta", true)).toBe(false);
    expect(canRestartCpuOnlyGatewayForGpuIntent(["alpha", "beta"], "alpha", true)).toBe(false);
  });

  it("does not categorically abort Jetson GPU passthrough on Docker-driver gateways", () => {
    vi.mocked(docker.dockerInspect).mockClear();
    const stopDashboardForwards = vi.fn();
    const retireLegacyGatewayForDockerDriverUpgrade = vi.fn();
    const destroyGatewayRuntimeForGpuReuse = vi.fn();

    const result = reconcileGatewayGpuReuseForGpuIntent({
      gatewayReuseState: healthy,
      gpuPassthrough: true,
      gatewayName: "nemoclaw",
      currentSandboxName: "jetson-box",
      hostGpuPlatform: "jetson",
      recreateSandbox: true,
      confirmedDockerDriverGateway: true,
      stopDashboardForwards,
      retireLegacyGatewayForDockerDriverUpgrade,
      destroyGatewayRuntimeForGpuReuse,
    });

    expect(result).toBe(healthy);
    expect(docker.dockerInspect).not.toHaveBeenCalled();
    expect(stopDashboardForwards).not.toHaveBeenCalled();
    expect(retireLegacyGatewayForDockerDriverUpgrade).not.toHaveBeenCalled();
    expect(destroyGatewayRuntimeForGpuReuse).not.toHaveBeenCalled();
  });

  // This hint had no coverage, so it kept printing the `gateway destroy` verb
  // that OpenShell removed before 0.0.44 (#8139).
  it("prints openshell gateway remove without gateway destroy when the sandbox registry is unreadable (#8139)", () => {
    // A "null" DeviceRequests value marks the gateway CPU-only. Onboard then
    // reads the sandbox registry, and this test makes that read throw.
    vi.mocked(docker.dockerInspect).mockReturnValue({
      pid: 1,
      output: [],
      stdout: "null\n",
      stderr: "",
      status: 0,
      signal: null,
    });
    vi.mocked(registry.listSandboxes).mockImplementation(() => {
      throw new Error("registry read failed");
    });
    const errors: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exit ${code}`);
      });

    try {
      expect(() =>
        reconcileGatewayGpuReuseForGpuIntent({
          gatewayReuseState: healthy,
          gpuPassthrough: true,
          gatewayName: "nemoclaw",
          currentSandboxName: null,
          recreateSandbox: false,
          confirmedDockerDriverGateway: false,
          stopDashboardForwards: vi.fn(),
          retireLegacyGatewayForDockerDriverUpgrade: vi.fn(),
          destroyGatewayRuntimeForGpuReuse: vi.fn(),
        }),
      ).toThrow("exit 1");

      expect(errors).toContain("    openshell gateway remove nemoclaw");
      expect(errors).toContain(
        "    sudo pkill -f openshell-gateway  # if a privileged host gateway process remains",
      );
      expect(errors).toContain("    nemoclaw onboard --gpu");
      expect(errors.join("\n")).not.toContain("gateway destroy");
    } finally {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
