// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-gateway-port binding resolver.
 *
 * Historically NemoClaw treated the OpenShell gateway as a process-global
 * singleton named `nemoclaw`, with a single Docker-driver state directory and
 * a single compatibility container. A second onboard that requested a
 * different `NEMOCLAW_GATEWAY_PORT` therefore reused the same named gateway,
 * the same runtime-marker state dir, and the same compat container — so
 * creating the second sandbox recreated/killed the first sandbox's gateway and
 * overwrote its runtime marker (#4422).
 *
 * These pure resolvers derive a stable per-port binding. The default port
 * keeps the original `nemoclaw` names verbatim so existing single-sandbox
 * deployments and on-disk state are untouched; any non-default port gets a
 * `-<port>` suffixed name/dir/container so two sandboxes on distinct gateway
 * ports never collide.
 */

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import type { GatewayReuseState } from "../state/gateway";

/** Gateway registration name used for the default gateway port. */
export const BASE_GATEWAY_NAME = "nemoclaw";
/** Docker-driver gateway state directory leaf name for the default port. */
export const BASE_GATEWAY_STATE_DIR_NAME = "openshell-docker-gateway";
/** Docker-driver gateway compatibility container name for the default port. */
export const BASE_GATEWAY_COMPAT_CONTAINER_NAME = "nemoclaw-openshell-gateway";

function isDefaultGatewayPort(port: number): boolean {
  return port === DEFAULT_GATEWAY_PORT;
}

/**
 * Resolve the OpenShell gateway registration name for a gateway port. The
 * default port keeps the bare `nemoclaw` name for backward compatibility; any
 * other port gets a `nemoclaw-<port>` name so its lifecycle commands
 * (add/select/remove/start/destroy) never target another sandbox's gateway.
 */
export function resolveGatewayName(port: number): string {
  return isDefaultGatewayPort(port) ? BASE_GATEWAY_NAME : `${BASE_GATEWAY_NAME}-${port}`;
}

/**
 * Resolve the Docker-driver gateway state directory leaf name for a gateway
 * port. The state dir holds the gateway pid file and runtime marker, so a
 * per-port leaf keeps each sandbox's marker isolated — a second onboard cannot
 * overwrite the first sandbox's marker or clobber its pid file.
 */
export function resolveGatewayStateDirName(port: number): string {
  return isDefaultGatewayPort(port)
    ? BASE_GATEWAY_STATE_DIR_NAME
    : `${BASE_GATEWAY_STATE_DIR_NAME}-${port}`;
}

/**
 * Resolve the Docker-driver gateway compatibility container name for a gateway
 * port. A per-port container name prevents the second onboard's
 * `docker run --name ...` (and the pre-launch `docker rm`) from tearing down
 * the first sandbox's compat gateway container.
 */
export function resolveGatewayCompatContainerName(port: number): string {
  return isDefaultGatewayPort(port)
    ? BASE_GATEWAY_COMPAT_CONTAINER_NAME
    : `${BASE_GATEWAY_COMPAT_CONTAINER_NAME}-${port}`;
}

/** Gateway state classifiers from `state/gateway`, each bound to a gateway name. */
export interface GatewayNameBoundClassifiers {
  hasStaleGateway(gwInfoOutput?: string): boolean;
  isSelectedGateway(statusOutput?: string): boolean;
  isGatewayHealthy(statusOutput?: string, gwInfoOutput?: string, activeGatewayInfoOutput?: string): boolean;
  getGatewayReuseState(
    statusOutput?: string,
    gwInfoOutput?: string,
    activeGatewayInfoOutput?: string,
  ): GatewayReuseState;
}

/**
 * Bind the gateway-name-aware health/reuse classifiers to a resolved gateway
 * name so a non-default NEMOCLAW_GATEWAY_PORT (gateway `nemoclaw-<port>`) is
 * recognized as its own gateway rather than matched against the `nemoclaw`
 * singleton (#4422). Kept out of onboard.ts to avoid growing that file.
 */
export function createGatewayNameBoundClassifiers(
  state: typeof import("../state/gateway"),
  gatewayName: string,
): GatewayNameBoundClassifiers {
  return {
    hasStaleGateway: (gwInfoOutput = "") => state.hasStaleGateway(gwInfoOutput, gatewayName),
    isSelectedGateway: (statusOutput = "") => state.isSelectedGateway(statusOutput, gatewayName),
    isGatewayHealthy: (statusOutput = "", gwInfoOutput = "", activeGatewayInfoOutput = "") =>
      state.isGatewayHealthy(statusOutput, gwInfoOutput, activeGatewayInfoOutput, gatewayName),
    getGatewayReuseState: (statusOutput = "", gwInfoOutput = "", activeGatewayInfoOutput = "") =>
      state.getGatewayReuseState(statusOutput, gwInfoOutput, activeGatewayInfoOutput, gatewayName),
  };
}
