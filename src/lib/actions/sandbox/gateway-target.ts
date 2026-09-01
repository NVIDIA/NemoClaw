// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "../../core/ports";
import {
  resolveGatewayName,
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
  type SandboxGatewayBinding,
} from "../../onboard/gateway-binding";
import * as registry from "../../state/registry";

export function getKnownSandboxTarget(sandboxName: string): registry.SandboxEntry | null {
  return registry.getSandbox(sandboxName);
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
