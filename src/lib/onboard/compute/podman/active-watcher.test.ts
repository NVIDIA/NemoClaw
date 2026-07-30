// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { TrustedActiveOpenShellGatewayUserServiceIdentity } from "../../docker-driver-gateway-service";
import { createActivePodmanWatcherController } from "./active-watcher";

function serviceReceipt(
  pid: number,
  processStartIdentity: string,
  invocationId: string,
): TrustedActiveOpenShellGatewayUserServiceIdentity {
  return {
    execStart:
      "{ path=/usr/bin/openshell-gateway ; argv[]=/usr/bin/openshell-gateway --port 8080 ; }",
    execStartPath: "/usr/bin/openshell-gateway",
    invocationId,
    manager: "systemd",
    pid,
    processArgv: ["/usr/bin/openshell-gateway", "--port", "8080"],
    processStartIdentity,
    serviceName: "openshell-gateway",
    unitPath: "/usr/lib/systemd/user/openshell-gateway.service",
  } as unknown as TrustedActiveOpenShellGatewayUserServiceIdentity;
}

function baseInput() {
  return {
    desiredEnv: { OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock" },
    driftGatewayBin: "/usr/bin/openshell-gateway",
    driverLabel: "Podman",
    gatewayBin: "/usr/bin/openshell-gateway",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    getRememberedGatewayPid: vi.fn(() => null),
    getRuntimeDrift: vi.fn(() => null),
    isGatewayHealthy: vi.fn(() => true),
    isPidAlive: vi.fn(() => false),
    launch: {
      args: [],
      command: "/usr/bin/openshell-gateway",
      env: {},
      mode: "host" as const,
      processGatewayBin: "/usr/bin/openshell-gateway",
    },
    rememberGatewayPid: vi.fn(),
    stateDir: "/tmp/nemoclaw-podman-test",
  };
}

describe("active Podman watcher composition", () => {
  it("uses the exact active package service and never invokes standalone lifecycle", () => {
    let active = true;
    let receipt = serviceReceipt(41, "linux-proc-start:100", "1".repeat(32));
    let listeners = [41];
    const stopService = vi.fn(() => {
      active = false;
      listeners = [];
    });
    const resumeService = vi.fn(() => {
      active = true;
      receipt = serviceReceipt(42, "linux-proc-start:200", "2".repeat(32));
      listeners = [42];
      return receipt;
    });
    const stopHostGateways = vi.fn(() => ({
      failed: [],
      skippedDeadPids: [],
      skippedNonMatchingPids: [],
      stopped: [],
      sudoRemediationPids: [],
    }));
    const spawnGateway = vi.fn(() => ({ pid: 91, unref: vi.fn() }));
    const input = baseInput();
    const controller = createActivePodmanWatcherController({
      ...input,
      deps: {
        assertServiceInactive: vi.fn(() => {
          if (active) throw new Error("service is active");
        }),
        captureService: vi.fn(() => (active ? receipt : null)),
        hasService: vi.fn(() => true),
        openGatewayLog: vi.fn(() => 9),
        resumeService,
        spawnGateway,
        stopHostGateways,
        stopService,
        watcher: {
          captureListenerPids: () => listeners,
          captureProcessStartIdentity: (pid) =>
            active && pid === receipt.pid ? receipt.processStartIdentity : null,
        },
      },
      readiness: { now: () => 0, sleep: vi.fn() },
    });

    const lease = controller.quiesceAndProve();
    lease.assertStillStopped();
    lease.resumeAndProve();

    expect(stopService).toHaveBeenCalledOnce();
    expect(resumeService).toHaveBeenCalledOnce();
    expect(stopHostGateways).not.toHaveBeenCalled();
    expect(spawnGateway).not.toHaveBeenCalled();
    expect(input.getRuntimeDrift).toHaveBeenCalledWith(
      41,
      input.desiredEnv,
      input.driftGatewayBin,
      41,
    );
  });

  it("uses the standalone launch when an installed service is proven inactive", () => {
    let listener = 51;
    let rememberedPid = 51;
    let startIdentity: string | null = "linux-proc-start:300";
    const stopHostGateways = vi.fn(() => {
      listener = 0;
      startIdentity = null;
      return {
        failed: [],
        skippedDeadPids: [],
        skippedNonMatchingPids: [],
        stopped: [51],
        sudoRemediationPids: [],
      };
    });
    const spawnGateway = vi.fn(() => {
      listener = 52;
      startIdentity = "linux-proc-start:400";
      return { pid: 52, unref: vi.fn() };
    });
    const input = {
      ...baseInput(),
      getRememberedGatewayPid: vi.fn(() => rememberedPid),
      rememberGatewayPid: vi.fn((pid: number) => {
        rememberedPid = pid;
      }),
    };
    const captureService = vi.fn(() => null);
    const controller = createActivePodmanWatcherController({
      ...input,
      deps: {
        captureService,
        hasService: vi.fn(() => true),
        openGatewayLog: vi.fn(() => 9),
        spawnGateway,
        stopHostGateways,
        watcher: {
          captureListenerPids: () => (listener > 0 ? [listener] : []),
          captureProcessStartIdentity: (pid) => (pid === listener ? startIdentity : null),
        },
      },
      readiness: { now: () => 0, sleep: vi.fn() },
    });

    const lease = controller.quiesceAndProve();
    lease.resumeAndProve();

    expect(stopHostGateways).toHaveBeenCalledOnce();
    expect(captureService).toHaveBeenCalledOnce();
    expect(spawnGateway).toHaveBeenCalledOnce();
    expect(input.rememberGatewayPid).toHaveBeenCalledWith(52);
    expect(input.getRuntimeDrift).toHaveBeenCalledWith(
      51,
      input.desiredEnv,
      input.driftGatewayBin,
      null,
    );
  });
});
