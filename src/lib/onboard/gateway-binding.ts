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
 * overwrote its runtime marker.
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

/** Resolve the gateway port encoded by a canonical NemoClaw gateway name. */
export function resolveGatewayPortFromName(gatewayName: string): number | null {
  if (gatewayName === BASE_GATEWAY_NAME) {
    return DEFAULT_GATEWAY_PORT;
  }
  const match = gatewayName.match(new RegExp(`^${BASE_GATEWAY_NAME}-(\\d+)$`));
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  return isValidPersistedGatewayPort(port) && resolveGatewayName(port) === gatewayName
    ? port
    : null;
}

/**
 * Sandbox registry shape this resolver depends on. Kept structural to avoid
 * a hard import from `state/registry` (which would pull in the whole
 * registry module just to read two optional fields).
 */
export interface SandboxGatewayBinding {
  gatewayName?: string | null;
  gatewayPort?: number | null;
}

/**
 * Recognises a NemoClaw-namespaced gateway name. The persisted form is either
 * the bare `nemoclaw` or the per-port `nemoclaw-<port>` derivation — anything
 * outside that namespace must not be trusted, since
 * `resolveSandboxGatewayName` drives gateway select/info/recover/remove/
 * destroy and Docker volume targeting from the value.
 */
const VALID_GATEWAY_NAME_RE =
  /^nemoclaw(-(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?$/;

function isValidPersistedGatewayName(value: string): boolean {
  if (!VALID_GATEWAY_NAME_RE.test(value)) return false;
  // The regex permits `nemoclaw-<default-port>` but that form is not the
  // canonical name for the default port (the bare `BASE_GATEWAY_NAME` is).
  // Reject it so a persisted `nemoclaw-8080` cannot drive lifecycle commands
  // against a gateway name that does not actually exist in the registry.
  return resolveGatewayPortFromName(value) !== null;
}

function isValidPersistedGatewayPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Resolve the OpenShell gateway name a given sandbox should be addressed by.
 * Sandbox-scoped lifecycle commands (`connect`, `destroy`, `doctor`,
 * `snapshot`, gateway-state probes) must call this rather than hardcoding
 * the bare `nemoclaw` literal — a sandbox onboarded with a non-default
 * `NEMOCLAW_GATEWAY_PORT` is registered against `nemoclaw-<port>`, and any
 * command that talks to the literal default gateway operates on the wrong
 * gateway and fails with `sandbox has no spec`.
 *
 * Resolution order:
 *   1. If `gatewayPort` is valid, derive the canonical gateway name from the
 *      port. When a persisted `gatewayName` is also present it must match that
 *      derivation; otherwise the port wins so tampered registry state cannot
 *      redirect destructive operations to a different valid NemoClaw gateway.
 *   2. A name-only legacy entry may use a persisted `gatewayName`, validated
 *      against the NemoClaw namespace (`nemoclaw` or `nemoclaw-<port>`).
 *   3. The bare `BASE_GATEWAY_NAME` for older entries that pre-date the
 *      per-port migration entirely (neither field present).
 *
 * Fail closed when either field is present but invalid. Silently falling
 * back to the default gateway would let a corrupted or tampered registry
 * row redirect destroy/snapshot/cleanup to the wrong (or default) gateway.
 */
export function resolveSandboxGatewayName(
  sandbox: SandboxGatewayBinding | null | undefined,
): string {
  if (
    typeof sandbox?.gatewayPort === "number" &&
    isValidPersistedGatewayPort(sandbox.gatewayPort)
  ) {
    return resolveGatewayName(sandbox.gatewayPort);
  }
  if (
    sandbox?.gatewayName &&
    typeof sandbox.gatewayName === "string" &&
    isValidPersistedGatewayName(sandbox.gatewayName)
  ) {
    return sandbox.gatewayName;
  }
  const portPresent = sandbox?.gatewayPort !== undefined && sandbox?.gatewayPort !== null;
  const namePresent = sandbox?.gatewayName !== undefined && sandbox?.gatewayName !== null;
  if (!portPresent && !namePresent) {
    return BASE_GATEWAY_NAME;
  }
  const detail: string[] = [];
  if (portPresent) detail.push(`gatewayPort=${JSON.stringify(sandbox?.gatewayPort)}`);
  if (namePresent) detail.push(`gatewayName=${JSON.stringify(sandbox?.gatewayName)}`);
  throw new Error(`Invalid persisted sandbox gateway binding (${detail.join(", ")})`);
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
 * name so a non-default NEMOCLAW_GATEWAY_PORT (gateway `nemoclaw-<port>`) is
 * recognized as its own gateway rather than matched against the `nemoclaw`
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
