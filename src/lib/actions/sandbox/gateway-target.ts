// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { OPENSHELL_DEFAULT_WORKSPACE } from "../../adapters/openshell/sandbox-ssh-host";
import { GATEWAY_PORT } from "../../core/ports";
import {
  resolveGatewayName,
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
  type SandboxGatewayBinding,
} from "../../onboard/gateway-binding";
import * as registry from "../../state/registry";
import { findSandboxAcrossGatewayRoots } from "../../state/registry/cross-port";

export function getKnownSandboxTarget(sandboxName: string): registry.SandboxEntry | null {
  return findSandboxAcrossGatewayRoots(sandboxName)?.entry ?? null;
}

/** Compare one retained registry row with the current persisted target. */
export function isKnownSandboxTargetCurrent(
  sandboxName: string,
  expected: registry.SandboxEntry,
): boolean {
  const current = getKnownSandboxTarget(sandboxName);
  return current !== null && isDeepStrictEqual(current, expected);
}

export function listPersistedSandboxTargets(): registry.SandboxEntry[] {
  return registry.listSandboxes().sandboxes;
}

export function getKnownSandboxTargetGatewayName(sandboxName = ""): string | null {
  const sb = sandboxName ? getKnownSandboxTarget(sandboxName) : null;
  return sb ? resolveSandboxGatewayName(sb) : null;
}

export function getSelectedGatewayName(): string {
  return resolveGatewayName(GATEWAY_PORT);
}

export function getSandboxTargetGatewayName(sandboxName = ""): string {
  return getKnownSandboxTargetGatewayName(sandboxName) ?? getSelectedGatewayName();
}

/** Resolve a gateway directly from the already-authoritative persisted row. */
export function getPersistedSandboxTargetGatewayName(sandbox: SandboxGatewayBinding): string {
  return resolveSandboxGatewayName(sandbox);
}

/** Build an explicit OpenShell selection from one persisted registry row. */
export function getPersistedSandboxTargetRuntimeSelection(sandbox: SandboxGatewayBinding) {
  return {
    gatewayName: getPersistedSandboxTargetGatewayName(sandbox),
    workspace: OPENSHELL_DEFAULT_WORKSPACE,
  };
}

/** Resolve the complete canonical gateway binding from one persisted sandbox row. */
export function getPersistedSandboxTargetGateway(sandbox: SandboxGatewayBinding): {
  gatewayName: string;
  gatewayPort: number;
  selectedInProcess: boolean;
} {
  const gatewayName = getPersistedSandboxTargetGatewayName(sandbox);
  const gatewayPort = resolveGatewayPortFromName(gatewayName);
  if (gatewayPort === null) {
    throw new Error(`Invalid persisted OpenShell gateway '${gatewayName}'.`);
  }
  return { gatewayName, gatewayPort, selectedInProcess: gatewayPort === GATEWAY_PORT };
}

export function gatewayNamePattern(gatewayName: string): RegExp {
  return new RegExp(
    `Gateway:\\s+${gatewayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
    "i",
  );
}
