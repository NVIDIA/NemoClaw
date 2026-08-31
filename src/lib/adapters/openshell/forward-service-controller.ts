// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ensureForwardServiceProcess,
  inspectForwardServiceProcess,
  stopForwardServiceProcess,
  type ForwardServiceInspection,
} from "./forward-service-process";
import type { ForwardServiceTarget } from "./forward-service";
import {
  listForwardServicePendingReceipts,
  listForwardServiceReceipts,
} from "./forward-service-state";

export interface ForwardServiceSandboxAuthority {
  readonly gatewayName: string;
  readonly sandboxIdentityFingerprint: string;
  readonly sandboxName: string;
}

export interface ForwardServiceEndpoint {
  readonly localHost: "127.0.0.1" | "0.0.0.0";
  readonly localPort: number;
  readonly targetPort?: number;
}

export interface ForwardServiceController {
  inspect(
    authority: ForwardServiceSandboxAuthority,
    endpoint: ForwardServiceEndpoint,
  ): ForwardServiceInspection;
  ensure(
    authority: ForwardServiceSandboxAuthority,
    endpoint: ForwardServiceEndpoint,
  ): ReturnType<typeof ensureForwardServiceProcess>;
  stop(
    authority: ForwardServiceSandboxAuthority,
    endpoint: ForwardServiceEndpoint,
  ): ReturnType<typeof stopForwardServiceProcess>;
  stopPort(authority: ForwardServiceSandboxAuthority, localPort: number): "absent" | "stopped";
  stopAll(authority: ForwardServiceSandboxAuthority): number;
}

export interface ForwardServiceControllerDeps {
  readonly executable: () => string;
  readonly stateDirectory: string;
  readonly runExclusive: <T>(sandboxName: string, operation: () => T) => T;
}

function target(
  deps: ForwardServiceControllerDeps,
  authority: ForwardServiceSandboxAuthority,
  endpoint: ForwardServiceEndpoint,
): ForwardServiceTarget {
  return {
    executable: deps.executable(),
    gatewayName: authority.gatewayName,
    workspace: "default",
    sandboxName: authority.sandboxName,
    sandboxIdentityFingerprint: authority.sandboxIdentityFingerprint,
    localHost: endpoint.localHost,
    localPort: endpoint.localPort,
    targetHost: "127.0.0.1",
    targetPort: endpoint.targetPort ?? endpoint.localPort,
  };
}

function matchesAuthority(
  receipt: Pick<ForwardServiceTarget, "gatewayName" | "sandboxIdentityFingerprint" | "sandboxName">,
  authority: ForwardServiceSandboxAuthority,
): boolean {
  return (
    receipt.sandboxName === authority.sandboxName &&
    receipt.gatewayName === authority.gatewayName &&
    receipt.sandboxIdentityFingerprint === authority.sandboxIdentityFingerprint
  );
}

/** Bind the receipt-owned ForwardTcp process primitive to one lifecycle lock owner. */
export function createForwardServiceController(
  deps: ForwardServiceControllerDeps,
): ForwardServiceController {
  const options = (sandboxName: string) => ({
    stateDirectory: deps.stateDirectory,
    runExclusive: <T>(operation: () => T): T => deps.runExclusive(sandboxName, operation),
  });
  return {
    inspect: (authority, endpoint) => {
      const forwardTarget = target(deps, authority, endpoint);
      return inspectForwardServiceProcess(forwardTarget, options(authority.sandboxName));
    },
    ensure: (authority, endpoint) => {
      const forwardTarget = target(deps, authority, endpoint);
      return ensureForwardServiceProcess(forwardTarget, options(authority.sandboxName));
    },
    stop: (authority, endpoint) => {
      const forwardTarget = target(deps, authority, endpoint);
      return stopForwardServiceProcess(forwardTarget, options(authority.sandboxName));
    },
    stopPort: (authority, localPort) =>
      deps.runExclusive(authority.sandboxName, () => {
        const receipts = listForwardServiceReceipts({ stateDirectory: deps.stateDirectory }).filter(
          (receipt) =>
            receipt.sandboxName === authority.sandboxName && receipt.localPort === localPort,
        );
        const pending = listForwardServicePendingReceipts({
          stateDirectory: deps.stateDirectory,
        }).filter(
          (receipt) =>
            receipt.sandboxName === authority.sandboxName && receipt.localPort === localPort,
        );
        if (receipts.length === 0 && pending.length === 0) return "absent";
        if (
          receipts.length > 1 ||
          pending.length > 1 ||
          [...receipts, ...pending].some((receipt) => !matchesAuthority(receipt, authority))
        ) {
          throw new Error("OpenShell forward service state disagrees with sandbox authority");
        }
        for (const receipt of pending.length > 0 ? pending : receipts) {
          stopForwardServiceProcess(receipt, {
            stateDirectory: deps.stateDirectory,
            runExclusive: (operation) => operation(),
          });
        }
        return "stopped";
      }),
    stopAll: (authority) =>
      deps.runExclusive(authority.sandboxName, () => {
        const receipts = listForwardServiceReceipts({ stateDirectory: deps.stateDirectory }).filter(
          (receipt) => receipt.sandboxName === authority.sandboxName,
        );
        const pending = listForwardServicePendingReceipts({
          stateDirectory: deps.stateDirectory,
        }).filter((receipt) => receipt.sandboxName === authority.sandboxName);
        if ([...receipts, ...pending].some((receipt) => !matchesAuthority(receipt, authority))) {
          throw new Error("OpenShell forward service state disagrees with sandbox authority");
        }
        const lifecycleTargets = [
          ...pending,
          ...receipts.filter(
            (receipt) => !pending.some((candidate) => candidate.localPort === receipt.localPort),
          ),
        ];
        for (const receipt of lifecycleTargets) {
          stopForwardServiceProcess(receipt, {
            stateDirectory: deps.stateDirectory,
            runExclusive: (operation) => operation(),
          });
        }
        return lifecycleTargets.length;
      }),
  };
}
