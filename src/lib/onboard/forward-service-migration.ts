// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  requireForwardServiceAuthority,
  retireLegacySandboxForwards,
  type ForwardServiceAuthorityMigration,
} from "../adapters/openshell/forward-service-migration";
import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import * as registry from "../state/registry";
import {
  compareAndSetForwardServiceMigrationComplete,
  compareAndSetLegacySandboxLifecycleAuthority,
} from "../state/registry/lifecycle-generation";
import type { SandboxEntry } from "../state/registry/types";
import { observeSandboxOnGateway } from "./sandbox-recreate-probe";

export function resolveForwardServiceGatewayName(sandbox: SandboxEntry): string {
  const port = sandbox.gatewayPort;
  if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535) {
    return port === DEFAULT_GATEWAY_PORT ? "nemoclaw" : `nemoclaw-${String(port)}`;
  }
  return typeof sandbox.gatewayName === "string" && sandbox.gatewayName.length > 0
    ? sandbox.gatewayName
    : "nemoclaw";
}

function resolveForwardServiceGatewayPort(sandbox: SandboxEntry): number {
  return typeof sandbox.gatewayPort === "number" &&
    Number.isInteger(sandbox.gatewayPort) &&
    sandbox.gatewayPort >= 1 &&
    sandbox.gatewayPort <= 65_535
    ? sandbox.gatewayPort
    : DEFAULT_GATEWAY_PORT;
}

export function requireProductionForwardServiceAuthority(
  sandboxName: string,
  options: {
    observe?: typeof observeSandboxOnGateway;
  } = {},
): ForwardServiceAuthorityMigration {
  return requireForwardServiceAuthority(sandboxName, {
    compareAndSet: compareAndSetLegacySandboxLifecycleAuthority,
    completeMigration: compareAndSetForwardServiceMigrationComplete,
    getSandbox: registry.getSandbox,
    observe: options.observe ?? observeSandboxOnGateway,
    resolveGatewayName: resolveForwardServiceGatewayName,
    resolveGatewayPort: resolveForwardServiceGatewayPort,
  });
}

export function retireProductionLegacySandboxForwards(
  migration: ForwardServiceAuthorityMigration,
  options: Parameters<typeof retireLegacySandboxForwards>[1],
): number {
  return retireLegacySandboxForwards(migration, options);
}
