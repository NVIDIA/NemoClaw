// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../../core/ports";

export { DEFAULT_GATEWAY_PORT, GATEWAY_PORT };

/** Gateway registration name used for the default gateway port. */
export const BASE_GATEWAY_NAME = "nemoclaw";
/** Docker-driver gateway state directory leaf name for the default port. */
export const BASE_GATEWAY_STATE_DIR_NAME = "openshell-docker-gateway";
/** Docker-driver gateway compatibility container name for the default port. */
export const BASE_GATEWAY_COMPAT_CONTAINER_NAME = "nemoclaw-openshell-gateway";

export function isDefaultGatewayPort(port: number): boolean {
  return port === DEFAULT_GATEWAY_PORT;
}

export function resolveGatewayName(port: number): string {
  return isDefaultGatewayPort(port) ? BASE_GATEWAY_NAME : `${BASE_GATEWAY_NAME}-${port}`;
}

export function resolveGatewayStateDirName(port: number): string {
  return isDefaultGatewayPort(port)
    ? BASE_GATEWAY_STATE_DIR_NAME
    : `${BASE_GATEWAY_STATE_DIR_NAME}-${port}`;
}

export function resolveGatewayCompatContainerName(port: number): string {
  return isDefaultGatewayPort(port)
    ? BASE_GATEWAY_COMPAT_CONTAINER_NAME
    : `${BASE_GATEWAY_COMPAT_CONTAINER_NAME}-${port}`;
}
