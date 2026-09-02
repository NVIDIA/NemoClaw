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

export function getSandboxTargetGatewayPort(sandboxName = ""): number {
  const gatewayName = getSandboxTargetGatewayName(sandboxName);
  const gatewayPort = resolveGatewayPortFromName(gatewayName);
  if (gatewayPort === null) throw new Error(`Invalid resolved gateway name: ${gatewayName}`);
  return gatewayPort;
}

/** Resolve a gateway directly from the already-authoritative persisted row. */
export function getPersistedSandboxTargetGatewayName(sandbox: SandboxGatewayBinding): string {
  return resolveSandboxGatewayName(sandbox);
}

export function gatewayNamePattern(gatewayName: string): RegExp {
  return new RegExp(
    `Gateway:\\s+${gatewayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
    "i",
  );
}
