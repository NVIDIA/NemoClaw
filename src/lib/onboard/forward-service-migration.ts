// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  retireLegacySandboxForwards,
  type LegacyForwardMigrationDeps,
} from "../adapters/openshell/forward-service-migration";
import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import type { SandboxEntry } from "../state/registry/types";

export function resolveForwardServiceGatewayName(
  sandbox: Pick<SandboxEntry, "gatewayName" | "gatewayPort"> | null | undefined,
): string {
  const port = sandbox?.gatewayPort;
  if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535) {
    return port === DEFAULT_GATEWAY_PORT ? "nemoclaw" : `nemoclaw-${String(port)}`;
  }
  return typeof sandbox?.gatewayName === "string" && sandbox.gatewayName.length > 0
    ? sandbox.gatewayName
    : "nemoclaw";
}

export function retireProductionLegacySandboxForwards(
  sandboxName: string,
  gatewayName: string,
  ports: readonly number[],
  options: LegacyForwardMigrationDeps,
): number {
  return retireLegacySandboxForwards(gatewayName, sandboxName, ports, options);
}
