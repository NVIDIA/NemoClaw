// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type GatewayRecoveryDeps,
  startGatewayForRecovery,
} from "../../../dist/lib/onboard/gateway-recovery";

function createDeps(overrides: Partial<GatewayRecoveryDeps> = {}): GatewayRecoveryDeps {
  return {
    getGatewayClusterContainerState: () => "missing",
    getGatewayStartEnv: () => ({ OPENSHELL_DRIVERS: "docker" }),
    runCaptureOpenshell: vi.fn(() => "Disconnected"),
    runOpenshell: vi.fn(() => ({ status: 0 })),
    startGatewayWithOptions: vi.fn(
      async () => undefined,
    ) as GatewayRecoveryDeps["startGatewayWithOptions"],
    // Tests assert the plain-CLI fallback path by default; the Linux
    // Docker-driver branch is opted into explicitly per case.
    isLinuxDockerDriverGatewayEnabled: () => false,
    ...overrides,
  };
}

describe("gateway recovery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.OPENSHELL_GATEWAY;
  });

  it("uses the default gateway starter when no explicit target is supplied", async () => {
    const deps = createDeps();

    await startGatewayForRecovery({}, deps);

    expect(deps.startGatewayWithOptions).toHaveBeenCalledWith(undefined, {
      exitOnFailure: false,
    });
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("starts and selects the named gateway using the port encoded in its name", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "1");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-8090" }, deps)).rejects.toThrow(
      "Gateway 'nemoclaw-8090' failed to start",
    );

    expect(deps.startGatewayWithOptions).not.toHaveBeenCalled();
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["gateway", "start", "--name", "nemoclaw-8090", "--port", "8090"],
      {
        ignoreError: true,
        env: {
          OPENSHELL_DRIVERS: "docker",
          OPENSHELL_SERVER_PORT: "8090",
          OPENSHELL_SSH_GATEWAY_PORT: "8090",
        },
        suppressOutput: true,
      },
    );
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(2, ["gateway", "select", "nemoclaw-8090"], {
      ignoreError: true,
    });
  });

  it("derives the canonical gateway name when only a non-default port is supplied", async () => {
    vi.stubEnv("NEMOCLAW_HEALTH_POLL_COUNT", "1");
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayPort: 8091 }, deps)).rejects.toThrow(
      "Gateway 'nemoclaw-8091' failed to start",
    );

    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["gateway", "start", "--name", "nemoclaw-8091", "--port", "8091"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENSHELL_SERVER_PORT: "8091",
          OPENSHELL_SSH_GATEWAY_PORT: "8091",
        }),
      }),
    );
  });

  it("rejects non-canonical gateway recovery names before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "other-gateway" }, deps)).rejects.toThrow(
      "Invalid NemoClaw gateway name 'other-gateway'",
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects a gateway name and port mismatch before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(
      startGatewayForRecovery({ gatewayName: "nemoclaw-8090", gatewayPort: 8091 }, deps),
    ).rejects.toThrow("Gateway 'nemoclaw-8090' does not match port 8091");

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects privileged recovery ports before invoking OpenShell", async () => {
    const deps = createDeps();

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-80" }, deps)).rejects.toThrow(
      "Invalid gateway recovery port 80",
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed on cross-port recovery when the Linux Docker-driver gateway is enabled", async () => {
    const deps = createDeps({ isLinuxDockerDriverGatewayEnabled: () => true });

    await expect(startGatewayForRecovery({ gatewayName: "nemoclaw-8090" }, deps)).rejects.toThrow(
      /Cross-port recovery for Linux Docker-driver gateway 'nemoclaw-8090' is not safe/,
    );

    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(deps.startGatewayWithOptions).not.toHaveBeenCalled();
  });
});
