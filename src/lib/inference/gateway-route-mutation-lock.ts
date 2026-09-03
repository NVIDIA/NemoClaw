// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import {
  type McpLifecycleLockOptions,
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../state/mcp-lifecycle-lock";
import { resolveSharedLocalAdapterStateRoot } from "./local-adapter-lifecycle";

const GATEWAY_ROUTE_LOCK_PREFIX = "gateway-route:";
const MODEL_ROUTER_PORT_LOCK_PREFIX = "model-router-port:";

export function resolveCurrentUserModelRouterLockStateDir(homeDir: string = os.homedir()): string {
  return path.join(resolveSharedLocalAdapterStateRoot(homeDir), "state");
}

/** Resolve Model Router lock options without touching the filesystem. */
export function resolveModelRouterPortLifecycleLockOptions(
  options: McpLifecycleLockOptions = {},
  homeDir?: string,
): McpLifecycleLockOptions & { stateDir: string } {
  return {
    ...options,
    stateDir: options.stateDir ?? resolveCurrentUserModelRouterLockStateDir(homeDir),
  };
}

/**
 * Serializes host-side reads and writes of OpenShell's one-route-per-gateway
 * inference state. The non-sandbox prefix keeps this lock namespace disjoint
 * from user sandbox mutation locks while reusing their cross-process lease.
 */
export function withGatewayRouteMutationLock<T>(
  gatewayName: string,
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  const normalizedGatewayName = gatewayName.trim();
  if (!normalizedGatewayName) throw new Error("OpenShell gateway name is required.");
  return withMcpLifecycleLock(
    `${GATEWAY_ROUTE_LOCK_PREFIX}${normalizedGatewayName}`,
    operation,
    options,
  );
}

export function withGatewayRouteMutationLockSync<T>(
  gatewayName: string,
  operation: () => T,
  options: McpLifecycleLockOptions = {},
): T {
  const normalizedGatewayName = gatewayName.trim();
  if (!normalizedGatewayName) throw new Error("OpenShell gateway name is required.");
  return withMcpLifecycleLockSync(
    `${GATEWAY_ROUTE_LOCK_PREFIX}${normalizedGatewayName}`,
    operation,
    options,
  );
}

/** Serialize current-user lifecycle changes for one Model Router port across gateways. */
export function withModelRouterPortLifecycleLock<T>(
  port: number,
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Model Router port must be an integer from 1 to 65535.");
  }
  return withMcpLifecycleLock(`${MODEL_ROUTER_PORT_LOCK_PREFIX}${String(port)}`, operation, resolveModelRouterPortLifecycleLockOptions(options));
}
