// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type McpLifecycleLockOptions, withMcpLifecycleLock } from "../state/mcp-lifecycle-lock";

const GATEWAY_ROUTE_LOCK_PREFIX = "gateway-route:";

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
