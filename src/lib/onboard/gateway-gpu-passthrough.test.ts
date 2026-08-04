// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/docker", () => ({
  dockerInspect: vi.fn(),
}));

vi.mock("../state/registry", () => ({
  listSandboxes: vi.fn(() => ({ sandboxes: [], defaultSandbox: null })),
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

  it("omits the legacy gateway destroy verb from the unreadable-registry hint (#8139)", () => {
    const runReconcile = (supportsLifecycleCommands: boolean): string[] => {
      const errors: string[] = [];
      vi.mocked(docker.dockerInspect).mockReturnValue({
        pid: 0,
        output: [null, "[]", ""],
        stdout: "[]",
        stderr: "",
        status: 0,
        signal: null,
      });
      vi.mocked(registry.listSandboxes).mockImplementation(() => {
        throw new Error("registry unreadable");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
        errors.push(String(message));
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);

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
            supportsLifecycleCommands,
          }),
        ).toThrow(/exit 1/);
      } finally {
        errorSpy.mockRestore();
        exitSpy.mockRestore();
        // Explicitly restore the shared module mocks for later tests in this file.
        vi.mocked(registry.listSandboxes).mockReturnValue({ sandboxes: [], defaultSandbox: null });
        vi.mocked(docker.dockerInspect).mockReset();
      }
      return errors;
    };

    const modern = runReconcile(false).join("\n");
    expect(modern).toContain("openshell gateway remove nemoclaw");
    expect(modern).not.toContain("gateway destroy");

    const legacy = runReconcile(true).join("\n");
    expect(legacy).toContain("openshell gateway remove nemoclaw");
    expect(legacy).toContain("openshell gateway destroy -g nemoclaw");
  });
});
