// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { gatewayIdForStateDir } from "../docker-driver-gateway-config";
import {
  createDockerDriverGatewayStateOwnership,
  processEnvironmentUsesSelectedGatewayState,
} from "./state-ownership";

const STATE_DIR = "/home/nvidia/.nemoclaw/gateways/8080";

function makeOwnership(
  overrides: Partial<Parameters<typeof createDockerDriverGatewayStateOwnership>[0]> = {},
) {
  return createDockerDriverGatewayStateOwnership({
    getDockerDriverGatewayStateDir: () => STATE_DIR,
    isDockerDriverGatewayProcess: () => true,
    isPidAlive: () => true,
    readProcessEnvironment: () => ({
      NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: gatewayIdForStateDir(STATE_DIR),
    }),
    resolveOpenShellGatewayBinary: () => "/opt/openshell/openshell-gateway",
    runCapture: () => "",
    runCaptureEx: () => ({ stdout: "", exitCode: 1, timedOut: false }),
    ...overrides,
  });
}

describe("docker-driver gateway selected-state ownership", () => {
  it("matches the scoped namespace and rejects a conflicting database", () => {
    const namespace = gatewayIdForStateDir(STATE_DIR);

    expect(
      processEnvironmentUsesSelectedGatewayState(
        { NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: namespace },
        STATE_DIR,
      ),
    ).toBe(true);
    expect(
      processEnvironmentUsesSelectedGatewayState(
        {
          NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: namespace,
          OPENSHELL_DB_URL: "sqlite:/another/gateway/openshell.db",
        },
        STATE_DIR,
      ),
    ).toBe(false);
  });

  it("matches legacy default state only through its exact database path", () => {
    expect(
      processEnvironmentUsesSelectedGatewayState(
        {
          NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: "default",
          OPENSHELL_DB_URL: `sqlite:${path.join(STATE_DIR, "openshell.db")}`,
        },
        STATE_DIR,
      ),
    ).toBe(true);
    expect(
      processEnvironmentUsesSelectedGatewayState(
        { NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: "default" },
        STATE_DIR,
      ),
    ).toBe(false);
  });

  it("proves one live service PID uses the selected state", () => {
    const ownership = makeOwnership();

    expect(ownership.isDockerDriverGatewayPidUsingSelectedState(4242)).toBe(true);
  });

  it("fails closed when the ps fallback cannot preserve whitespace in the selected state", () => {
    const stateDir = "/home/nvidia/NemoClaw gateway/8080";
    const runCapture = vi.fn(
      () =>
        `openshell-gateway NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE=${gatewayIdForStateDir(stateDir)} OPENSHELL_DB_URL=sqlite:${path.join(stateDir, "openshell.db")}`,
    );
    const ownership = makeOwnership({
      getDockerDriverGatewayStateDir: () => stateDir,
      readProcessEnvironment: () => null,
      runCapture,
      runCaptureEx: () => ({ stdout: "4242\n", exitCode: 0, timedOut: false }),
    });

    expect(ownership.isDockerDriverGatewayPidUsingSelectedState(4242)).toBe(false);
    expect(ownership.isDockerDriverGatewayStateInUse()).toBe(true);
    expect(runCapture).not.toHaveBeenCalled();
  });

  it("retains the all-process guard for a legacy gateway replacement", () => {
    const readProcessEnvironment = vi.fn(() => ({
      NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: "default",
      OPENSHELL_DB_URL: `sqlite:${path.join(STATE_DIR, "openshell.db")}`,
    }));
    const ownership = makeOwnership({
      readProcessEnvironment,
      runCaptureEx: () => ({ stdout: "4242\n", exitCode: 0, timedOut: false }),
    });

    expect(ownership.isDockerDriverGatewayStateInUse()).toBe(true);
    expect(readProcessEnvironment).toHaveBeenCalledWith(4242);
  });

  it("fails closed when the independent replacement scan is incomplete", () => {
    const ownership = makeOwnership({
      runCaptureEx: () => ({ stdout: "", exitCode: null, timedOut: true }),
    });

    expect(ownership.isDockerDriverGatewayStateInUse()).toBe(true);
  });

  it("proves the selected state is unused after a complete empty process scan", () => {
    expect(makeOwnership().isDockerDriverGatewayStateInUse()).toBe(false);
  });
});
