// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/docker", () => ({
  dockerInspect: vi.fn(),
}));

import * as docker from "../adapters/docker";
import type { GatewayReuseState } from "../state/gateway";
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
});
