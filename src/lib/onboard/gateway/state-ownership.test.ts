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

  it("uses a self-delimiting ps environment fallback", () => {
    const ownership = makeOwnership({
      readProcessEnvironment: () => null,
      runCapture: () =>
        `openshell-gateway NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE=${gatewayIdForStateDir(STATE_DIR)} OPENSHELL_DB_URL=sqlite:${path.join(STATE_DIR, "openshell.db")} OTHER=value`,
    });

    expect(ownership.isDockerDriverGatewayPidUsingSelectedState(4242)).toBe(true);
  });

  it("fails closed when ps cannot delimit a selected database path containing whitespace", () => {
    const stateDir = "/home/nvidia/NemoClaw gateways/8080";
    const ownership = makeOwnership({
      getDockerDriverGatewayStateDir: () => stateDir,
      readProcessEnvironment: () => null,
      runCapture: () =>
        `openshell-gateway OPENSHELL_DB_URL=sqlite:${path.join(stateDir, "openshell.db")} OTHER=value`,
    });

    expect(ownership.isDockerDriverGatewayPidUsingSelectedState(4242)).toBe(false);
  });

  it("fails closed when the process scan times out", () => {
    const ownership = makeOwnership({
      runCaptureEx: () => ({ stdout: "", exitCode: null, timedOut: true }),
    });

    expect(ownership.isDockerDriverGatewayStateInUse()).toBe(true);
  });

  it("fails closed when the process scan throws", () => {
    const ownership = makeOwnership({
      runCaptureEx: () => {
        throw new Error("process scan failed");
      },
    });

    expect(ownership.isDockerDriverGatewayStateInUse()).toBe(true);
  });

  it.each([
    {
      label: "legacy default namespace with the exact database path",
      processEnv: {
        NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: "default",
        OPENSHELL_DB_URL: `sqlite:${path.join(STATE_DIR, "openshell.db")}`,
      } as Record<string, string>,
      expected: true,
    },
    {
      label: "current selected namespace",
      processEnv: {
        NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: gatewayIdForStateDir(STATE_DIR),
      } as Record<string, string>,
      expected: true,
    },
  ])("detects selected-state ownership for $label", ({ processEnv, expected }) => {
    const ownership = makeOwnership({
      readProcessEnvironment: () => processEnv,
      runCaptureEx: () => ({ stdout: "4242\n", exitCode: 0, timedOut: false }),
    });

    expect(ownership.isDockerDriverGatewayStateInUse()).toBe(expected);
  });

  it("classifies current and legacy selected-state owners from one process scan", () => {
    const scan = vi.fn(() => ({ stdout: "4242\n4343\n", exitCode: 0, timedOut: false }));
    const ownership = makeOwnership({
      readProcessEnvironment: (pid): Record<string, string> =>
        pid === 4242
          ? { NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: gatewayIdForStateDir(STATE_DIR) }
          : {
              NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: "default",
              OPENSHELL_DB_URL: `sqlite:${path.join(STATE_DIR, "openshell.db")}`,
            },
      runCaptureEx: scan,
    });

    expect(ownership.isDockerDriverGatewayStateInUse()).toBe(true);
    expect(scan).toHaveBeenCalledOnce();
  });

  it("proves selected state is unused after a complete empty process scan", () => {
    expect(makeOwnership().isDockerDriverGatewayStateInUse()).toBe(false);
  });
});
