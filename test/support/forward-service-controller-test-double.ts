// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

type TestAuthority = {
  gatewayName: string;
  sandboxIdentityFingerprint: string;
  sandboxName: string;
};

type TestEndpoint = {
  localHost: "127.0.0.1" | "0.0.0.0";
  localPort: number;
  targetPort?: number;
};

type ActiveForward = {
  authority: TestAuthority;
  endpoint: TestEndpoint;
};

function activeKey(authority: TestAuthority, endpoint: TestEndpoint): string {
  return `${authority.gatewayName}:${authority.sandboxName}:${authority.sandboxIdentityFingerprint}:${endpoint.localHost}:${String(endpoint.localPort)}`;
}

function defaultAuthority(sandboxName: string): TestAuthority {
  return {
    gatewayName: "nemoclaw",
    sandboxIdentityFingerprint: "a".repeat(64),
    sandboxName,
  };
}

/** Stateful direct ForwardTcp owner for recovery/integration fixtures. */
export function createForwardServiceControllerTestDouble() {
  const active = new Map<string, ActiveForward>();
  const failingPorts = new Set<number>();
  const inspectImpl = (authority: TestAuthority, endpoint: TestEndpoint) => {
    const exact = active.get(activeKey(authority, endpoint));
    if (exact) {
      return { disposition: "owned" as const, ownsListener: true, reachable: true, receipt: exact };
    }
    const conflicting = [...active.values()].find(
      ({ endpoint: candidate }) => candidate.localPort === endpoint.localPort,
    );
    return conflicting
      ? {
          disposition: "foreign" as const,
          ownsListener: false,
          reachable: true,
          receipt: {
            ...conflicting.authority,
            localHost: conflicting.endpoint.localHost,
            localPort: conflicting.endpoint.localPort,
          },
        }
      : {
          disposition: "absent" as const,
          ownsListener: false,
          reachable: false,
          receipt: null,
        };
  };
  const ensureImpl = (authority: TestAuthority, endpoint: TestEndpoint) => {
    if (failingPorts.has(endpoint.localPort)) {
      throw new Error(`simulated ForwardTcp failure on ${String(endpoint.localPort)}`);
    }
    active.set(activeKey(authority, endpoint), { authority, endpoint });
    return { action: "started" as const, receipt: {} };
  };
  const stopImpl = (authority: TestAuthority, endpoint: TestEndpoint) =>
    active.delete(activeKey(authority, endpoint)) ? ("stopped" as const) : ("absent" as const);
  const stopPortImpl = (authority: TestAuthority, localPort: number) => {
    let stopped = false;
    for (const [candidateKey, candidate] of active) {
      if (
        candidate.authority.gatewayName === authority.gatewayName &&
        candidate.authority.sandboxName === authority.sandboxName &&
        candidate.authority.sandboxIdentityFingerprint === authority.sandboxIdentityFingerprint &&
        candidate.endpoint.localPort === localPort
      ) {
        active.delete(candidateKey);
        stopped = true;
      }
    }
    return stopped ? ("stopped" as const) : ("absent" as const);
  };
  const controller = {
    ensure: vi.fn(ensureImpl),
    inspect: vi.fn(inspectImpl),
    stop: vi.fn(stopImpl),
    stopAll: vi.fn(() => 0),
    stopPort: vi.fn(stopPortImpl),
  };
  return {
    controller,
    reset: () => {
      active.clear();
      failingPorts.clear();
      controller.ensure.mockReset().mockImplementation(ensureImpl);
      controller.inspect.mockReset().mockImplementation(inspectImpl);
      controller.stop.mockReset().mockImplementation(stopImpl);
      controller.stopAll.mockReset().mockReturnValue(0);
      controller.stopPort.mockReset().mockImplementation(stopPortImpl);
    },
    seed: (sandboxName: string, localHost: "127.0.0.1" | "0.0.0.0", localPort: number) => {
      const authority = defaultAuthority(sandboxName);
      const endpoint = { localHost, localPort, targetPort: localPort };
      active.set(activeKey(authority, endpoint), { authority, endpoint });
    },
    failPort: (localPort: number) => failingPorts.add(localPort),
    start: ensureImpl,
  };
}

export const forwardServiceControllerTestDouble = createForwardServiceControllerTestDouble();
