// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "../../core/ports";
import {
  resolveGatewayName,
  resolveManagedGatewayStateDirectory,
  resolveSandboxGatewayName,
  type SandboxGatewayComputeBinding,
} from "../../onboard/gateway-binding";
import * as registry from "../../state/registry";

export function getKnownSandboxTargetGatewayName(sandboxName = ""): string | null {
  const sb = sandboxName ? registry.getSandbox(sandboxName) : null;
  return sb ? resolveSandboxGatewayName(sb) : null;
}

export function getSandboxTargetGatewayName(sandboxName = ""): string {
  return getKnownSandboxTargetGatewayName(sandboxName) ?? resolveGatewayName(GATEWAY_PORT);
}

export function getKnownSandboxOpenShellDriver(sandboxName = ""): string | null {
  return sandboxName ? (registry.getSandbox(sandboxName)?.openshellDriver?.trim() ?? null) : null;
}

export function listSandboxGatewayComputeBindings(): readonly SandboxGatewayComputeBinding[] {
  return registry.listSandboxes().sandboxes;
}

export function resolveSandboxManagedGatewayStateDirectory(
  sandbox: SandboxGatewayComputeBinding,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolveManagedGatewayStateDirectory(resolveSandboxGatewayName(sandbox), {
    env: environment,
  });
}

export function gatewayNamePattern(gatewayName: string): RegExp {
  return new RegExp(
    `Gateway:\\s+${gatewayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
    "i",
  );
}
