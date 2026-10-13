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

/** Resolve the gateway identity recorded by a registry row, rejecting ambiguity. */
export function registryEntryGatewayPort(entry: SandboxGatewayBinding & { name: string }): number {
  const stateError = (message: string): Error =>
    new Error(`Cannot safely inspect NemoClaw gateway state: ${message}`);
  const hasPort = entry.gatewayPort !== undefined && entry.gatewayPort !== null;
  const hasName = entry.gatewayName !== undefined && entry.gatewayName !== null;
  const port = entry.gatewayPort;
  const name = entry.gatewayName;

  if (
    hasPort &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw stateError(`sandbox ${JSON.stringify(entry.name)} has an invalid gatewayPort`);
  }
  if (hasName && typeof name !== "string") {
    throw stateError(`sandbox ${JSON.stringify(entry.name)} has an invalid gatewayName`);
  }

  const portFromName = typeof name === "string" ? resolveGatewayPortFromName(name) : null;
  if (hasName && portFromName === null) {
    throw stateError(`sandbox ${JSON.stringify(entry.name)} has an unrecognized gatewayName`);
  }
  if (typeof port === "number") {
    if (typeof name === "string" && resolveGatewayName(port) !== name) {
      throw stateError(`sandbox ${JSON.stringify(entry.name)} has conflicting gateway identity`);
    }
    return port;
  }
  if (portFromName !== null) return portFromName;
  return DEFAULT_GATEWAY_PORT;
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
