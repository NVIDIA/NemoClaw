// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type GatewayRecoveryDeps,
  startGatewayForRecovery,
} from "../../../dist/lib/onboard/gateway-recovery";

function createDeps(): GatewayRecoveryDeps {
  return {
    getGatewayClusterContainerState: () => "missing",
    getGatewayStartEnv: () => ({ OPENSHELL_DRIVERS: "docker" }),
    runCaptureOpenshell: vi.fn(() => "Disconnected"),
    runOpenshell: vi.fn(() => ({ status: 0 })),
    startGatewayWithOptions: vi.fn(
      async () => undefined,
    ) as GatewayRecoveryDeps["startGatewayWithOptions"],
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
});
