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
import {
  findSandboxAcrossGatewayRoots,
  listPublishedSandboxesAcrossGatewayRoots,
} from "../../state/registry/cross-port";

export function getKnownSandboxTarget(sandboxName: string): registry.SandboxEntry | null {
  return findSandboxAcrossGatewayRoots(sandboxName)?.entry ?? null;
}

/**
 * Persisted sandbox rows for endpoint lookup. Without a sandbox name, only the
 * selected registry root is read. With a sandbox name, rows from every gateway
 * root are returned, because the sandbox resolves through its owning root even
 * when NEMOCLAW_GATEWAY_PORT is unset or selects a different root (#12403).
 */
export function listPersistedSandboxTargets(sandboxName?: string): registry.SandboxEntry[] {
  // The config reader throws ConfigCorruptError / ConfigPermissionError, which
  // inference get reports as registry-corrupt / registry-unreadable. The
  // cross-port reader throws plain errors, so the selected root is read first.
  const selected = registry.listSandboxes().sandboxes;
  if (!sandboxName) return selected;
  return listPublishedSandboxesAcrossGatewayRoots();
}

export function getDefaultSandboxTargetName(): string | null {
  return registry.getDefault();
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
