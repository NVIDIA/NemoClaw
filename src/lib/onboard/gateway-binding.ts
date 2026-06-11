// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-instance / per-gateway-port binding resolver.
 *
 * Historically NemoClaw treated the OpenShell gateway as a process-global
 * singleton named `nemoclaw`, with a single Docker-driver state directory and
 * a single compatibility container. A second onboard that requested a
 * different `NEMOCLAW_GATEWAY_PORT` therefore reused the same named gateway,
 * the same runtime-marker state dir, and the same compat container — so
 * creating the second sandbox recreated/killed the first sandbox's gateway and
 * overwrote its runtime marker (#4422).
 *
 * These pure resolvers derive a stable per-binding identity along two
 * independent axes:
 *
 * 1. **Gateway port** — the original `nemoclaw-<port>` suffix introduced for
 *    `NEMOCLAW_GATEWAY_PORT` (#4422). The default port keeps the bare
 *    `nemoclaw` name verbatim for backward compatibility.
 * 2. **NemoClaw instance** — the `NEMOCLAW_INSTANCE` identity that scopes the
 *    entire host-side install (state root, gateway name, lifecycle). The
 *    default instance keeps the bare `nemoclaw` name verbatim; any other
 *    instance is prefixed (`nemoclaw-<instance>` / `nemoclaw-<instance>-<port>`)
 *    so two instances never collide even on the default port.
 *
 * Both axes default to the singleton tree so existing single-instance,
 * default-port deployments observe no name change.
 */

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { isDefaultInstance, NEMOCLAW_INSTANCE } from "../core/instance";
import type { GatewayReuseState } from "../state/gateway";

/** Gateway registration name used for the default instance and default port. */
export const BASE_GATEWAY_NAME = "nemoclaw";
/** Docker-driver gateway state directory leaf name for the default binding. */
export const BASE_GATEWAY_STATE_DIR_NAME = "openshell-docker-gateway";
/** Docker-driver gateway compatibility container name for the default binding. */
export const BASE_GATEWAY_COMPAT_CONTAINER_NAME = "nemoclaw-openshell-gateway";

function isDefaultGatewayPort(port: number): boolean {
  return port === DEFAULT_GATEWAY_PORT;
}

function bindingSuffix(port: number, instance: string): string {
  const parts: string[] = [];
  if (!isDefaultInstance(instance)) parts.push(instance);
  if (!isDefaultGatewayPort(port)) parts.push(String(port));
  return parts.length === 0 ? "" : `-${parts.join("-")}`;
}

/**
 * Resolve the OpenShell gateway registration name for a gateway port + active
 * instance. The default instance on the default port keeps the bare `nemoclaw`
 * name for backward compatibility; any other combination gets an
 * `<instance>` / `<port>` suffix so its lifecycle commands
 * (add/select/remove/start/destroy) never target another instance's gateway.
 */
export function resolveGatewayName(port: number, instance: string = NEMOCLAW_INSTANCE): string {
  return `${BASE_GATEWAY_NAME}${bindingSuffix(port, instance)}`;
}

/**
 * Resolve the Docker-driver gateway state directory leaf name for a gateway
 * port + active instance. The state dir holds the gateway pid file and runtime
 * marker, so a per-binding leaf keeps each sandbox's marker isolated — a
 * second onboard cannot overwrite the first sandbox's marker or clobber its
 * pid file.
 */
export function resolveGatewayStateDirName(
  port: number,
  instance: string = NEMOCLAW_INSTANCE,
): string {
  return `${BASE_GATEWAY_STATE_DIR_NAME}${bindingSuffix(port, instance)}`;
}

/**
 * Resolve the Docker-driver gateway compatibility container name for a
 * gateway port + active instance. A per-binding container name prevents the
 * second onboard's `docker run --name ...` (and the pre-launch `docker rm`)
 * from tearing down the first sandbox's compat gateway container.
 */
export function resolveGatewayCompatContainerName(
  port: number,
  instance: string = NEMOCLAW_INSTANCE,
): string {
  return `${BASE_GATEWAY_COMPAT_CONTAINER_NAME}${bindingSuffix(port, instance)}`;
}

/** Gateway state classifiers from `state/gateway`, each bound to a gateway name. */
export interface GatewayNameBoundClassifiers {
  hasStaleGateway(gwInfoOutput?: string): boolean;
  isSelectedGateway(statusOutput?: string): boolean;
  isGatewayHealthy(
    statusOutput?: string,
    gwInfoOutput?: string,
    activeGatewayInfoOutput?: string,
  ): boolean;
  getGatewayReuseState(
    statusOutput?: string,
    gwInfoOutput?: string,
    activeGatewayInfoOutput?: string,
  ): GatewayReuseState;
}

/**
 * Bind the gateway-name-aware health/reuse classifiers to a resolved gateway
 * name so a non-default NEMOCLAW_GATEWAY_PORT or NEMOCLAW_INSTANCE is
 * recognised as its own gateway rather than matched against the `nemoclaw`
 * singleton. Kept out of onboard.ts to avoid growing that file.
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
